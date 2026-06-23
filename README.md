# nostr-storage-orchestrator

A pnpm workspace that sits between Nostr clients and raw storage backends. It authenticates users via Nostr keypairs, enforces per-plan storage quotas, and fans out blob uploads across multiple replica servers.

## Architecture

```
Client
  │  Nostr auth header (NIP-98 signed event)
  ▼
proxy/blossom  ──► PostgreSQL (users, blobs, quotas)
  │
  ├──► storage-client/blossom  (port 3000)  raw file store #1
  ├──► storage-client/blossom  (port 3000)  raw file store #2  (if replicas > 1)
  └──► ...

proxy/relay  (stub — not yet implemented)
  └──► storage-client/nostream  (port 8008)  Nostr relay
```

### `proxy/blossom` — Smart blob proxy (port 3001)

TypeScript/Express service. Handles:

- **Auth** — decodes the `Nostr <base64>` header, verifies the Nostr event signature, extracts the user's `npub`
- **Quota enforcement** — checks per-plan upload size and total storage limits before forwarding
- **Replica fanout** — selects the healthiest backends ranked by free space, uploads to `replicaCount` of them
- **Metadata tracking** — stores blob hash, owner npub, size, and replica URLs in PostgreSQL

### `storage-client` — Storage backends (Docker)

Two Dockerised services launched together via `docker compose`:

| Service | Port | What it does |
|---|---|---|
| `blossom` | 3000 | Node.js blob server — stores files on disk by SHA-256 hash |
| `nostream` | 8008 | Nostr relay — cloned from `formstr-hq/nostream-share` |

### Plans

| Plan | Storage | Max upload | Replicas |
|---|---|---|---|
| FREE | 15 GB | 50 MB | 1 |
| BASIC | 50 GB | 500 MB | 3 |
| PRO | 100 GB | 2 GB | 5 |

### Database schema

```
User   npub (PK), plan, usedStorage, createdAt
Blob   hash (PK), npub (FK → User), size, replicas[], createdAt
```

---

## Prerequisites

- Node.js 20+
- pnpm
- Docker + Docker Compose
- PostgreSQL database (Neon or local)

---

## Local setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start storage backends

```bash
cd storage-client
./scripts/start.sh
```

This builds and starts the blossom blob server (port 3000) and the nostream Nostr relay (port 8008).

### 3. Start PostgreSQL

```bash
cd proxy/blossom
docker compose up -d
```

This launches a local PostgreSQL instance on port 5435 (`POSTGRES_USER/PASSWORD/DB`: `orchestrator`).

### 4. Configure the blossom proxy

```bash
cp proxy/blossom/.env.example proxy/blossom/.env
```

Edit `proxy/blossom/.env` and fill in your PostgreSQL connection string:

```
DATABASE_URL="postgresql://orchestrator:orchestrator@localhost:5435/orchestrator"
PORT=3001
```

### 5. Generate the Prisma client

```bash
pnpm --filter @orchestrator/blossom exec prisma generate
```

### 6. Run database migrations

```bash
pnpm --filter @orchestrator/blossom exec prisma migrate deploy
```

### 7. Start the blossom proxy

```bash
# Development (tsx)
pnpm --filter @orchestrator/blossom run dev

# Production (compiled)
pnpm --filter @orchestrator/blossom run build
pnpm --filter @orchestrator/blossom run start
```

The proxy is available at `http://localhost:3001` (or the `PORT` set in `.env`).

---

## API

All endpoints require a `Authorization: Nostr <base64-encoded-signed-nostr-event>` header.

| Method | Path | Description |
|---|---|---|
| GET | `/storage` | Returns used/total/available bytes and current plan for the authenticated user |
| POST | `/upload` | Upload a blob (`Content-Type: application/octet-stream`). Returns `{ hash, replicas, size }` |
| GET | `/download/:hash` | Download a blob by its SHA-256 hash |
| DELETE | `/delete/:hash` | Delete a blob and decrement the user's used storage |

---

## Workspace commands

```bash
# Run a script in one package
pnpm --filter @orchestrator/blossom run dev

# Run a command (e.g. prisma) in one package
pnpm --filter @orchestrator/blossom exec prisma migrate deploy

# Build all packages
pnpm -r run build
```

---

## Notes

- `proxy/relay` is a stub — the Nostr relay proxy is not yet implemented.
- Backend server URLs are hardcoded in `proxy/blossom/src/servers.ts`. Update `BLOSSOM_SERVERS` to point to your actual blob store instances before running in production.
