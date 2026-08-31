# nostr-storage-orchestrator

A pnpm workspace for a Nostr-aware storage orchestrator. It combines a blob proxy, a WebSocket Nostr relay proxy, and backend storage services with PostgreSQL persistence — accessed through an internal, thin DB-as-a-service layer (`db-api`) rather than a shared in-process client.

## Architecture

```
Client
  │  Authorization: Nostr <base64-signed-event>
  ▼
proxy/blossom  ──► db-api (HTTP, internal-only) ──► PostgreSQL
  │
  ├──► active blossom backends (DB roster, refreshed every 15s)
  └──► ...

Client
  │  WebSocket Nostr relay protocol
  ▼
proxy/relay  ──► active backend relays (DB roster, refreshed every 15s)
  └──► db-api (HTTP, internal-only) ──► PostgreSQL

Storage Control (Android/Linux)
  │  NIP-98 HTTP auth
  ▼
control-plane-backend ──► db-api + NVPN CLI/shared sidecar state
```

`db-api` is a thin data layer: it performs CRUD reads/writes and keeps two-table writes atomic (e.g. creating a blob and bumping a user's `usedStorage` in one transaction), but it holds **no business logic**. Quota enforcement, duplicate-handling, and ownership checks all live in the proxies, exactly as before — only the Prisma calls moved behind HTTP. `db-api` is never exposed publicly (compose-internal network only) and has no auth layer.

## Components

### `packages/db` (`@orchestrator/db-api`)

- Prisma schema, migrations, and generated client — the only service that touches Postgres directly
- Express HTTP server exposing CRUD for `User`, `Blob`, `RelayEvent`, `Member`, and `Storage`, plus `GET /plans`
- No quota checks, no auth — see [`proxy/blossom` API](#proxyblossom-api) / [`proxy/relay`](#proxyrelay-behavior) for where those decisions actually happen

### `packages/db-client` (`@orchestrator/db-client`)

- Zero-runtime-dependency `fetch`-based client + shared TypeScript types for `db-api`
- Used by both proxies instead of linking Prisma directly, which is what made Docker builds for the proxies fragile before

### `proxy/blossom`

TypeScript/Express service that:

- validates Nostr auth events from `Authorization: Nostr ...`
- resolves `npub` from the signed event
- enforces plan quotas and upload size limits (fetches `PLAN_CONFIG` from `db-api` once and caches it)
- selects healthy backend blossom servers
- uploads blob data to `replicaCount` backends
- stores blob metadata and user storage usage via `db-api`
- supports download and delete operations for authenticated owners

### `proxy/relay`

TypeScript/Express + WebSocket Nostr relay proxy that:

- accepts NIP-42-style `AUTH` handshake messages for writes (reads are open without authentication)
- validates relay auth events against a challenge and normalized `PUBLIC_URL`
- aggregates `REQ` subscriptions across multiple `BACKEND_RELAYS` and emits exactly one `EOSE` per frontend subscription
- keeps backend subscriptions active after `EOSE` for live event delivery
- accepts signed `EVENT` writes and enforces plan upload constraints
- publishes events to healthy backend relays with required-replica policy
- records relay events and storage reservations via `db-api`
- serves NIP-11 relay information at the same HTTP URI as the WebSocket endpoint (`Accept: application/nostr+json`)

Supported NIPs (verified by tests): **NIP-01**, **NIP-11**, **NIP-42**.

#### Multi-backend EOSE aggregation

Each frontend `REQ` opens one backend subscription per configured relay. The proxy tracks each backend independently (`pending`, `eose`, `timed-out`, `failed`, `closed`) and sends a single frontend `["EOSE", subId]` only after every backend reaches an initial terminal state. Healthy backend subscriptions remain open for live events.

#### Publication replication policy

For writes and kind-5 deletions, the proxy selects `replicaCount` healthy backends from the user's plan and requires acceptance from **every** selected backend. `OK true` is sent only when all required replicas accept. Partial success returns `OK false` with an `error:` reason, persists accepted replica URLs when any backend accepted, and rolls back storage reservation only when zero backends accepted.

#### Optional backend service authentication

If a backend relay sends NIP-42 `AUTH`, the proxy can authenticate using `BACKEND_AUTH_SECRET_KEY` (service identity). Without it, backend operations fail fast with `auth-required: backend relay requires authentication`. Service identity cannot satisfy backend ACLs that require the original frontend user's pubkey.

#### Timeout configuration

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_INITIAL_EOSE_TIMEOUT_MS` | `5000` | Per-backend initial query timeout before counting as `timed-out` |
| `RELAY_PUBLISH_ACK_TIMEOUT_MS` | `5000` | Backend `OK` acknowledgement timeout for publishes |

### `storage-client`

Dockerised backend services used for local testing:

- `blossom` — raw blob server with upload, health, and storage endpoints (routes: `/upload`, `/blob/:hash` for both download and delete, `/health`, `/storage`)
- `strfry` — deployed via Docker Compose as a backend relay
- `storage-agent` — opt-in (`docker compose --profile agent up -d`) capacity and liveness reporting, signed by the storage machine's nVPN identity

### `control-plane-backend` and `admin-app`

- `control-plane-backend` — Rust/Axum API with DB-backed Admin and Client roles, self-service storage enrollment, capacity reporting, and nVPN roster operations. Every `/v1` route verifies NIP-98.
- `admin-app` — role-aware web/Tauri client. It supports multiple storage hosts, persists only NIP-49 `ncryptsec` credentials, never persists passphrases, and keeps decrypted keys in Rust process memory only.
- The production Compose stack shares the nVPN sidecar's network namespace and state volume with the backend. Port `ADMIN_API_PORT` is published on host loopback only for nginx; the backend has no Docker socket and no extra capabilities.

### `packages/smoke-test`

Protocol-level checks driven over real HTTP/WebSocket connections — signs Nostr events with `nostr-tools`, exercises the full `proxy/blossom` REST API and `proxy/relay` WebSocket protocol (AUTH, EVENT, REQ, kind-5 delete) against a live stack. The same 24 checks are driven by both topology harnesses: `scripts/docker-smoke-test.sh` (meshless) and `scripts/nvpn-mesh-e2e.sh` (NVPN mesh, host + client). See [Smoke testing](#smoke-testing) below.

## Plan rules

| Plan    | Storage limit | Max upload size | Replica count |
| ------- | ------------- | --------------- | ------------- |
| `FREE`  | 15 GB         | 50 MB           | 1             |
| `BASIC` | 50 GB         | 500 MB          | 3             |
| `PRO`   | 100 GB        | 2 GB            | 5             |

## Database schema

- `User` — `npub` (PK), `plan`, `usedStorage`, `createdAt`
- `Blob` — `hash` (PK), `npub`, `size`, `replicas`, `createdAt`
- `RelayEvent` — `eventId` (PK), `npub`, `kind`, `size`, `replicas`, `createdAt`
- `Member` — donor/operator npub, role, authorization status, and audit metadata
- `Storage` — storage-machine npub, owner, tunnel address, reported capacity, lifecycle, and last ping

`usedStorage` and `size` are `BigInt` in Postgres; `db-api` serializes them as decimal **strings** over HTTP (JSON can't carry `BigInt`). `packages/db-client` types these fields as `string`; proxies convert with `Number(...)` where needed, same as before.

## `db-api` endpoints

All internal-only, no auth. `size`/`usedStorage` are decimal strings. `db-api` only ever returns data-integrity errors (`404` missing row, `409` duplicate id) — it never rejects for quota reasons; that decision belongs to the proxies.

| Method    | Path                              | Notes                                                             |
| --------- | --------------------------------- | ----------------------------------------------------------------- |
| GET       | `/health`                         | compose healthcheck                                               |
| GET       | `/plans`                          | static `PLAN_CONFIG` data                                         |
| GET / PUT | `/users/:npub`                    | read / upsert                                                     |
| GET       | `/blobs/:hash`                    | read                                                              |
| POST      | `/blobs`                          | atomically creates the blob row and increments `usedStorage`      |
| DELETE    | `/blobs/:hash`                    | atomically deletes and decrements `usedStorage`                   |
| GET       | `/relay-events/:eventId`          | read                                                              |
| POST      | `/relay-events`                   | atomically creates the row and increments `usedStorage`           |
| POST      | `/relay-events/:eventId/rollback` | idempotent delete + decrement                                     |
| PATCH     | `/relay-events/:eventId`          | sets `replicas`                                                   |
| DELETE    | `/relay-events/:eventId`          | plain delete, **no** decrement (matches relay's kind-5 semantics) |
| GET / PUT / DELETE | `/members`, `/members/:npub` | donor roster CRUD and soft revocation                         |
| GET / POST / PATCH / DELETE | `/storages`, `/storages/:npub` | storage roster CRUD and liveness inputs              |
| GET       | `/storages/active`                | fresh linked backends polled by both proxies                     |

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
`proxy/blossom`, `proxy/relay`) runs its own `pnpm install --frozen-lockfile`, builds, and (for
`db-api`) `prisma generate` internally, and `db-api`'s image runs `prisma migrate deploy` itself
on container start via its `CMD`. `pnpm install` on the host is only needed if you want to run a
service directly with `pnpm --filter ... run dev` instead of Docker, or run
`packages/smoke-test` from the host — see [Local (non-Docker) dev](#local-non-docker-dev) below.

### 1. Create the env file

A single root `.env` configures everything — `db-api`, `proxy/blossom`, `proxy/relay`, and `docker-compose.yml` itself all read from it (see [`.env.example`](.env.example) for the full list with comments):

```bash
cp .env.example .env
```

The defaults in `.env.example` already work for local (non-Docker) dev out of the box — `DATABASE_URL` and `DB_API_URL` are derived from `POSTGRES_*`/`DB_API_PORT` respectively rather than needing to be set explicitly (see the comments in `.env.example` if you need to override either). At minimum you'll want:

```bash
DB_API_PORT=4000
BLOSSOM_PORT=3001
BLOSSOM_SERVERS=http://localhost:3000
RELAY_PORT=8007
BACKEND_RELAYS=ws://localhost:7777
```

> `BLOSSOM_SERVERS`/`BACKEND_RELAYS` must each list one or more backend URLs separated by commas.

### 2. Start storage backends

The `storage-client` layer has its own Docker Compose configuration and is kept separate from the main orchestrator stack.

```bash
cd storage-client
./scripts/start.sh
```

This brings up the local `blossom` backend and the backend relay service. A `relay-init`
one-shot service runs first and fixes `data/strfry`'s ownership for you — strfry runs as uid
1000 while that bind-mounted directory is created root-owned, and without the fix strfry
crash-loops on `mdb_env_open: Permission denied`.

### 3. Run everything else with Docker (local dev — meshless)

`docker-compose.dev.yml` runs PostgreSQL, `db-api`, `proxy/blossom`, and `proxy/relay` together for
local development, reading the same `.env` from step 1 — `db-api`'s image installs its own
dependencies, runs `prisma generate`, builds, and (on container start) runs `prisma migrate
deploy` itself, so there's nothing to prepare on the host first. `db-api` binds only to the host's
loopback (`127.0.0.1:4000`) — never reachable off-box. `proxy/blossom` and `proxy/relay` both run
with `network_mode: host` (Linux only) rather than the bridge network, so their local-dev and
Docker config are identical and `BLOSSOM_SERVERS`/`BACKEND_RELAYS` default straight to `localhost`.
It only overrides `DATABASE_URL` on the `db` service (pointed at the compose-managed `postgres`
using the `POSTGRES_*` credentials from `.env`); everything else is injected straight from `.env`
via `env_file:`.

Production instead uses the plain `docker-compose.yml`, which puts `blossom`/`relay` behind an
NVPN mesh sidecar instead of host networking — see [Production: NVPN mesh](#production-nvpn-mesh)
below.

1. Start the dev stack (reuses the `.env` created in step 1 — `env_file: ./.env` will fail if it's
   missing, so run `cp .env.example .env` first if you skipped that step):

```bash
docker compose -f docker-compose.dev.yml up --build
```

2. Confirm services are running:

- `proxy/blossom` on `http://localhost:3001` (bound directly on the host via `network_mode: host`)
- `proxy/relay` on `ws://localhost:8007`
- `db-api` on `http://127.0.0.1:4000` — loopback only, not reachable from outside the host
- PostgreSQL is reachable only from other containers on the compose network (`postgres:5432`) — uncomment the `ports:` mapping on the `postgres` service in `docker-compose.dev.yml` if you need direct access (e.g. for `prisma studio`)

### 4. When using `storage-client`

Keep `storage-client` running in its own Docker environment (also meshless in local dev — see
[`storage-client/docker-compose.dev.yml`](storage-client/docker-compose.dev.yml)). In one terminal:

```bash
cd storage-client
./scripts/start.sh
```

Then use the main orchestrator Docker stack for `blossom`, `relay`, and `db`.

## Local (non-Docker) dev

Only needed if you're running `db-api`/`proxy/blossom`/`proxy/relay` directly with `pnpm --filter
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
(`nostr-vpn` v4.0.87) — `proxy/blossom`/`proxy/relay` share the sidecar's network namespace
(`network_mode: "service:nvpn"`) and reach storage-client backends over a private mesh confined to
that namespace. **The host itself never joins the mesh.** Full design, firewall rules, and
verification gates: [`docs/NVPN_SIDECAR_PLAN.md`](docs/NVPN_SIDECAR_PLAN.md); sidecar contract and
recovery steps: [`nvpn/README.md`](nvpn/README.md).

**Most of the time you want the two guided scripts instead of the steps below** —
`scripts/nvpn-host-setup.sh` on the host and `storage-client/scripts/nvpn-client-setup.sh` on the
client, as described in [Quick start](#quick-start-fresh-machines). The rest of this section
documents what they do, for when you need to run a step on its own (approving a second client,
recovering, or debugging a stuck join).

To check the whole flow works on a machine before doing it for real, run
`./scripts/nvpn-mesh-e2e.sh` — it drives every step below against a throwaway client on a single
host and asserts that blob and relay traffic actually crosses the tunnel.

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
pending client is distinguishable from a broken one. Its `blossom`/`strfry` backends are
reachable only over the mesh tunnel or loopback; the sidecar's firewall explicitly rejects them
from the Docker bridge, so nothing is exposed to the host or to sibling containers.

### Approval

```bash
./scripts/nvpn-approve.sh <client-npub>
```

`nvpn-approve.sh` adds the device to the signed roster and then issues `nvpn reload`, which the
running daemon picks up in place — so approving a client never requires recreating the `nvpn`
sidecar, and therefore never tears down the network namespace `blossom`/`relay` share with it.

Once the roster syncs, look up the approved peer's mesh tunnel IP and point the proxy at it:

```bash
docker compose exec nvpn sh -c \
  'nvpn status --config "$XDG_CONFIG_HOME/nvpn/config.toml" --json' \
  | jq -r '.daemon.state.peers[] | "\(.tunnel_ip)  reachable=\(.reachable)"'
```

Wait until the peer shows `reachable=true` before pointing anything at it.

```bash
# .env
BLOSSOM_SERVERS=http://10.44.x.y:3000
BACKEND_RELAYS=ws://10.44.x.y:7777
```

Restart or recreate only the proxy application services after changing those values — do not
recreate the `nvpn` sidecar unnecessarily:

```bash
docker compose up -d --force-recreate blossom relay
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

If a Compose-controlled sidecar update leaves `blossom`/`relay` stuck waiting on the sidecar's
namespace, force-recreate the sidecar and its dependents together:

```bash
docker compose up -d --force-recreate nvpn blossom relay
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

All endpoints expect `Authorization: Nostr <base64-encoded-signed-nostr-event>`.

| Method | Path              | Description                                                       |
| ------ | ----------------- | ----------------------------------------------------------------- |
| GET    | `/storage`        | Returns storage usage, available bytes, and current plan          |
| POST   | `/upload`         | Uploads raw blob bytes (`Content-Type: application/octet-stream`) |
| GET    | `/download/:hash` | Downloads blob contents by SHA-256 hash                           |
| DELETE | `/delete/:hash`   | Deletes a blob and decrements user storage                        |

### Example auth header

The proxy expects a base64-encoded JSON event object signed with Nostr keys. The service verifies the event signature and derives `npub` from the event pubkey.

## `proxy/relay` behavior

- Listens for WebSocket clients at `ws://localhost:8007` by default.
- Sends an initial `AUTH` challenge to clients.
- Accepts `AUTH`, `EVENT`, `REQ`, and `CLOSE` messages.
- Validates event signatures and publishes approved writes to backend relays.
- Unauthenticated reads are allowed; writes require NIP-42 authentication.
- Serves NIP-11 metadata on the same URI when `Accept: application/nostr+json` is set.
- Aggregates `EOSE` across multiple `BACKEND_RELAYS` and continues live forwarding after `EOSE`.

Run relay unit/integration tests (fake local backends, no Docker required):

```bash
pnpm --filter @orchestrator/relay test
```

## Smoke testing

`scripts/docker-smoke-test.sh` brings up the full stack in Docker via the meshless
`docker-compose.dev.yml` files (starting `storage-client`'s backends first if they aren't already
running — no NVPN sidecar or invite/approval flow involved) and drives the real HTTP/WebSocket
protocols end to end via `packages/smoke-test`:

```bash
./scripts/docker-smoke-test.sh
```

It creates a missing `.env` from `.env.example`, waits for `postgres`/`db`/`blossom`/`relay` to become reachable, then checks: blossom auth rejection, storage accounting, upload/download/delete round-trips; and relay's NIP-42 AUTH handshake, unauthenticated-write rejection, event publish, `REQ`/`EOSE`, and kind-5 deletion. By default it tears the root dev stack down afterward (`storage-client`'s backends are left running for reuse); set `KEEP_UP=1` to leave the root stack up too for manual poking.

### Mesh end-to-end test

`scripts/docker-smoke-test.sh` covers only the meshless topology. `scripts/nvpn-mesh-e2e.sh`
covers the other one — it brings up the root proxy stack as a mesh **host**, joins a
`storage-client` as a **client** through the real `create-invite` → `bootstrap-client` →
`add-device` flow, waits for the two sidecars to peer, points the proxies at the client's
`10.44.x.y` tunnel IP, and then runs the same `packages/smoke-test` checks across the tunnel:

```bash
./scripts/nvpn-mesh-e2e.sh
```

It recreates both `nvpn_data` volumes so each run starts from fresh mesh identities — **do not
run it against a stack whose mesh identity you care about**, since that invalidates every invite
you have handed out. `KEEP_UP=1` leaves both stacks running. The tunnel IP is only known after
approval, so it is injected via the `compose.mesh-e2e.yml` overlay rather than written to `.env`.

## Pinned images

Every external image is pinned by digest — base images in each `Dockerfile`, plus `postgres` and
`ghcr.io/hoytech/strfry` in the compose files. This is not just hygiene: upstream publishes
`strfry` only as a mutable `latest` tag, and one retag of it silently changed the container's
runtime user from root to uid 1000, which broke the relay with `mdb_env_open: Permission denied`
against the root-owned `storage-client/data/strfry` bind mount. A `relay-init` one-shot service
now fixes that directory's ownership before `relay` starts, so a fresh checkout works without
manual `chown`.

To move a pin deliberately, resolve the new digest and edit the reference:

```bash
docker pull postgres:16-alpine
docker inspect postgres:16-alpine --format '{{index .RepoDigests 0}}'
```

## Workspace commands

```bash
pnpm --filter @orchestrator/db-api run dev
pnpm --filter @orchestrator/blossom run dev
pnpm --filter @orchestrator/relay run dev
pnpm --filter @orchestrator/relay test
pnpm --filter @orchestrator/db-api run studio
pnpm --filter @orchestrator/db-api run migrate:deploy
pnpm --filter @orchestrator/smoke-test run smoke   # requires BLOSSOM_URL/RELAY_URL already up

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

- `proxy/relay` is now implemented and actively proxies Nostr relay traffic.
- `BLOSSOM_SERVERS` controls which backend blob servers `proxy/blossom` will use.
- `BACKEND_RELAYS` controls which downstream relays `proxy/relay` forwards events to.
- `db-api` (`packages/db`) is the only service with a Postgres/Prisma dependency; both proxies talk to it over HTTP via the dependency-free `packages/db-client`, so their Docker images no longer need Prisma at all.
- In local dev (`docker-compose.dev.yml`), `blossom` and `relay` both run with `network_mode: host`, so `BLOSSOM_SERVERS`/`BACKEND_RELAYS` in `.env` are reached directly via `localhost` — no `host.docker.internal`/`extra_hosts` needed. In production (`docker-compose.yml`), they instead share an NVPN sidecar's network namespace and reach storage-client backends over the mesh — see [Production: NVPN mesh](#production-nvpn-mesh).
- A single root `.env` configures everything: `db-api`, `proxy/blossom`, `proxy/relay` (each resolves it via an explicit `dotenv` path pointing at the repo root, regardless of which package's script you run it from), and `docker-compose.yml` itself. `PORT` reads are namespaced per service (`DB_API_PORT`, `BLOSSOM_PORT`, `RELAY_PORT`) so all three can share the one file without colliding.
