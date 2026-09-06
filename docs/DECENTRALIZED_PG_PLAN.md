# Plan: Decentralized Postgres Layer (Mesh Structured Storage)

## Status

Implementation - 04.09.2026

Implemented (v0):

- `pg-gateway` (Rust, `pg-gateway`): pgwire server
  (simple + extended query), SQL subset analysis, write buffer + dispatcher,
  placement index, fan-out read engine, schema manager with late-joiner
  catch-up.
- `pg-agent` (Deno, `storage-client/pg-agent`): `/pg/apply`, `/pg/query`,
  `/pg/schema`, `/pg/health` over the provider's local postgres.
- `postgres` + `pg-agent` services in both storage-client compose files;
  `pgAgentPort` on `Storage` (ping payload, registry routes, db-client).
- Prisma models: `PgTable`, `PgMigration`, `PgMigrationState`, `PgWriteOp`,
  `PgPlacement` (migration `20260904105017_mesh_pg`).
- Test topology: `compose.mesh-pg-test.yml` (1 orchestrator + 1 provider);
  e2e script `scripts/mesh-pg-e2e.py` (raw pgwire over TCP).
- Verified locally: CREATE TABLE propagates to the provider, INSERT is
  buffered → dispatched → applied (idempotent op log), point reads return
  read-your-writes from the buffer overlay, UPDATE/DELETE flow, fan-out
  reads merge provider rows, buffer drains to zero.

Deviation from the draft: provider mesh tables use the user's verbatim table
names (no `mesh_pg_` prefix); `pg_write_op.lastAttemptAt` maps to
`last_attempt_at` (Prisma `@map`). Gateway auth accepts cleartext with an
empty password when `PG_GATEWAY_PASSWORD` is unset (v0); set it in prod.

## Goal

Expose a regular Postgres API (wire protocol, so psql and any PG driver/ORM works)
backed by the mesh of storage providers. The orchestrator holds no long-term row
data — only a write buffer, a placement index, and the schema registry.

- Writes land in a durable write buffer on the orchestrator.
- Background workers push writes to providers, maintain the placement index
  (`row -> provider(s)`), and delete flushed entries from the buffer.
- Providers run their own Postgres instance inside the storage-client stack
  and may keep their own secondary indexes.
- Reads by primary key route through the placement index to one provider.
- Broader queries fan out to all active providers (v0).
- Schema changes are versioned at the orchestrator and propagated to all
  providers, including ones that join or come back later.

## Non-Goals (v0)

- No cross-shard JOINs. JOINs are only supported when the gateway can prove
  co-location (v0: not at all).
- No multi-row transactions. v0 writes are per-statement; each buffered write
  op is independently idempotent. BEGIN/COMMIT parse but act as no-ops around
  single statements.
- No automatic re-replication/repair when a provider dies. Placement entries
  for dead providers go `STALE` and reads skip them, same policy as blob
  replicas today. Repair is the top candidate for v1.
- No capacity-aware placement (mirrors the existing stubbed `available` in
  `proxy/blossom/src/servers.ts`).
- No provider-initiated writes. The orchestrator is the sole writer to
  providers, exactly like the blossom/relay data planes.

## Engine decision: Postgres per provider

An earlier draft of this plan put provider data in the existing LibSQL/SQLite
metadata database with gateway-side SQL translation (PG -> SQLite). That was
rejected:

- The translation layer is bounded (~3-5k LOC for the v0 subset) but its
  failure modes are *silent correctness bugs*: `LIKE` case-sensitivity differs
  between engines, `timestamptz` loses UTC-normalization as TEXT,
  `serial`/`AUTOINCREMENT` diverge for non-integer PKs, SQLite has no decimal
  arithmetic (`numeric` would be gateway-computed TEXT), and collation rules
  differ so merged `ORDER BY` can interleave wrongly.
- The performance argument for SQLite (fast point reads) is irrelevant here:
  read latency is dominated by NVPN round-trips to the provider, not engine
  choice.
- The single-writer constraint of SQLite was also irrelevant (writes arrive
  as one ordered stream from gateway workers) — but PG's MVCC makes this
  trivially safe anyway.
- Provider setup cost is the thing SQLite avoided — but providers pull and
  run a compose stack; one more `postgres` service is invisible to them.

With PG on both sides, DML and DDL pass through the gateway **verbatim**. The
gateway's job becomes subset *validation* (reject what it cannot route) rather
than subset *translation* (risking silently-mistranslated results). A second
bonus: `psql` against a provider directly works, which makes debugging and
reconciliation possible.

Costs: ~30-60MB idle RAM per provider, a PG volume in the storage-client
compose stack, and version-pinned image upgrades — all one-time automation
in the stack we already ship.

## Architecture

```
 psql / Prisma / any PG driver
        |  pgwire :5432
        v
+--------------------------------- orchestrator (host compose) ---------------------------------+
|  pg-gateway (new Rust crate)                                                                  |
|   pgwire server -> sqlparser-rs -> router                                                      |
|     | writes: append to write buffer (central PG, durable)                                     |
|     | reads: placement index or buffer merge                                                   |
|   write workers (tokio tasks)                                                                  |
|     | batch pull from buffer -> HTTP push to providers -> delete from buffer -> upsert index   |
|   schema manager: registry of versioned migrations, propagation state per provider             |
|   placement index + write buffer: tables in the central Postgres (via db-api or own schema)     |
+------------------------------------------------------------------------------------------------+
        |  HTTP over NVPN mesh (http://<tunnelIp>:<pgAgentPort>/pg/*)
        v
+---------------- providers (storage-client stacks) ----------------+
|  pg-agent (new Deno service, sibling of blossom)                  |
|    /pg/* HTTP API -> libpq to localhost postgres                  |
|  postgres (new service in storage-client compose)                 |
|    mesh tables in a dedicated database, own secondary indexes     |
+------------------------------------------------------------------+
```

### Components

| Component | Location | Notes |
| --------- | -------- | ----- |
| `pg-gateway` | new Rust crate, host compose | pgwire + sqlparser-rs + reqwest. Sibling of `control-plane-backend`, reuses its mesh/DB patterns. |
| Write buffer | central Postgres | Durable queue. Flushed rows are deleted (per requirement). |
| Placement index | central Postgres | `mesh_pg_placement`: row id -> provider npubs. The direct analogue of `replicas String[]` on `Blob`/`RelayEvent`. |
| Schema registry | central Postgres | Versioned DDL + per-provider apply state. |
| `pg-agent` | new Deno service in storage-client compose | `/pg/*` HTTP API over libpq (`postgres` npm pkg). Sibling of blossom; reuses its config/ping patterns. |
| Provider postgres | new service in storage-client compose | Dedicated database (e.g. `mesh`), mesh tables `mesh_pg_<tableId>`. Providers may add their own secondary indexes. |
| Provider registry | existing | Reuse `ServerRegistry` pattern (`proxy/blossom/src/servers.ts`): poll `GET /storages/active` every 15s. Active = ping within `ACTIVE_WINDOW_SECS`. Needs a new `pgAgentPort` column. |

## Data Model (central Postgres)

Owned by pg-gateway (new Prisma models in `packages/db/prisma/schema.prisma`,
served through db-api, so the control plane and admin app can inspect state):

```prisma
// Durable write buffer. Deleted after successful push.
model PgWriteOp {
  id          String   @id        // ULID, batch ordering key
  tableId     String              // mesh_pg table id
  op          String              // INSERT | UPDATE | DELETE
  rowId       String              // primary key value of target row
  payload     String              // JSON: full row (INSERT/UPDATE) or null (DELETE)
  createdAt   DateTime @default(now())
  retryCount  Int      @default(0)
  @@index([tableId, createdAt])
}

// Placement index: which provider(s) hold which row.
model PgPlacement {
  tableId     String
  rowId       String
  replicas    String[]            // storage npubs, ordered (primary first)
  state       String              // ACTIVE | PENDING | STALE
  updatedAt   DateTime
  @@id([tableId, rowId])
}

// Schema registry.
model PgTable {
  id          String   @id        // stable id, maps to provider table name mesh_pg_<id>
  name        String              // user-facing table name
  columnsJson String              // canonical column schema (PG types)
  version     Int
  replicaN    Int      @default(3)
}

model PgMigration {
  id          String   @id        // ULID
  ddl         String              // verbatim PG DDL, applied as-is on providers
  version     Int
  state       String              // PENDING | APPLIED
  createdAt   DateTime @default(now())
}

model PgMigrationState {
  storageNpub String
  version     Int
  appliedAt   DateTime
  @@id([storageNpub, version])
}
```

The central Postgres remains the orchestrator's brain (users, quotas, roster,
buffer, index) — it just never holds row data long-term. This is consistent
with today's design where Postgres holds blob/event metadata only.

## Row Identity

- Primary keys are user-declared (`id uuid`, `id text`, etc. in DDL).
- The gateway validates uniqueness at write time against the placement index
  (cheap point check) — the buffer-to-provider pipeline preserves it.
- ULIDs are recommended to clients but any PK type works. Content-hash PKs
  (SHA-256) get the same dedup semantics blobs already have (v1).

## Write Path

1. Client connects via pgwire (SCRAM auth; users provisioned by the control
   plane). Sends e.g. `INSERT INTO notes (id, body) VALUES ($1, $2)`.
2. Gateway parses with sqlparser-rs (PostgreSQL dialect), resolves the table
   in the registry, validates types/columns, binds params.
3. Gateway appends a `PgWriteOp` (op=INSERT, full row payload, ULID `id`) and
   upserts `PgPlacement` with `state=PENDING` and target providers already
   chosen (health-gated, like `getBestServers`; pick N of `replicaN`).
   Statement returns success to the client. Durability = the buffer.
4. Worker pool (tokio tasks, batch every ~200ms or 100 ops):
   - Pull a batch of ops ordered by `id`.
   - Group by (provider, table). For each provider, POST `/pg/apply`
     with the ordered ops. Providers apply idempotently (UPSERT semantics
     keyed on rowId; DELETEs are tombstone-tolerant).
   - On success per provider: remove the op from the buffer **only when all
     target providers acked it** (ops carry their full replica list), set
     placement `state=ACTIVE`, stamp `PgPlacement.updatedAt`.
   - On failure: `retryCount++`, exponential backoff, placement stays
     `PENDING`. After a threshold, drop the failed provider from the op's
     replica list and, if count < required, re-enqueue to a replacement
     provider (mirrors `evaluatePublication` all-or-nothing policy).
5. Read-your-writes: any read first overlays un-flushed `PgWriteOp` rows for
   the queried table (buffer is small — this is an in-memory index of it).

UPDATE/DELETE in v0 must have a primary-key predicate
(`WHERE id = $1`); the gateway rewrites the row via the same op pipeline
(op=UPDATE carries the full new row; DELETE carries rowId). Non-PK
predicates for writes are rejected with a clear error.

## Read Path

1. Parse the SELECT. Classify:
   - **Point query**: single `WHERE <pk> = $1` on a registered table.
   - **Pushdown query**: otherwise, if inside the supported subset.
2. **Point query**: buffer overlay -> `PgPlacement` -> pick first ACTIVE
   replica -> GET `/pg/query?table=...&id=...` on that provider. Fall
   through to next replica on failure (same as `downloadBlob` today).
3. **Pushdown query**: fan out to all active providers concurrently
   (`/pg/query` with the verbatim PG SELECT + params), merge results at the
   gateway, dedupe by pk (providers may briefly hold divergent copies;
   pick the row with the highest write ULID if we tag rows with it —
   simpler v0: first response wins, since a single ordered stream per
   provider makes divergence rare), overlay the buffer, stream back as PG
   rows.
4. Unsupported constructs (JOINs, subqueries, aggregates beyond the subset)
   return `feature_not_supported` with a message naming the limitation.

Pushdown subset for v0: `SELECT <cols|*> WHERE <conj of simple preds>`,
`ORDER BY`, `LIMIT`/`OFFSET`, simple aggregates (`COUNT`, `SUM`, `MIN`,
`MAX`, `AVG`) computed at the gateway by merging per-provider partials.
The subset exists for *routing and merge correctness* (the gateway must
understand the query to merge results), not for translation — statements
inside the subset are forwarded to providers verbatim.

## Provider API (pg-agent routes)

All under `/pg/*` on a new `pgAgentPort` (sibling of `blossomPort` in the
storage-client stack, reachable only over the mesh). Requests from the
gateway arrive over NVPN like proxy traffic. Auth: shared token issued
during enrollment (v0), upgradeable to per-node signed requests (NIP-98)
later. pg-agent talks to the local postgres over libpq (unix socket or
localhost TCP, never exposed).

| Endpoint | Method | Body | Semantics |
| -------- | ------ | ---- | --------- |
| `/pg/apply` | POST | `{ ops: [{ id, table, op, rowId, row }] }` | Ordered, idempotent batch (UPSERT keyed on rowId; DELETEs tombstone-tolerant). 200 = all applied. Partial failure = 500 + applied-set in response. |
| `/pg/query` | POST | `{ sql, params }` (verbatim PG SELECT) | Returns rows as JSON. |
| `/pg/schema` | POST | `{ migrations: [{ id, version, ddl }] }` | Applies missing versions inside a transaction each; responds with current version. Also called on the ping-time handshake. |
| `/pg/health` | GET | - | Detail beyond `/health`: table versions, row counts (for reconciliation later). |

Provider storage: every mesh table lives as `mesh_pg_<tableId>` in the
provider's `mesh` postgres database, created by propagated migrations.
Providers are free to add their own secondary indexes on these tables —
user-requested indexes are propagated DDL; provider-local optimizations
are their business (this is the "providers may have their own indexes"
requirement).

## Migrations and Table Changes

1. Client (or admin) sends DDL through a pgwire session or a control-plane
   endpoint: `CREATE TABLE notes (...)`, `ALTER TABLE notes ADD COLUMN ...`,
   `CREATE INDEX ...`.
2. Schema manager parses and validates it against the supported DDL subset,
   bumps the table/registry version, stores the verbatim PG DDL,
   state=PENDING.
3. Workers push `/pg/schema` to all active providers. Each success stamps
   `PgMigrationState`. Version flips to APPLIED when all *active* providers
   acked.
4. Late joiners: on every registry refresh, the gateway checks
   `/pg/health` versions; any provider lagging gets a `/pg/schema`
   catch-up before it accepts writes or answers queries (precedent: the
   `backfill-replicas` handshake after first ping,
   `packages/db/src/routes/storages.ts`).
5. v0 is additive-only: CREATE TABLE/INDEX, ADD COLUMN. Destructive
   changes (DROP COLUMN, type changes) are rejected with a clear error —
   they need table rebuilds and row migration across providers, deferred
   to v1.

Because both sides speak Postgres, migrations apply verbatim — no DDL
translation, no type mapping. The gateway only validates the subset and
tracks versions.

## Failure Semantics

| Failure | Behavior |
| ------- | -------- |
| Provider down at write time | Ops backoff-retry; placement PENDING; if down past `ACTIVE_WINDOW_SECS`, a replacement provider is chosen for that op. |
| Provider down at read time | Point reads fall to next replica. Fan-out reads collect from whoever answers; slow providers skipped after a timeout (per-relay pool precedent). |
| Gateway crash | Buffer is durable in PG; workers resume. Providers are untouched. |
| Provider loses data | v0: placement rows go STALE on version/health mismatch detection later; no repair (non-goal). |
| Duplicate delivery | `/pg/apply` ops are idempotent (UPSERT by rowId, DELETE tombstone-tolerant). |

## Deployment

- New `pg-gateway` service in root `docker-compose.yml`, following the
  `admin` service pattern (`network_mode: "service:nvpn"` for mesh egress;
  publish pgwire on `127.0.0.1:5432` or behind the public proxy as
  appropriate).
- New Prisma models + migration in `packages/db`, plus a `pgAgentPort`
  column on `Storage` (ping payload and registry routes updated).
- New services in `storage-client/docker-compose.yml`: `pg-agent` (Deno,
  sibling of blossom) and `postgres` (version-pinned image, dedicated
  `mesh` database, its own volume, credentials internal to the stack).
  pg-agent config: `meshPg.enabled`, `meshPg.port`, `meshPg.token`.
- storage-agent ping extended to carry `pgAgentPort` (one field, same
  signed report).

## Implementation Phases

1. **Core plumbing**: Prisma models + `pgAgentPort`, `pg-agent` service
   (`/pg/apply`, `/pg/schema`, `/pg/query`) with its postgres, gateway
   skeleton with registry polling.
2. **Write path**: pgwire INSERT/UPDATE/DELETE-by-id -> buffer -> workers ->
   placement index; read-your-writes overlay.
3. **Read path**: point routing, then pushdown fan-out + merge.
4. **Migrations**: DDL validation, propagation, late-joiner catch-up.
5. **E2E**: extend `packages/smoke-test` — psql connects, creates table,
   writes, kills a provider, reads survive via replica; late-joining
   provider converges.

## Open Questions

- ~~Server-generated values diverge across replicas~~ **RESOLVED
  (04.09.2026).** The gateway is now the sole id/value authority: CREATE
  TABLE registers column descriptors (`default: SERIAL | UUID | NOW |
  literal`), and the write path materializes the **full row** at enqueue —
  serial -> per-column central sequence (`mesh_pg_seq_<table>_<column>`),
  `gen_random_uuid()` -> ULID, `now()` -> gateway clock. INSERTs without an
  explicit pk get a gateway-allocated id, and `RETURNING id/...` is
  synthesized from the buffer before any provider is touched. Propagated
  DDL is rewritten on providers (`stripServerGenerators` in pg-agent):
  serial -> plain integer, identity clauses and nextval/uuid/now defaults
  removed — providers hold zero sequences for mesh tables, so replicas
  cannot diverge. Client-supplied values always win over defaults.
- Placement fan-out read consistency: add a monotonic write seq to rows
  and dedupe by max-seq? (Cheap to add now; recommended before v1.)
- Should `usedStorage`/plan quotas apply to mesh-PG bytes, or stay
  blob/event-only for v0?
- Multi-tenant table naming: prefix by user npub, or one shared namespace
  with row-level ownership?
- Gateway auth: provision PG users through the control plane roster
  (members already exist) — which roles map to which PG privileges?