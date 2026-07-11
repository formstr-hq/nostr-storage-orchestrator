# nostr-storage-orchestrator

A pnpm workspace for a Nostr-aware storage orchestrator. It combines a blob proxy, a WebSocket Nostr relay proxy, and backend storage services with PostgreSQL persistence — accessed through an internal, thin DB-as-a-service layer (`db-api`) rather than a shared in-process client.

## Architecture

```
Client
  │  Authorization: Nostr <base64-signed-event>
  ▼
proxy/blossom  ──► db-api (HTTP, internal-only) ──► PostgreSQL
  │
  ├──► blossom blob backends (configured via BLOSSOM_SERVERS)
  └──► ...

Client
  │  WebSocket Nostr relay protocol
  ▼
proxy/relay  ──► backend relays (configured via BACKEND_RELAYS)
  └──► db-api (HTTP, internal-only) ──► PostgreSQL
```

`db-api` is a thin data layer: it performs CRUD reads/writes and keeps two-table writes atomic (e.g. creating a blob and bumping a user's `usedStorage` in one transaction), but it holds **no business logic**. Quota enforcement, duplicate-handling, and ownership checks all live in the proxies, exactly as before — only the Prisma calls moved behind HTTP. `db-api` is never exposed publicly (compose-internal network only) and has no auth layer.

## Components

### `packages/db` (`@orchestrator/db-api`)

- Prisma schema, migrations, and generated client — the only service that touches Postgres directly
- Express HTTP server exposing plain CRUD endpoints for `User`, `Blob`, `RelayEvent`, plus `GET /plans` for the static `PLAN_CONFIG` data
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

- accepts NIP-42-style `AUTH` handshake messages
- validates relay auth events against a challenge and `PUBLIC_URL`
- tracks client subscriptions and forwards `REQ` queries
- accepts signed `EVENT` writes and enforces plan upload constraints
- publishes events to healthy backend relays
- records relay events and storage reservations via `db-api`

### `storage-client`

Dockerised backend services used for local testing:

- `blossom` — raw blob server with upload, health, and storage endpoints (routes: `/upload`, `/blob/:hash` for both download and delete, `/health`, `/storage`)
- `strfry` — deployed via Docker Compose as a backend relay

### `packages/smoke-test`

Protocol-level checks driven over real HTTP/WebSocket connections — signs Nostr events with `nostr-tools`, exercises the full `proxy/blossom` REST API and `proxy/relay` WebSocket protocol (AUTH, EVENT, REQ, kind-5 delete) against a live stack. See [Smoke testing](#smoke-testing) below.

## Plan rules

| Plan | Storage limit | Max upload size | Replica count |
|---|---|---|---|
| `FREE` | 15 GB | 50 MB | 1 |
| `BASIC` | 50 GB | 500 MB | 3 |
| `PRO` | 100 GB | 2 GB | 5 |

## Database schema

- `User` — `npub` (PK), `plan`, `usedStorage`, `createdAt`
- `Blob` — `hash` (PK), `npub`, `size`, `replicas`, `createdAt`
- `RelayEvent` — `eventId` (PK), `npub`, `kind`, `size`, `replicas`, `createdAt`

`usedStorage` and `size` are `BigInt` in Postgres; `db-api` serializes them as decimal **strings** over HTTP (JSON can't carry `BigInt`). `packages/db-client` types these fields as `string`; proxies convert with `Number(...)` where needed, same as before.

## `db-api` endpoints

All internal-only, no auth. `size`/`usedStorage` are decimal strings. `db-api` only ever returns data-integrity errors (`404` missing row, `409` duplicate id) — it never rejects for quota reasons; that decision belongs to the proxies.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | compose healthcheck |
| GET | `/plans` | static `PLAN_CONFIG` data |
| GET / PUT | `/users/:npub` | read / upsert |
| GET | `/blobs/:hash` | read |
| POST | `/blobs` | atomically creates the blob row and increments `usedStorage` |
| DELETE | `/blobs/:hash` | atomically deletes and decrements `usedStorage` |
| GET | `/relay-events/:eventId` | read |
| POST | `/relay-events` | atomically creates the row and increments `usedStorage` |
| POST | `/relay-events/:eventId/rollback` | idempotent delete + decrement |
| PATCH | `/relay-events/:eventId` | sets `replicas` |
| DELETE | `/relay-events/:eventId` | plain delete, **no** decrement (matches relay's kind-5 semantics) |

## Prerequisites

- Node.js 20+
- pnpm
- Docker + Docker Compose
- PostgreSQL database (the root `docker-compose.yml` provisions one; bring your own by editing `packages/db/.env`)

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Prepare the database

1. Copy and edit the `db-api` env file:

```bash
cp packages/db/.env.example packages/db/.env
```

```bash
DATABASE_URL="postgresql://orchestrator:orchestrator@localhost:5435/orchestrator"
PORT=4000
```

2. Copy and edit the blossom proxy env file:

```bash
cp proxy/blossom/.env.example proxy/blossom/.env
```

```bash
DB_API_URL=http://localhost:4000
PORT=3001
BLOSSOM_SERVERS=http://localhost:3000
```

> `BLOSSOM_SERVERS` must list one or more backend blossom URLs separated by commas.

### 3. Generate Prisma client

```bash
pnpm --filter @orchestrator/db-api run generate
```

### 4. Run Prisma migrations

```bash
pnpm --filter @orchestrator/db-api run migrate:deploy
```

### 5. Start storage backends

The `storage-client` layer has its own Docker Compose configuration and is kept separate from the main orchestrator stack.

```bash
cd storage-client
./scripts/start.sh
```

This brings up the local `blossom` backend and the backend relay service.

### 6. Run everything else with Docker

The root `docker-compose.yml` runs PostgreSQL, `db-api`, `proxy/blossom`, and `proxy/relay` together. `db-api` is internal-only — it isn't published to the host, only `postgres`, `blossom`, and `relay` are.

1. Create env files.

```bash
cp .env.example .env
cp packages/db/.env.example packages/db/.env
cp proxy/blossom/.env.example proxy/blossom/.env
cat > proxy/relay/.env <<'EOF'
DB_API_URL=http://localhost:4000
PORT=8007
PUBLIC_URL="ws://localhost:8007"
BACKEND_RELAYS=ws://localhost:7777
EOF
```

> The root `.env` (from `.env.example`) is what `docker-compose.yml` itself reads: Postgres credentials, `BLOSSOM_SERVERS`/`BACKEND_RELAYS`, and each service's port. It always wins inside Docker — `docker-compose.yml` uses it to override `DATABASE_URL` on the `db` service (pointed at the compose-managed `postgres`) and `DB_API_URL`/`BLOSSOM_SERVERS`/`BACKEND_RELAYS`/`PORT` on the proxies. The per-service `.env` files above are for local (non-Docker) dev and anything else those services read.

2. Start the Docker stack:

```bash
docker compose up --build
```

3. Confirm services are running:

- `proxy/blossom` on `http://localhost:3001`
- `proxy/relay` on `ws://localhost:8007`
- `db-api` and PostgreSQL are reachable only from other containers on the compose network (`http://db:4000`, `postgres:5432`), not from the host — uncomment the `ports:` mapping on the `postgres` service in `docker-compose.yml` if you need direct access (e.g. for `prisma studio`)

### 7. When using `storage-client`

Keep `storage-client` running in its own Docker environment. In one terminal:

```bash
cd storage-client
./scripts/start.sh
```

Then use the main orchestrator Docker stack for `blossom`, `relay`, and `db`.

## `proxy/blossom` API

All endpoints expect `Authorization: Nostr <base64-encoded-signed-nostr-event>`.

| Method | Path | Description |
|---|---|---|
| GET | `/storage` | Returns storage usage, available bytes, and current plan |
| POST | `/upload` | Uploads raw blob bytes (`Content-Type: application/octet-stream`) |
| GET | `/download/:hash` | Downloads blob contents by SHA-256 hash |
| DELETE | `/delete/:hash` | Deletes a blob and decrements user storage |

### Example auth header

The proxy expects a base64-encoded JSON event object signed with Nostr keys. The service verifies the event signature and derives `npub` from the event pubkey.

## `proxy/relay` behavior

- Listens for WebSocket clients at `ws://localhost:8007` by default.
- Sends an initial `AUTH` challenge to clients.
- Accepts `AUTH`, `EVENT`, `REQ`, and `CLOSE` messages.
- Validates event signatures and publishes approved writes to backend relays.

## Smoke testing

`scripts/docker-smoke-test.sh` brings up the full stack in Docker (starting `storage-client`'s backends first if they aren't already running) and drives the real HTTP/WebSocket protocols end to end via `packages/smoke-test`:

```bash
./scripts/docker-smoke-test.sh
```

It creates missing `.env` files from their `.example` counterparts, waits for `postgres`/`db`/`blossom`/`relay` to become reachable, then checks: blossom auth rejection, storage accounting, upload/download/delete round-trips; and relay's NIP-42 AUTH handshake, unauthenticated-write rejection, event publish, `REQ`/`EOSE`, and kind-5 deletion. By default it tears the root `docker-compose.yml` stack down afterward (`storage-client`'s backends are left running for reuse); set `KEEP_UP=1` to leave the root stack up too for manual poking.

## Workspace commands

```bash
pnpm --filter @orchestrator/db-api run dev
pnpm --filter @orchestrator/blossom run dev
pnpm --filter @orchestrator/relay run dev
pnpm --filter @orchestrator/db-api run studio
pnpm --filter @orchestrator/db-api run migrate:deploy
pnpm --filter @orchestrator/smoke-test run smoke   # requires BLOSSOM_URL/RELAY_URL already up
pnpm -r run build
```

## Notes

- `proxy/relay` is now implemented and actively proxies Nostr relay traffic.
- `BLOSSOM_SERVERS` controls which backend blob servers `proxy/blossom` will use.
- `BACKEND_RELAYS` controls which downstream relays `proxy/relay` forwards events to.
- `db-api` (`packages/db`) is the only service with a Postgres/Prisma dependency; both proxies talk to it over HTTP via the dependency-free `packages/db-client`, so their Docker images no longer need Prisma at all.
- The `blossom`/`relay` containers reach `storage-client`'s host-published backends via `host.docker.internal` (see `extra_hosts` in `docker-compose.yml`); override `BLOSSOM_SERVERS`/`BACKEND_RELAYS` in the proxy `.env` files if your backends live elsewhere.
