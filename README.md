# nostr-storage-orchestrator

A pnpm workspace for a Nostr-aware storage orchestrator. It combines a blob proxy, a WebSocket Nostr relay proxy, and backend storage services with PostgreSQL persistence.

## Architecture

```
Client
  │  Authorization: Nostr <base64-signed-event>
  ▼
proxy/blossom  ──► PostgreSQL (@orchestrator/db)
  │
  ├──► blossom blob backends (configured via BLOSSOM_SERVERS)
  └──► ...

Client
  │  WebSocket Nostr relay protocol
  ▼
proxy/relay  ──► backend relays (configured via BACKEND_RELAYS)
  └──► PostgreSQL (@orchestrator/db)
```

## Components

### `packages/db`

- Prisma schema and generated client for shared persistence
- Models: `User`, `Blob`, `RelayEvent`
- Shared `Plan` enum used by both proxies

### `proxy/blossom`

TypeScript/Express service that:

- validates Nostr auth events from `Authorization: Nostr ...`
- resolves `npub` from the signed event
- enforces plan quotas and upload size limits
- selects healthy backend blossom servers
- uploads blob data to `replicaCount` backends
- stores blob metadata and user storage usage in PostgreSQL
- supports download and delete operations for authenticated owners

### `proxy/relay`

TypeScript/Express + WebSocket Nostr relay proxy that:

- accepts NIP-42-style `AUTH` handshake messages
- validates relay auth events against a challenge and `PUBLIC_URL`
- tracks client subscriptions and forwards `REQ` queries
- accepts signed `EVENT` writes and enforces plan upload constraints
- publishes events to healthy backend relays
- records relay events and storage reservations in PostgreSQL

### `storage-client`

Dockerised backend services used for local testing:

- `blossom` — raw blob server with upload, health, and storage endpoints
- `strfry` — deployed via Docker Compose as a backend relay

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

## Prerequisites

- Node.js 20+
- pnpm
- Docker + Docker Compose
- PostgreSQL database

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Prepare the database

1. Create a local PostgreSQL database.
2. Copy and edit the blossom proxy env file:

```bash
cp proxy/blossom/.env.example proxy/blossom/.env
```

3. Set `DATABASE_URL` in `proxy/blossom/.env`:

```bash
DATABASE_URL="postgresql://orchestrator:orchestrator@localhost:5435/orchestrator"
PORT=3001
BLOSSOM_SERVERS=http://localhost:3000
```

> `BLOSSOM_SERVERS` must list one or more backend blossom URLs separated by commas.

### 3. Generate Prisma client

```bash
pnpm --filter @orchestrator/db run generate
```

### 4. Run Prisma migrations

```bash
pnpm --filter @orchestrator/db run migrate:deploy
```

### 5. Start storage backends

The `storage-client` layer has its own Docker Compose configuration and is kept separate from the main orchestrator stack.

```bash
cd storage-client
./scripts/start.sh
```

This brings up the local `blossom` backend and the backend relay service.

### 6. Run everything else with Docker

The root `docker-compose.yml` runs the database, `proxy/blossom`, and `proxy/relay` together.

1. Create env files for both proxies.

```bash
cp proxy/blossom/.env.example proxy/blossom/.env
cat > proxy/relay/.env <<'EOF'
DATABASE_URL="postgresql://orchestrator:orchestrator@localhost:5435/orchestrator"
PORT=8007
PUBLIC_URL="ws://localhost:8007"
BACKEND_RELAYS=ws://localhost:7777
EOF
```

2. Edit `proxy/blossom/.env` to include the backend blob server list:

```bash
DATABASE_URL="postgresql://orchestrator:orchestrator@localhost:5435/orchestrator"
PORT=3001
BLOSSOM_SERVERS=http://localhost:3000
```

3. Start the Docker stack:

```bash
docker compose up --build
```

4. Confirm services are running:

- `proxy/blossom` on `http://localhost:3001`
- `proxy/relay` on `ws://localhost:8007`
- PostgreSQL on `localhost:5435`

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

## Workspace commands

```bash
pnpm --filter @orchestrator/blossom run dev
pnpm --filter @orchestrator/relay run dev
pnpm --filter @orchestrator/db run studio
pnpm --filter @orchestrator/db run migrate:deploy
pnpm -r run build
```

## Notes

- `proxy/relay` is now implemented and actively proxies Nostr relay traffic.
- `BLOSSOM_SERVERS` controls which backend blob servers `proxy/blossom` will use.
- `BACKEND_RELAYS` controls which downstream relays `proxy/relay` forwards events to.
- The repo uses `@orchestrator/db` as a shared Prisma client dependency across both proxies.
