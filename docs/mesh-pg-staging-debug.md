# mesh-PG staging debug & deploy notes (2026-09-07)

Context: reported symptom was "write to the orchestrator should show up on the
provider, but it isn't." Goal was a working nostream relay at
`relay.stg.formstr.app` backed by mesh-PG.

## TL;DR

- **Writes WERE propagating the whole time.** The `deploytest`/`meshok` tables
  and rows written through the gateway are on the provider. The thing that made
  it *look* broken was a bug in `/pg/health` that always reported `tables:[]`.
- **Fixed and deployed to the provider:** the health false-empty bug and an
  intermittent `pg_type` create race in the pg-agent.
- **Gateway fix (pushed, not yet deployed to staging):** valid `INSERT` command
  tag so ORM clients (knex/node-pg → nostream) can read `rowCount`.
- **Relay is NOT up yet.** nostream v3's event pipeline does not send writes to
  the DB in this setup — an issue *internal to nostream*, not mesh-PG (the
  gateway is reachable and functional from nostream's network). Details + next
  steps below.

## Environment

- Staging: `ssh root@72.61.138.38` — runs `nso_pg_gateway`, `nso_db` (db-api
  :4000), `nso_postgres` (orchestrator, user/db `orchestrator`), `nso_nvpn`
  (WireGuard tunnel; the gateway shares its netns), `nso_relay` (the existing
  proxy relay at :8007, NOT nostream).
- Provider: `ssh dobby@201:a86:5a4f:108b:f327:9228:fa31:9047` — runs
  `storage-client-pg-agent-1` + `storage-client-mesh-postgres-1` (user/db
  `mesh`). Registry tunnelIp `10.44.160.190:3300`.
- Gateway is reached on staging at `127.0.0.1:55432` / `172.17.0.1:55432`
  (published by `nso_nvpn`). Gateway password: env `PG_GATEWAY_PASSWORD` on
  `nso_pg_gateway` (currently `784ea…`). DB name for clients: `meshdb`, any user.
- Repos on the boxes are on branch `decentralized-pg`:
  - provider: `/home/dobby/nostr-storage-orchestrator`
  - staging gateway/stack: found via container labels (compose working_dir).

## Bug 1 — /pg/health always reported `tables:[]` (the red herring)  ✅ FIXED

`health.ts` filtered bookkeeping tables with `tablename NOT LIKE '\_%'`. In a JS
tagged template `'\_%'` collapses to `'_%'` (the backslash is dropped), so the
query became `NOT LIKE '_%'` which excludes **every** non-empty table name —
health always returned an empty list even though tables existed. Switched to a
POSIX regex `tablename !~ '^_'`. (commit `11ec689`)

## Bug 2 — pg_type create race in the pg-agent  ✅ FIXED

`/pg/health`, `/pg/schema`, `/pg/apply` each ran `CREATE TABLE IF NOT EXISTS
_mesh_pg_*`. Concurrent `CREATE TABLE IF NOT EXISTS` is not atomic against
`pg_type` and intermittently failed with
`duplicate key value violates unique constraint "pg_type_typname_nsp_index"`,
wedging schema applies. Now the bookkeeping tables are created **once at
startup** (`ensureMeshSchema` in `main.ts`, with retry) and the per-request /
per-txn creates are removed. (commit `11ec689`)

## Bug 3 — INSERT command tag  ✅ FIXED (pushed, deploy to staging pending)

Postgres's `INSERT` tag is `INSERT <oid> <rows>` (oid 0). pgwire rendered
`INSERT <rows>`; node-pg/knex log "could not interpret result from server:
INSERT 1" and report no `rowCount`. nostream's `create()` reads `rowCount`.
`command_tag()` now forces `INSERT 0 <rows>`. (commit `b9df725`)

## Deploy status

- Provider pg-agent: **redeployed** (`git pull` → `docker compose build pg-agent`
  → recreate). `/pg/health` now lists `notes, events, deploytest, meshok`.
- Staging gateway (`nso_pg_gateway`): **NOT yet redeployed** with `b9df725`.
  To deploy: on staging, in the repo working dir, `git pull` then rebuild +
  recreate the `pg-gateway` service.

## Verified working (mesh-PG core)

```
# through the gateway (from staging tunnel netns):
psql host=127.0.0.1 port=5432 user=test dbname=meshdb password=<PG_GATEWAY_PASSWORD>
  CREATE TABLE meshok(id text primary key, note text);
  INSERT INTO meshok VALUES ('e2e','propagation works');
# provider:
docker exec storage-client-mesh-postgres-1 psql -U mesh -d mesh -c "SELECT * FROM meshok"  -> e2e | propagation works
# provider health lists it:
GET 10.44.160.190:3300/pg/health -> {"status":"ok","version":1,"tables":[...,"meshok"]}
```

## BLOCKER — nostream relay does not write  ❌ OPEN

Ran nostream v3.0.0 (`nostream-mesh-nostream` image, `/home/drogon/Dev/nostream`)
against the local mesh-PG (identical topology): DB via env `DB_HOST=<gateway>
DB_USER=nostr DB_PASSWORD=x DB_NAME=meshdb`, redis sidecar, `.nostr` config.

- Migrations 1–24 apply fine through the gateway (exclude #25, the FDW/partition
  migration).
- Publishing an event with `nak` connects OK but **times out with no OK**, and
  **no row reaches the DB**.
- The gateway shows **no connection or query from nostream** for the event.
  nostream logs **nothing** for the event (even at DEBUG / single worker).
- **Not mesh-PG:** from nostream's own network the gateway is reachable and auth
  works (`psql host=test_pg_gateway … SELECT …` succeeds), and knex migrations
  run through it. So nostream's event pipeline is not issuing the write.

Ruled out: worker count (tried cluster auto and `workers.count: 1`), redis
reachability (PONG), DB reachability/auth, DB config source (nostream reads
`process.env.DB_HOST`, set correctly).

**DEFINITIVE ISOLATION:** ran the same `nostream-mesh-nostream` image + `.nostr`
config against a **plain postgres** (its own `nostr_ts_relay` DB, migrations
1–24 applied, `events` table present). Publish **still** times out, `events`
stays at 0, and nostream logs nothing. So the event pipeline is broken
**independent of the database** — this is a nostream image/config problem, NOT
mesh-PG, NOT the gateway, NOT any of the changes in this branch. The nostream
worker never even attempts a DB write. Debug where the WS `["EVENT",…]` message
is dropped between the cluster primary and the worker handler, or which `.nostr`
`limits`/admission setting silently rejects it. This is a nostream-side task.

### Next steps to try (relay)
1. Confirm nostream's **knex pool actually connects** to the gateway — add
   `pool.afterCreate`/`acquireConnectionTimeout` logging, or check whether the
   pool init query hangs on the gateway. The gateway had no inbound connection
   from nostream at all, which points at pool init, not the insert itself.
2. Try nostream's own postgres (not mesh-PG) to confirm the SAME image/config
   publishes at all — isolates nostream-config vs mesh-PG. (Earlier the provider
   already had a nostream schema from some prior run, so it has worked before.)
3. If nostream connects but the insert hangs: capture the exact SQL nostream
   sends (gateway DEBUG logs the statement) and reproduce it via `psql`.
4. Once nostream writes: host it at `relay.stg.formstr.app` by pointing nginx
   `proxy_pass` (currently `127.0.0.1:8007` → `nso_relay`) at the nostream port,
   and reload nginx. WebSocket upgrade headers are already in the vhost.

## Secondary bug — schema catch-up not idempotent  ❌ OPEN (gateway)

The gateway's catch-up loop re-sends migrations to providers and fails on
non-idempotent DDL: `column "event_delegator" of relation "events" does not
exist` (migration `20240111…remove_delegator` replayed after the column was
already dropped). Root cause is the migration versioning: every `CREATE TABLE`
gets `version = 1` (hardcoded in `central.create_table`), so `migrations_since`
and the per-provider `_mesh_pg_migrations` id-dedup don't order/skip correctly.
Not blocking the write path; should be fixed before multi-table schemas are
propagated to late-joining providers. Fix direction: give each migration a
monotonic version, and/or make provider DDL replay tolerant of "does not exist"
on DROP the same way it tolerates "already exists" on CREATE.

## Monitoring commands (staging + provider)

```
# gateway logs
ssh root@72.61.138.38 'docker logs -f nso_pg_gateway'
# orchestrator write buffer / placement
ssh root@72.61.138.38 "docker exec nso_postgres psql -U orchestrator -d orchestrator -c 'SELECT * FROM pg_write_op' -c 'SELECT table_name,row_id,replicas,state FROM pg_placement'"
# provider tables / rows
ssh dobby@<ygg> "docker exec storage-client-mesh-postgres-1 psql -U mesh -d mesh -c '\dt'"
# provider health
ssh root@72.61.138.38 'docker run --rm --network container:nso_nvpn postgres:16-alpine sh -c "wget -qO- http://10.44.160.190:3300/pg/health"'
```
