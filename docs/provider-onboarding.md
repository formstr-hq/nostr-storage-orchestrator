# mesh-PG provider onboarding runbook

How to add a storage provider as a **Postgres database node** of the mesh.

A provider is an independent machine running the `storage-client` stack. The
mesh-PG gateway (orchestrator) makes it look like one table in one Postgres:
rows are **exclusively placed** on one node (hash of the pk — no replication),
reads fan out to the node that owns the rows, and the gateway merges
aggregates map-reduce style.

```
client (psql/pgweb/nostream)
   │  postgres wire
   ▼
pg-gateway (orchestrator, port 5432)
   │  HTTPS /pg/* + provider token            │ reads registry/placement/buffer
   ▼                                          ▼
pg-agent on provider :3300          orchestrator Postgres (registry, buffer, placement)
   │
   ▼
provider Postgres (mesh DB)
```

## Prerequisites

- A Linux host reachable from the orchestrator over the mesh network
  (Yggdrasil / nvpn sidecar). The orchestrator only ever needs to reach the
  provider; the provider never needs an inbound port from the internet.
- Docker + docker compose v2 on the provider host.
- A nostr keypair for the provider (npub identifies it everywhere; nsec is
  the provider's local secret).

## 1. Check out the branch

```bash
git clone https://github.com/formstr-hq/nostr-storage-orchestrator.git
cd nostr-storage-orchestrator
git checkout decentralized-pg
```

## 2. Configure the provider

`storage-client/.env` (see `.env.example`):

```bash
STORAGE_NPUB=npub1...            # provider identity
STORAGE_NSEC=nsec1...            # local signing key (never leaves the host)
PG_PROVIDER_TOKEN=<random hex>   # /pg/* endpoints auth; must match the value
                                 # the orchestrator passes as PG_PROVIDER_TOKEN
MESH_POSTGRES_PASSWORD=<random>  # provider-local postgres superuser
```

Generate tokens: `openssl rand -hex 24`.

## 3. Start the stack

```bash
cd storage-client
docker compose up -d
```

This starts (at minimum) `pg-agent` (:3300), the local `mesh-postgres`
(:5432 internal), and the `nvpn` Yggdrasil sidecar. Verify:

```bash
docker compose ps
docker logs pg-agent --since 1m      # "pg-agent listening on 0.0.0.0:3300"
```

Note the provider's mesh IP (shown by the nvpn container, or
`docker exec storage-client-nvpn-1 ip -6 addr show tun0`).

## 4. Register the provider with the orchestrator

On the **orchestrator host**, the gateway discovers providers via the
registry. Register the provider's mesh endpoint:

```bash
# register (idempotent)
curl -s http://127.0.0.1:8080/providers \
  -H 'Content-Type: application/json' \
  -d '{"npub":"'"$STORAGE_NPUB"'","url":"http://<provider-ygg-ip>:3300"}'

# or via the orchestrator container (name may differ per deployment):
docker exec nso_admin curl -s http://control-plane:3000/providers -d '...'
```

The registry row is what `pg-gateway` fans out to; the `/pg/health` probe
verifies the endpoint before reads are routed.

## 5. Verify

From the orchestrator host:

```bash
# health (table list proves the pg-agent + provider postgres work)
docker run --rm --network container:nso_nvpn postgres:16-alpine \
  sh -c "wget -qO- --header='Authorization: Bearer $PG_PROVIDER_TOKEN' \
  http://<provider-ygg-ip>:3300/pg/health"
# -> {"status":"ok","version":1,"tables":[...]}

# end-to-end: write through the gateway, confirm exclusive placement
PGPASSWORD=<gateway password> psql -h <gateway host> -p 5432 -U mesh -d meshdb \
  -c "INSERT INTO notes (id, title) VALUES (gen_random_uuid(), 'hello')"
```

Rows distribute by `hash(pk)` — one provider owns each row exclusively:

```sql
-- on the gateway
SELECT * FROM notes;                       -- merged across all nodes
-- on the provider
SELECT count(*) FROM notes;                -- its exclusive slice only
```

## 6. What the gateway handles for you

| Concern | How |
|---|---|
| Schema/migrations | gateway mirrors DDL to the catalog and replays migrations to late-joining providers (`/pg/schema`), tolerating both "already exists" and "does not exist" replays |
| Writes | executed against the orchestrator buffer with `RETURNING *`, then applied to the owning provider (`/pg/apply`) |
| Reads | point reads route to the owning node; everything else fans out |
| Aggregates | providers compute partials (`count/sum/avg/min/max/count(distinct)/variance/stddev`, GROUP BY/DISTINCT/HAVING/ORDER BY/LIMIT), the gateway merges |
| JOINs | pushed down, correct for co-located tables (e.g. trigger-derived `event_tags`) |
| Legacy orchestrator tables | read-only through the orchestrator DB fallback |

## Known limits (v0)

- Aggregates over JOINs and aggregates inside expressions are rejected.
- UNION/CTE/window/locking clauses are rejected.
- A row lives on exactly one provider — a provider going down loses access to
  its slice until it recovers (by design; replication is future work).
- Unflushed buffer writes are not visible to aggregates until the dispatcher
  flushes (sub-second window).

## Related docs

- `docs/DEPLOY_STAGING_NOSTREAM_MESHPG.md` — full staging deployment
- `docs/mesh-pg-staging-debug.md` — staging debug log and diagnostics
- `docs/pg-explorer-deploy.md` — pgweb + NIP-98 admin UI on top of the gateway