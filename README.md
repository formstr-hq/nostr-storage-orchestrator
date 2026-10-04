# nostr-storage-orchestrator

A pnpm workspace for a Nostr-aware storage orchestrator. It combines a blob proxy and backend storage services with PostgreSQL persistence — accessed through an internal, thin DB-as-a-service layer (`db-api`) rather than a shared in-process client. Structured relay data is served by the mesh-PG data plane (see [docs/DECENTRALIZED_PG_PLAN.md](docs/DECENTRALIZED_PG_PLAN.md)); the orchestrator itself no longer runs a relay proxy.

## Architecture

```
Client
  │  Authorization: Nostr <base64-signed-event>
  ▼
proxy/blossom  ──► db-api (HTTP, internal-only) ──► PostgreSQL
  │
  └──► active blossom backends (DB roster, refreshed every 15s)

Mesh-PG clients (nostream, psql)
  │  postgres wire protocol
  ▼
pg-gateway ──► providers' pg-agent (HTTP over NVPN mesh)

Storage Control (Android/Linux)
  │  NIP-98 HTTP auth
  ▼
control-plane-backend ──► db-api + NVPN CLI/shared sidecar state
```

`db-api` is a thin data layer: it performs CRUD reads/writes and keeps two-table writes atomic (e.g. creating a blob and bumping a user's `usedStorage` in one transaction), but it holds **no business logic**. Quota enforcement, duplicate-handling, and ownership checks all live in the proxies, exactly as before — only the Prisma calls moved behind HTTP. `db-api` is never exposed publicly (compose-internal network only) and has no auth layer.

## Components

### `packages/db` (`@orchestrator/db-api`)

- Prisma schema, migrations, and generated client — the only service that touches Postgres directly
- Express HTTP server exposing CRUD for `User`, `Blob`, `Member`, and `Storage`, plus `GET /plans`
- No quota checks, no auth — see [`proxy/blossom` API](#proxyblossom-api) for where those decisions actually happen

### `packages/db-client` (`@orchestrator/db-client`)

- Zero-runtime-dependency `fetch`-based client + shared TypeScript types for `db-api`
- Used by both proxies instead of linking Prisma directly, which is what made Docker builds for the proxies fragile before

### `proxy/blossom`

TypeScript/Express service that:

- validates Nostr auth events from `Authorization: Nostr ...` (BUD-11) and NIP-98 for admin routes
- resolves `npub` from the signed event
- derives the account lifecycle (UNPAID → ACTIVE → GRACE → WRITE_BLOCKED → READ_BLOCKED → CLOSED) from entitlement dates at request time; the notifier's `User.status` is only a mirror
- enforces the plan's total storage allowance and duration only (no free tier, no per-file plan limits); a global operator `MAX_UPLOAD_BYTES` caps a single request
- selects a single provider deterministically by `fnv1a(npub:timeSlot) % n` over the npub-sorted active roster, rotating the slot (default hourly)
- on upload failure, drops the failed provider and recomputes the selection over the rest, retrying until one accepts
- stores blob metadata and user storage usage via `db-api`
- serves the account (`/account/*`), admin/moderation (`/admin/*`), internal purge, and the console SPA
- supports download and delete operations for authenticated owners; reads are gated per owner access state

### `pg-gateway` (mesh-PG data plane)

Rust pgwire server that exposes a regular Postgres API backed by the mesh of storage providers: writes land in a durable buffer and are dispatched over the NVPN mesh, reads fan out to providers' `pg-agent` or route via the placement index. See [`docs/DECENTRALIZED_PG_PLAN.md`](docs/DECENTRALIZED_PG_PLAN.md) and [`docs/provider-onboarding.md`](docs/provider-onboarding.md).

### `storage-client`

Dockerised backend services used for local testing:

- `blossom` — raw blob server with upload, health, and storage endpoints (routes: `/upload`, `/blob/:hash` for both download and delete, `/health`, `/storage`)
- `mesh-postgres` + `pg-agent` — provider side of the mesh-PG data plane (`pg-agent` exposes `/pg/*` on the mesh)
- `storage-agent` — opt-in (`docker compose --profile agent up -d`) capacity and liveness reporting, signed by the storage machine's nVPN identity

### `control-plane-backend` and `admin-app`

- `control-plane-backend` — Rust/Axum API with DB-backed Admin and Client roles, self-service storage enrollment, capacity reporting, and nVPN roster operations. Every `/v1` route verifies NIP-98.
- `admin-app` — role-aware web/Tauri client. It supports multiple storage hosts, persists only NIP-49 `ncryptsec` credentials, never persists passphrases, and keeps decrypted keys in Rust process memory only.
- The production Compose stack shares the nVPN sidecar's network namespace and state volume with the backend. Port `ADMIN_API_PORT` is published on host loopback only for nginx; the backend has no Docker socket and no extra capabilities.

### `packages/smoke-test`

Protocol-level checks driven over real HTTP connections — signs Nostr events with `nostr-tools` and exercises the full `proxy/blossom` REST API against a live stack. The same checks are driven by both topology harnesses: `scripts/docker-smoke-test.sh` (meshless) and `scripts/nvpn-mesh-e2e.sh` (NVPN mesh, host + client). See [Smoke testing](#smoke-testing) below.

## Plan rules

Plans sell **total storage allowance and time only** — there is no free tier,
no per-file plan limit, and no per-plan replica count. The catalog lives in
`formstr-backend` (`config/storage-plans.json`); the orchestrator stores only
the entitlement (`plan`, `planExpiresAt`, `storageBytes`, `status`). Duration
is additive: renewing adds days, upgrading applies immediately and carries
remaining days over, and a lower tier can only be bought after expiry.

| Field          | Meaning                                                            |
| -------------- | ------------------------------------------------------------------ |
| `rank`         | Tier ordering; drives upgrade vs extend, never sent by the buyer   |
| `priceSats`    | Lightning price                                                    |
| `durationDays` | Days added on renewal/upgrade                                      |
| `storageBytes` | Total allowance checked against `usedStorage`                      |

Operator-only limits: `MAX_UPLOAD_BYTES` (single-request hard cap) and the
lifecycle timings in `config/lifecycle.yml` (grace/write/read windows).

## Database schema

- `User` — `npub` (PK), `plan`, `planExpiresAt`, `storageBytes`, `status`,
  `termsVersion`/`termsAcceptedAt`, `usedStorage`, `createdAt`
- `Blob` — `hash` (PK), `npub`, `size`, `replicas`, `createdAt`
- `NotificationLog` — dedupe key `(npub, kind, ref, channel)` for sent notifications
- `ModerationAction` — admin moderation audit rows (hash, owner, admin, reason)
- `Member` — donor/operator npub, role, authorization status, and audit metadata
- `Storage` — storage-machine npub, owner, tunnel address, reported capacity, lifecycle, and last ping

`usedStorage` and `size` are `BigInt` in Postgres; `db-api` serializes them as decimal **strings** over HTTP (JSON can't carry `BigInt`). `packages/db-client` types these fields as `string`; the proxy converts with `Number(...)` where needed, same as before.

## `db-api` endpoints

Internal-only. The entitlement/admin/mutation endpoints are gated by **NIP-98
plus role**, not a shared token: the caller signs the request with a service
nsec, and the signer's npub must have `role = service|admin` in the `User`
table. Service identities are registered out of band:

```bash
npm run register:service -- <npub>   # role=service by default
```

Pre-existing internal endpoints keep their original unauthenticated behaviour
for the control plane. `size`/`usedStorage` are decimal strings. `db-api` only
ever returns data-integrity errors (`404` missing row, `409` duplicate id /
quota from the blob transaction) — lifecycle decisions belong to the proxy;
the entitlement write is the one atomic quota guard on the write path.

| Method    | Path                              | Notes                                                             |
| --------- | --------------------------------- | ----------------------------------------------------------------- |
| GET       | `/health`                         | compose healthcheck                                               |
| GET / PUT | `/users/:npub`                    | read / upsert (extended entitlement serialization)                |
| GET       | `/users`                          | service: paginated list, filters `status`/`plan`/`query`          |
| GET       | `/users/attention`                | service: users due for lifecycle/notification evaluation          |
| POST      | `/users/:npub/entitlement`        | service: atomic assign/extend/upgrade (+ admin expiry override)   |
| PATCH     | `/users/:npub/status`             | service: notifier/admin status mirror                             |
| GET       | `/users/:npub/blobs`              | paginated own blobs                                               |
| DELETE    | `/users/:npub/blobs`              | service: transactional bulk delete (purge)                        |
| GET / POST | `/notifications`                 | service: list / log (409 on duplicate dedupe key)                 |
| GET / POST | `/moderation`                    | service: moderation audit list / record                           |
| GET       | `/blobs`                          | service: global blob search/filter/pagination                     |
| GET       | `/storage-stats`                  | service: users/blobs/bytes/status counts (no money)               |
| GET       | `/blobs/total`                    | summed blob size across all users                                 |
| GET       | `/blobs/:hash`                    | read                                                              |
| POST      | `/blobs`                          | atomically creates the blob row and increments `usedStorage`      |
| DELETE    | `/blobs/:hash`                    | atomically deletes and decrements `usedStorage`                   |
| GET / PUT / DELETE | `/members`, `/members/:npub` | donor roster CRUD and soft revocation                         |
| GET / POST / PATCH / DELETE | `/storages`, `/storages/:npub` | storage roster CRUD and liveness inputs              |
| GET       | `/storages/active`                | fresh linked blossom backends polled by `proxy/blossom`          |
| GET       | `/storages/active-pg`             | fresh linked mesh-PG providers polled by `pg-gateway`            |

## Prerequisites

- Node.js 20+
- pnpm
- Docker Engine + Compose V2. Install the **buildx** plugin too — the Dockerfiles use
  `# syntax=` directives and BuildKit-provided `TARGETARCH`. They do fall back to the classic
  builder, but that path is not what they are written for.
- Linux, with `/dev/net/tun` present, if you intend to run the NVPN mesh topology. Rootless
  Docker and native Windows containers cannot run the sidecar at all; Docker Desktop/WSL2 is
  best-effort. The meshless dev topology also needs Linux, since it uses `network_mode: host`.
- PostgreSQL database (the root `docker-compose.yml` provisions one; bring your own by editing `DATABASE_URL` in `.env`)

## Quick start (fresh machines)

The host runs the public proxies and control plane; authorized clients operate one or more
storage machines. The normal path is self-service after an admin grants membership.

**On the host machine** (public-facing proxies):

```bash
cp .env.example .env
# Set ADMIN_PUBLIC_URL and an initial ADMIN_ALLOWED_PUBKEYS bootstrap npub.
docker compose up -d --build
```

Open `admin-app`, unlock the bootstrap-admin profile, and authorize the client's operator npub.
The environment seed is ignored after the Member table contains its first row.

**As the authorized client** (in `admin-app`):

1. Select **Request invite**. The nVPN invite is self-contained and remains a bearer credential.
2. Take it to the storage machine and bootstrap that machine's separate identity:

**On the client machine** (storage backends):

```bash
cd storage-client
./scripts/nvpn-join.sh
```

The script asks for the invite without echoing it and prints only the storage machine's npub.
Paste that npub into **Link a storage** in the same client session. This explicit second action
approves the device and records the authenticated client as its owner.

Then start the storage stack and reporting agent:

```bash
docker compose --profile agent up -d --build
```

The agent derives the host identity and tunnel route from the imported invite, signs each report
with the storage machine's persisted nVPN key, and never copies that secret into `.env`.
`nvpn-host-setup.sh`, `nvpn-client-setup.sh`, and `nvpn-approve.sh` remain available as manual
mesh/legacy overrides; they are not the normal DB-backed enrollment path.

### Verifying on one machine

Three scripts exercise the stack without a cross-machine handoff — useful in
CI, or to confirm a new machine is capable of running this at all:

```bash
./scripts/docker-smoke-test.sh   # meshless dev topology + 24 protocol checks
./scripts/nvpn-mesh-e2e.sh       # NVPN mesh: host and client on one host, same 24 checks
./scripts/control-plane-e2e.sh   # DB roles, self-service enrollment, agent ping, dynamic proxies
```

`KEEP_UP=1` leaves the stacks running afterward.

> The two `*-e2e.sh` scripts are **test harnesses, not setup tools**. They wipe both `nvpn_data`
> volumes; `control-plane-e2e.sh` also wipes the Compose Postgres volume. Never run either against
> a real deployment.

## Setup

This walkthrough is the manual, step-by-step equivalent of the [Quick start](#quick-start-fresh-machines)
scripts above — use it if you want to see/control each step, or aren't running the NVPN mesh at
all. **None of it needs `pnpm install`**: every service Dockerfile (`packages/db`,
`proxy/blossom`) runs its own `pnpm install --frozen-lockfile`, builds, and (for
`db-api`) `prisma generate` internally, and `db-api`'s image runs `prisma migrate deploy` itself
on container start via its `CMD`. `pnpm install` on the host is only needed if you want to run a
service directly with `pnpm --filter ... run dev` instead of Docker, or run
`packages/smoke-test` from the host — see [Local (non-Docker) dev](#local-non-docker-dev) below.

### 1. Create the env file

A single root `.env` configures everything — `db-api`, `proxy/blossom`, `pg-gateway`, and `docker-compose.yml` itself all read from it (see [`.env.example`](.env.example) for the full list with comments):

```bash
cp .env.example .env
```

The defaults in `.env.example` already work for local (non-Docker) dev out of the box — `DATABASE_URL` and `DB_API_URL` are derived from `POSTGRES_*`/`DB_API_PORT` respectively rather than needing to be set explicitly (see the comments in `.env.example` if you need to override either). At minimum you'll want:

```bash
DB_API_PORT=4000
BLOSSOM_PORT=3001
# Service identities for internal calls. Each is a nostr secret key; the
# matching npub is registered with role=service (see the db-api section).
DB_API_SERVICE_NSEC=nsec1...
STORAGE_SERVICE_NSEC=nsec1...
```

> Providers are discovered from `db-api` (`/storages/active`) only; there is
> no static URL list. A storage row becomes active after the control plane
> probes it.

### 2. Start storage backends

The `storage-client` layer has its own Docker Compose configuration and is kept separate from the main orchestrator stack.

```bash
cd storage-client
./scripts/start.sh
```

This brings up the local `blossom` backend (plus the provider-side `mesh-postgres` + `pg-agent`
of the mesh-PG data plane).

### 3. Run everything else with Docker (local dev — meshless)

`docker-compose.dev.yml` runs PostgreSQL, `db-api`, and `proxy/blossom` together for
local development, reading the same `.env` from step 1 — `db-api`'s image installs its own
dependencies, runs `prisma generate`, builds, and (on container start) runs `prisma migrate
deploy` itself, so there's nothing to prepare on the host first. `db-api` binds only to the host's
loopback (`127.0.0.1:4000`) — never reachable off-box. `proxy/blossom` runs
with `network_mode: host` (Linux only) rather than the bridge network, so its local-dev and
Docker config are identical and db-api is reached at `localhost:$DB_API_PORT`.
It only overrides `DATABASE_URL` on the `db` service (pointed at the compose-managed `postgres`
using the `POSTGRES_*` credentials from `.env`); everything else is injected straight from `.env`
via `env_file:`.

Production instead uses the plain `docker-compose.yml`, which puts `blossom` behind an
NVPN mesh sidecar instead of host networking — see [Production: NVPN mesh](#production-nvpn-mesh)
below.

1. Start the dev stack (reuses the `.env` created in step 1 — `env_file: ./.env` will fail if it's
   missing, so run `cp .env.example .env` first if you skipped that step):

```bash
docker compose -f docker-compose.dev.yml up --build
```

2. Confirm services are running:

- `proxy/blossom` on `http://localhost:3001` (bound directly on the host via `network_mode: host`)
- `db-api` on `http://127.0.0.1:4000` — loopback only, not reachable from outside the host
- PostgreSQL is reachable only from other containers on the compose network (`postgres:5432`) — uncomment the `ports:` mapping on the `postgres` service in `docker-compose.dev.yml` if you need direct access (e.g. for `prisma studio`)

### 4. When using `storage-client`

Keep `storage-client` running in its own Docker environment (also meshless in local dev — see
[`storage-client/docker-compose.dev.yml`](storage-client/docker-compose.dev.yml)). In one terminal:

```bash
cd storage-client
./scripts/start.sh
```

Then use the main orchestrator Docker stack for `blossom` and `db`.

## Local (non-Docker) dev

Only needed if you're running `db-api`/`proxy/blossom` directly with `pnpm --filter
... run dev` instead of Docker (see [Workspace commands](#workspace-commands) for those), or want
`prisma studio`/`migrate dev` against your local database. None of this is required for the
Docker paths above — see the note at the top of [Setup](#setup).

```bash
pnpm install
pnpm --filter @orchestrator/db-api run generate
pnpm --filter @orchestrator/db-api run migrate:deploy   # or migrate:dev while iterating on schema.prisma
```

## Production: NVPN mesh

Production replaces host networking with a Docker sidecar running [NVPN](https://github.com/mmalmi/nostr-vpn)
(`nostr-vpn` v4.0.87) — `proxy/blossom`, `control-plane-backend`, and `pg-gateway` share the
sidecar's network namespace (`network_mode: "service:nvpn"`) and reach storage-client backends
over a private mesh confined to that namespace. **The host itself never joins the mesh.** Full design, firewall rules, and
verification gates: [`docs/NVPN_SIDECAR_PLAN.md`](docs/NVPN_SIDECAR_PLAN.md); sidecar contract and
recovery steps: [`nvpn/README.md`](nvpn/README.md).

**Most of the time you want the two guided scripts instead of the steps below** —
`scripts/nvpn-host-setup.sh` on the host and `storage-client/scripts/nvpn-client-setup.sh` on the
client, as described in [Quick start](#quick-start-fresh-machines). The rest of this section
documents what they do, for when you need to run a step on its own (approving a second client,
recovering, or debugging a stuck join).

To check the whole flow works on a machine before doing it for real, run
`./scripts/nvpn-mesh-e2e.sh` — it drives every step below against a throwaway client on a single
host and asserts that blob traffic actually crosses the tunnel.

### Proxy (this repo, root)

```bash
cp .env.example .env   # setting NVPN_ROLE=proxy is not required — docker-compose.yml sets it directly
```

**Before generating any invite, set `NVPN_ENDPOINT` in `.env`** to an address remote clients can
actually reach:

```bash
# .env
NVPN_ENDPOINT=203.0.113.10:51820   # this host's public <ip-or-host>:<NVPN_LISTEN_PORT>
```

`nvpn init` otherwise records whatever local address it saw, which inside a container is the
Docker bridge IP (`172.x`). Invites carry that address, so without this every remote client is
left depending on the FIPS relay fallback and the direct path can never establish. Also publish
`NVPN_LISTEN_PORT` (UDP 51820 by default) through any firewall in front of the host.

```bash
docker compose up -d --build
./scripts/nvpn-invite.sh
```

`nvpn-invite.sh` prints an invite to this terminal only — send it to exactly one storage-client
operator you intend to approve. Treat it as a bearer credential: anyone holding it can queue a
join request against your network.

### Storage client

```bash
cd storage-client
cp .env.example .env
./scripts/nvpn-join.sh
docker compose up -d --build
```

`nvpn-join.sh` prompts for the invite (not echoed), bootstraps the client's NVPN identity, and
prints only the resulting npub — send that public identifier back to the proxy operator. The
bootstrap also adds the inviting proxy to this client's own roster: `import-invite` alone leaves
`devices = []`, and the mesh daemon refuses to start with no participants configured.

The client stack goes healthy while still waiting for approval — that is deliberate, so a
pending client is distinguishable from a broken one. Its `blossom` backend and `pg-agent` are
reachable only over the mesh tunnel or loopback; the sidecar's firewall explicitly rejects them
from the Docker bridge, so nothing is exposed to the host or to sibling containers.

### Approval

```bash
./scripts/nvpn-approve.sh <client-npub>
```

`nvpn-approve.sh` adds the device to the signed roster and then issues `nvpn reload`, which the
running daemon picks up in place — so approving a client never requires recreating the `nvpn`
sidecar, and therefore never tears down the network namespace `blossom` shares with it.

Once the roster syncs, look up the approved peer's mesh tunnel IP and point the proxy at it:

```bash
docker compose exec nvpn sh -c \
  'nvpn status --config "$XDG_CONFIG_HOME/nvpn/config.toml" --json' \
  | jq -r '.daemon.state.peers[] | "\(.tunnel_ip)  reachable=\(.reachable)"'
```

Wait until the peer shows `reachable=true`, then link the storage from the
admin app (the control plane probes it through the mesh). Once the probe
succeeds, `db-api` reports it under `/storages/active` and the proxy picks it
up on its next registry poll — no `.env` change or proxy restart needed.

The following historical note about recreating the proxy after an env change is
kept only for operators still on the pre-registry topology:

Restart or recreate only the proxy application service after changing that value — do not
recreate the `nvpn` sidecar unnecessarily:

```bash
docker compose up -d --force-recreate blossom
```

### Delegated admins

By default, approving a client means running `scripts/nvpn-approve.sh` **on the proxy host** —
so onboarding every new storage client requires server access. That does not have to be the
case. The mesh roster is a Nostr event signed by any admin key and distributed over relays, and
a network can have more than one admin.

Promote a co-admin once, from the server:

```bash
./scripts/nvpn-invite.sh                        # send this invite to the prospective admin
# they import it on their own machine and send back their npub
./scripts/nvpn-add-admin.sh <their-npub>
```

From then on **that admin creates invites and approves clients from their own machine or
phone**, and this proxy picks up their signed roster over Nostr automatically — no SSH, no
redeploy, nothing running here but the sidecar that is already running:

```bash
# on the co-admin's machine, not the server:
nvpn create-invite --config <their-config>
nvpn add-device --config <their-config> --device <client-npub> --publish
```

Verified behaviour: after a co-admin published an approval, the proxy's roster included the new
client within ~45s with no local action, and the client learned the proxy from the same synced
roster — even though its invite came from the co-admin rather than the proxy. Notes:

- An admin must also be a device on the roster; `nvpn-add-admin.sh` does both.
- Admin is a **full** grant — an admin can add or remove any device, including revoking other
  admins. Treat it as equivalent to handing out server access, scoped to the roster.
- Roster propagation needs the proxy's sidecar daemon running (its normal state) and depends on
  public Nostr relays, so it is eventually-consistent rather than instant. `published_recipients=0`
  in the CLI output is not a failure signal — propagation succeeded in every case despite it.
- The mesh identity that signs is just a Nostr key. The `admin-app` avoids putting that protocol
  and the host mesh identity on the phone: it signs short-lived NIP-98 requests, and the
  control plane performs roster operations through the host's existing nVPN CLI.

### Admin API and app

Set the public URL and at least one bootstrap admin before the first production start:

```bash
# .env
ADMIN_PUBLIC_URL=https://storage.formstr.app
ADMIN_API_PORT=3002
ADMIN_ALLOWED_PUBKEYS=npub1...
```

`docker compose up -d --build` starts `control-plane-backend` as the `admin` service. It exposes
`127.0.0.1:${ADMIN_API_PORT}` for the reverse proxy and provides these endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/health` | Unauthenticated health check |
| `GET` | `/v1/me` | Resolve the caller's host role |
| `GET` | `/v1/status`, `/v1/roster`, `/v1/members` | Admin observability and roster reads |
| `POST` | `/v1/members`, `/v1/members/remove` | Authorize, promote, or revoke members |
| `POST` | `/v1/invites` | Active-member self-service nVPN invite |
| `GET` | `/v1/storages` | Own storage for clients; all storage for admins |
| `POST` | `/v1/storage` | Link and mesh-approve the caller's storage npub |
| `POST` | `/v1/storage/ping` | Storage-agent liveness/capacity report over the mesh |
| `POST` | `/v1/storage/:npub/capacity`, `/remove` | Edit declared capacity or remove storage |

All `/v1` endpoints require an exact URL/method NIP-98 event. POST signatures also bind the
request body. See [`control-plane-backend/README.md`](control-plane-backend/README.md) for the wire contract and
[`admin-app/README.md`](admin-app/README.md) for Android/Linux build instructions. The app starts
with `https://storage.formstr.app` prefilled and can retain multiple host profiles.

### Recovery

If a Compose-controlled sidecar update leaves `blossom` stuck waiting on the sidecar's
namespace, force-recreate the sidecar and its dependents together:

```bash
docker compose up -d --force-recreate nvpn blossom admin pg-gateway
```

See [`nvpn/README.md`](nvpn/README.md#recovery) for what to do if the sidecar refuses to start
because of unrecognized existing state.

### Platform support

Linux Docker Engine + Compose V2 + `/dev/net/tun` only. Rootless Docker and native Windows
containers are unsupported; Docker Desktop/WSL2 are best-effort. See
[`nvpn/README.md`](nvpn/README.md#supported-platforms).

### Known-untested paths

`scripts/nvpn-mesh-e2e.sh` runs both peers on one Docker host, where they connect over the FIPS
relay fallback. These have therefore **not** been exercised end to end and should be verified
before you depend on them:

- **Cross-host mesh** — two peers on separate machines.
- **The direct-UDP path**, including [`storage-client/compose.direct-udp.yml`](storage-client/compose.direct-udp.yml).
  This is also what `NVPN_ENDPOINT` above exists to make work.

## `proxy/blossom` API

Protocol routes expect `Authorization: Nostr <base64 BUD-11 event>`; admin
routes expect NIP-98 (kind 27235) and a verified admin; `/internal/purge/:npub`
expects `X-Internal-Token`.

| Method | Path                    | Description                                                        |
| ------ | ----------------------- | ------------------------------------------------------------------ |
| GET    | `/storage`              | Usage, allowance, plan, derived status                             |
| HEAD   | `/upload`               | BUD-06 pre-flight (auth + quota + operator size cap)               |
| PUT    | `/upload`               | BUD-02 upload (`application/octet-stream`)                         |
| GET    | `/<sha256>[.ext]`       | BUD-01 read (public, gated by owner lifecycle state)               |
| HEAD   | `/<sha256>[.ext]`       | BUD-01 metadata                                                    |
| DELETE | `/<sha256>[.ext]`       | BUD-12 owner delete (allowed in every state where a blob exists)   |
| GET    | `/account`              | Entitlement + derived access for the signer                        |
| GET    | `/account/blobs`        | Paginated own blobs (BUD-11 `list`)                                |
| GET    | `/account/notifications`| Paginated notification history                                     |
| GET    | `/admin/users`          | Admin: paginated users                                             |
| GET    | `/admin/blobs`          | Admin: paginated blob search                                       |
| GET    | `/admin/storage-stats`  | Admin: lifecycle/storage counts                                    |
| GET    | `/admin/audit`          | Admin: moderation audit log                                        |
| POST   | `/admin/users/:npub/entitlement` | Admin: plan grant / force extend or upgrade               |
| PATCH  | `/admin/users/:npub/status`      | Admin: force lifecycle status                             |
| DELETE | `/admin/blobs/:hash`    | Admin: moderation delete + owner notification                      |
| POST   | `/internal/purge/:npub` | Internal: delete all replicas + rows, set CLOSED                   |

### Example auth header

The proxy expects a base64-encoded JSON event object signed with Nostr keys. The service verifies the event signature and derives `npub` from the event pubkey.

## Smoke testing

`scripts/docker-smoke-test.sh` brings up the full stack in Docker via the meshless
`docker-compose.dev.yml` files (starting `storage-client`'s blossom backend first if it isn't
already running — no NVPN sidecar or invite/approval flow involved) and drives the real HTTP
protocols end to end via `packages/smoke-test`:

```bash
./scripts/docker-smoke-test.sh
```

It creates a missing `.env` from `.env.example`, waits for `postgres`/`db`/`blossom` to become reachable, generates a throwaway service key and registers it with `role=service`, then checks blossom auth rejection, unpaid-upload rejection, NIP-98 entitlement provisioning through `db-api`, quota enforcement, read gating, and upload/download/delete round-trips. By default it tears the root dev stack down afterward (`storage-client`'s blossom backend is left running for reuse); set `KEEP_UP=1` to leave the root stack up too for manual poking.

### Mesh end-to-end test

`scripts/docker-smoke-test.sh` covers only the meshless topology. `scripts/nvpn-mesh-e2e.sh`
covers the other one — it brings up the root proxy stack as a mesh **host**, joins a
`storage-client` as a **client** through the real `create-invite` → `bootstrap-client` →
`add-device` flow, waits for the two sidecars to peer, waits for the control plane to probe
the storage through the mesh and mark it active, and then runs the same
`packages/smoke-test` checks across the tunnel:

```bash
./scripts/nvpn-mesh-e2e.sh
```

It recreates both `nvpn_data` volumes so each run starts from fresh mesh identities — **do not
run it against a stack whose mesh identity you care about**, since that invalidates every invite
you have handed out. `KEEP_UP=1` leaves both stacks running. No URL is written to `.env`: the
storage is discovered from `db-api` once the control plane's probe passes.

## Storage plans (Blossom productionisation)

The paid-storage flow spans this repo and `formstr-backend`:

- **`formstr-backend`** owns money and plans: the plan catalog
  (`config/storage-plans.json`), Lightning invoices, and the T&C version sent
  at purchase. It also sends notification emails and answers the unified admin
  check.
- **This repo** owns storage, entitlement, and compliance: `User`
  entitlement + lifecycle, blobs, `NotificationLog`, and `ModerationAction`.

Flow: the console (or any client) calls `POST /api/generate-invoice/storage`
(NIP-98) with `{plan, termsAccepted, termsVersion}`; the backend derives
`extend`/`upgrade` from the buyer's current entitlement and rejects a
downgrade while a plan is live. On the zap receipt it pushes the entitlement to
`db-api POST /users/:npub/entitlement`, signed with its NIP-98 service
identity. T&C acceptance is recorded here (on the user row), not in the backend.

Wiring (all internal APIs are NIP-98 role-gated; no shared tokens):

- `formstr-backend` signs db-api calls with `DB_API_SERVICE_NSEC`; register
  that npub in this repo: `npm run register:service -- <npub>` (role=service
  by default, pass `admin` for admin).
- The orchestrator signs backend calls (admin-check, storage notify) with
  `STORAGE_SERVICE_NSEC`; register that npub in the backend:
  `npm run register:service -- <npub>`.
- A service key may be reused on both sides, but distinct keys limit blast
  radius on revocation.
- The backend reaches `db-api` at `DB_API_URL`; when co-located with Docker,
  use `compose.storage-backend.yml` to join the backend's `formstr` network:

  ```bash
  docker network create formstr        # once, if formstr-backend's network is absent
  docker compose -f docker-compose.yml -f compose.storage-backend.yml up -d
  ```

- `FORMSTR_BACKEND_URL` points the proxy at the backend for admin checks and
  moderation emails; the notifier uses it for expiry/quota mail. Without it,
  admin routes fail closed.

Migrations: both repos ship additive migrations in their own commits
(`packages/db/prisma/migrations/<ts>_entitlements` and
`migrations/20261002130000_pending_storage_plans.ts` +
`20261002130100_invoices_terms_version.ts`). Run `prisma migrate deploy` /
`knex migrate:latest` before starting the new images.

## Pinned images

Every external image is pinned by digest — base images in each `Dockerfile`, plus `postgres` and
`alpine` in the compose files — so rebuilds are reproducible and an upstream retag cannot silently
change the runtime.

To move a pin deliberately, resolve the new digest and edit the reference:

```bash
docker pull postgres:16-alpine
docker inspect postgres:16-alpine --format '{{index .RepoDigests 0}}'
```

## Workspace commands

```bash
pnpm --filter @orchestrator/db-api run dev
pnpm --filter @orchestrator/blossom run dev
pnpm --filter @orchestrator/db-api run studio
pnpm --filter @orchestrator/db-api run migrate:deploy
pnpm --filter @orchestrator/smoke-test run smoke   # requires BLOSSOM_URL already up

# Guided mesh setup — two roles, two machines
./scripts/nvpn-host-setup.sh                       # on the host (proxy) machine
cd storage-client && ./scripts/nvpn-client-setup.sh # on the client (storage) machine
./scripts/nvpn-add-admin.sh <npub>                 # let someone else approve clients, off-server

# Test harnesses — single machine, wipe mesh state
./scripts/docker-smoke-test.sh                     # meshless topology, end to end
./scripts/nvpn-mesh-e2e.sh                         # NVPN mesh, host + client, end to end
pnpm -r run build
```

## Notes

- Provider discovery is DB-only: `proxy/blossom` places each blob on one provider by `fnv1a(npub:timeSlot) % n` over the npub-sorted roster from `db-api /storages/active`. `BLOSSOM_PLACEMENT_SLOT_MS` (default 1 hour) sets how long a placement stays fixed. Uploads fail over by dropping the failed provider and recomputing the selection until one accepts. There is no static URL fallback.
- Entitlement enforcement is date-derived in the proxy (`deriveAccess`); the notifier mirrors `User.status` for dashboards and sends expiry/quota/moderation notifications over NIP-17 DM and email, logging each send to `NotificationLog` for dedupe.
- `config/lifecycle.yml` owns grace/write/read windows, warning thresholds, the T&C version, and `purgeEnabled` (default false). It is mounted read-only into the proxy and notifier; a malformed file fails the service at boot.
- Structured relay storage is served through the mesh-PG data plane (`pg-gateway` + providers' `pg-agent`), not by a relay process in this repo.
- `db-api` (`packages/db`) is the only service with a Postgres/Prisma dependency; `proxy/blossom` talks to it over HTTP via the dependency-free `packages/db-client`, so its Docker image no longer needs Prisma at all.
- In local dev (`docker-compose.dev.yml`), `blossom` and `notifier` run with `network_mode: host` (Linux only), so `db-api` is reached via `localhost` — no `host.docker.internal`/`extra_hosts` needed. In production (`docker-compose.yml`), they share the NVPN sidecar's network namespace and reach storage-client backends over the mesh — see [Production: NVPN mesh](#production-nvpn-mesh).
- A single root `.env` configures everything: `db-api`, `proxy/blossom`, `pg-gateway` (each resolves it via an explicit `dotenv` path pointing at the repo root, regardless of which package's script you run it from), and `docker-compose.yml` itself. `PORT` reads are namespaced per service (`DB_API_PORT`, `BLOSSOM_PORT`, `PG_GATEWAY_PORT`) so all can share the one file without colliding.
