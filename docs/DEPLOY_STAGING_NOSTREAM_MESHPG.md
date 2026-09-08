# Deployment Guide: nostream + mesh-PG on staging

Status: ready to execute. All gateway/agent changes are done and tested.
Scope: add the mesh-PG data plane to the staging orchestrator, enroll the
first storage provider, and run nostream (its own compose, only DB
credentials point at the gateway).

Tested: the full nostream SQL surface (composite-pk table, bytea/jsonb
events, partial-index replaceable upsert, trigger-derived `event_tags`,
kind-5 broad updates, narrow-projection point reads, knex catalog traffic)
was rehearsed through a live gateway + provider pair — all pass. See the
"Rehearsed" appendix at the end.

---

## What gets deployed

| Machine | What |
|---|---|
| orchestrator host | staging stack (`/root/Servers/storage` in these examples) + new `pg-gateway` service; nostream checkout (`/root/Servers/nostream`) runs its **own** compose |
| provider (storage client) | storage-client stack (`~/nostr-storage-orchestrator/storage-client`) + new `mesh-postgres` + `pg-agent` services (already on `decentralized-pg`) |

nostream is **not** part of the orchestrator stack. It connects to the
gateway like any Postgres: host `172.17.0.1`, port `55432`, password
`PG_GATEWAY_PASSWORD`.

Two hard rules while executing:

- Never run `scripts/nvpn-mesh-e2e.sh` / `control-plane-e2e.sh` against a
  real deployment — they wipe the `nvpn_data` volumes (mesh identity +
  invites).
- Recreating the `nvpn` sidecar (steps 1 and 3) requires recreating every
  container that shares its network namespace (`blossom relay admin` on the
  orchestrator; `blossom relay mesh-postgres pg-agent` on the provider) —
  `docker restart` of those fails once the old sidecar is gone. Mesh
  identity survives in the `nvpn_data` volume; outage is brief.

---

## Step 1 — Orchestrator host: redeploy on `decentralized-pg`

```bash
ssh root@<orchestrator-host>
cd /root/Servers/storage

# backup first
docker exec nso_postgres pg_dump -U orchestrator orchestrator \
  > /root/backup-pre-meshpg-$(date +%F).sql

git fetch origin && git checkout decentralized-pg && git log --oneline -1
# expect the mesh-PG commit (93d920b or later)
git status --short   # must be clean
```

Add to `.env` (generate secrets with `openssl rand -hex 24`):

```bash
# mesh-PG data plane
PG_GATEWAY_PORT=55432
PG_GATEWAY_PASSWORD=<random>
PG_PROVIDER_TOKEN=<random>
```

Swapfile for the Rust build (1-vCPU box), then build + migrate:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

docker compose build db pg-gateway
docker compose up -d db
sleep 10
docker exec nso_db wget -qO- http://db:4739/storages/active-pg   # expect [] (200)
docker exec nso_postgres psql -U orchestrator -d orchestrator -c '\dt'
# expect: Blob, RelayEvent, User, Member, Storage, PgTable, PgMigration,
#         PgMigrationState, PgWriteOp, PgPlacement

# IMPORTANT: recreating the nvpn sidecar destroys its network namespace,
# and blossom/relay/admin live inside that namespace (network_mode:
# "service:nvpn"). They must be recreated together with it — `docker restart`
# of a namespace-sharing container fails with "No such container" against
# the replaced sidecar.
docker compose up -d --force-recreate nvpn blossom relay admin pg-gateway
swapoff /swapfile && rm /swapfile   # build done; reclaim disk
```

Verify the gateway listens (registry empty is fine at this point):

```bash
docker compose logs pg-gateway --tail 5
# expect: pg-gateway listening listen=0.0.0.0:5432
```

If the Rust build OOMs even with swap, build locally instead:
`docker buildx build --platform linux/amd64 -t nso-pg-gateway pg-gateway --load`
then `docker save nso-pg-gateway | ssh root@<orchestrator-host> 'docker load'`
and `docker compose up -d pg-gateway` (compose builds only missing images).

Note: `docker compose build db pg-gateway` + `up -d nvpn` also recreates the
nvpn sidecar (its `ports:` gained the pgwire mapping) — brief proxy outage,
mesh identity intact.

## Step 2 — Provider: become the first mesh-PG provider

```bash
ssh <user>@<provider-host>
cd ~/nostr-storage-orchestrator
git fetch origin && git checkout decentralized-pg && git status --short
```

Add to `storage-client/.env` (same token as the orchestrator's
`PG_PROVIDER_TOKEN`; data goes on the 2 TB disk):

```bash
MESH_PG_DATA_PATH=/mnt/blossom/mesh-pg-data
MESH_PG_USER=mesh
MESH_PG_PASSWORD=<random>
MESH_PG_DATABASE=mesh
PG_AGENT_PORT=3300
PG_AGENT_TOKEN=<same as PG_PROVIDER_TOKEN>
# The reporting agent resolves the control plane's tunnel IP from nvpn0
# routes; with more than one /32 peer route it needs it explicitly:
CONTROL_PLANE_HOST_TUNNEL_IP=<orchestrator tunnel ip, 10.44.x.y>
```

```bash
cd storage-client
# nvpn is recreated (NVPN_MESH_INPUT_PORTS gains 3300) — recreate its
# namespace-mates together with it (docker restart will NOT work, see the
# hard rule above):
docker compose up -d --force-recreate nvpn blossom relay mesh-postgres pg-agent
docker compose ps   # all healthy
```

Start the reporting agent (keeps `lastPingAt` fresh — the active window is
960 s) and make sure the storage is linked in the control plane:

```bash
docker compose --profile agent up -d --build storage-agent
docker compose ps   # storage-agent Up, not Restarting
```

> If storage-agent crash-loops with `more than one /32 peer route exists on
> nvpn0; set CONTROL_PLANE_HOST_TUNNEL_IP`, that env is missing — the
> orchestrator's tunnel IP is in its `nvpn status --json` (`peers[].tunnel_ip`).

### Control-plane enrollment (required before pings succeed)

The storage agent's ping requires BOTH: its signing npub is an **active
Member**, and the **Storage** row is linked to that member. On a fresh DB
(empty `"Member"` and `"Storage"` tables — verify:

```bash
docker exec nso_postgres psql -U orchestrator -d orchestrator \
  -c 'SELECT * FROM "Member"; SELECT * FROM "Storage";'
```

on the orchestrator host), do the full enrollment from admin-app; do not
assume an earlier deployment's roster survived:

1. **Bootstrap admin.** The seed creates a Member from
   `ADMIN_ALLOWED_PUBKEYS` only while the table is empty. Confirm the env
   lists your admin npub, then open admin-app at `<ADMIN_PUBLIC_URL>` (from
   the orchestrator `.env`) and verify `GET /v1/me` resolves your role.
2. **Get the provider's identities** (on the provider):

```bash
docker exec storage-client-nvpn-1 sh -c \
  'nvpn status --config "$XDG_CONFIG_HOME/nvpn/config.toml" --json' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("storage npub:", d["npub"])'
```

   The operator npub is the key the agent signs pings with; the storage npub
   is the mesh identity above. In this deployment both are the same nVPN
   identity — use it for both roles.
3. **In admin-app:** authorize the provider's operator npub as a member,
   then **Link a storage** with the provider's storage npub.
4. Watch the agent's ping succeed (within ~15s):

```bash
docker logs storage-client-storage-agent-1 --tail 5   # no more ping WARNs
```

> Symptom reference: agent pings failing with `HTTP 404 Not Found` =
> storage not linked (empty `"Storage"` table). Other ping failures:
> connection refused = wrong `CONTROL_PLANE_API_PORT`; 401 = signing
> identity not an authorized member or URL mismatch.

The agent's ping does **not** carry `pgAgentPort`, so seed it once (agent
liveness keeps the row fresh afterwards):

```bash
# back on the orchestrator host
curl -s -X PATCH "http://127.0.0.1:${DB_API_PORT}/storages/<storage-npub>" \
  -H 'Content-Type: application/json' -d '{"pgAgentPort": 3300}'
```

Verification gate:

```bash
docker exec nso_db wget -qO- http://db:4739/storages/active-pg
# expect 1 record: the provider's tunnelIp (10.44.x.y), pgAgentPort 3300
docker exec nso_nvpn wget -qO- "http://<tunnel-ip>:3300/pg/health"
# expect {"status":"ok",...}
```

## Step 3 — nostream (its own compose, DB creds only)

Still on the orchestrator host, edit `/root/Servers/nostream/docker-compose.yml`:

1. **Delete** the `nostream-db` service (its host port 5432 may collide with
   other Postgres containers on the host; the old data stays untouched for
   rollback) and the `nostream-yggdrasil` service (FDW experiment).
2. In `nostream` and `nostream-migrate`, replace the DB env block:

```yaml
      DB_HOST: host.docker.internal
      DB_PORT: 55432
      DB_USER: orchestrator
      DB_PASSWORD: <PG_GATEWAY_PASSWORD>
      DB_NAME: nostr_ts_relay
      DB_MIN_POOL_SIZE: 0
      DB_MAX_POOL_SIZE: 16      # 64 conns would swamp a 1-vCPU box
      DB_ACQUIRE_CONNECTION_TIMEOUT: 60000
```

   and add to the `nostream` service (both services if you prefer):

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

   `nostream-migrate` also needs `extra_hosts` (it runs `knex migrate`).

3. `.nostr/settings.yaml` (minimal, admission-gated):

```yaml
relay:
  name: "Formstr Relay"
  description: "Private Relay managed by formstr"
  port: 8008
authorization:
  requireAdmission: true
```
   (rename to fit your deployment — these are the relay's public metadata.)

Start, watching for subset rejections:

```bash
cd /root/Servers/nostream
docker compose up -d nostream-cache
docker compose up nostream-migrate        # foreground; check exit
docker compose up -d nostream
```

Smoke:

```bash
curl -s --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:8008/ | head -c 200      # AUTH challenge or NOTICE
curl -s http://127.0.0.1:8008/ -H 'Accept: application/nostr+json'
```

Then publish a test event with any Nostr client and verify it landed on
the provider (this proves the whole plane: nostream → gateway → buffer →
mesh → pg-agent → provider postgres):

```bash
ssh <user>@<provider-host> 'cd ~/nostr-storage-orchestrator/storage-client \
  && docker compose exec mesh-postgres psql -U mesh -d mesh \
     -c "SELECT count(*) FROM events; SELECT count(*) FROM event_tags;"'
# and the buffer drains:
docker exec nso_postgres psql -U orchestrator -d orchestrator \
  -c 'SELECT count(*) FROM "PgWriteOp";'   # expect 0
```

---

## Rollback

- **nostream**: `git checkout -- docker-compose.yml` + `docker compose down`
  — the old compose (with `nostream-db`) is intact and its data untouched.
- **pg-gateway**: `docker compose stop pg-gateway` — buffered writes stay
  durable in central PG and dispatch when it returns.
- **db-api migration**: additive; `git checkout main` + rebuild is safe (the
  pg_* tables remain, harmlessly).
- **provider**: `git checkout main` in both checkouts + `docker compose up -d`
  (mesh-postgres/pg-agent disappear; blossom/strfry unaffected; mesh data
  persists under the provider's `MESH_PG_DATA_PATH`).

## Risks & notes

- The provider's mesh data is single-copy on its own disk (e.g. a
  removable USB drive) — take a `pg_dump` after go-live; repair/
  re-replication is v1.
- Other mesh peers stay out of the mesh-PG pool as long as their Storage
  rows have no `pgAgentPort` — don't set one until a peer should join
  (rows are hash-distributed across pg-enabled providers only).
- `docker stats` during the first REQ burst: small orchestrator hosts
  may be RAM-constrained (the reference staging box has ~3.8 GB total).
- Follow-ups: storage-agent ping + control plane should carry `pgAgentPort`
  (removes the manual PATCH); decide nostream's public exposure (:8008) and
  whether `proxy/relay` should include it as a backend.

## Rehearsed (what was tested before this guide)

Through a live gateway + 2-provider topology (raw pgwire, the real code
paths): CREATE TABLE with composite pk + bytea/jsonb + `uuid_generate_v4()`
default; `CREATE EXTENSION`; partial unique index; trigger function +
`CREATE TRIGGER`; the replaceable-event
`ON CONFLICT (…) WHERE (…) DO UPDATE SET … WHERE <guard>` upsert (gateway
recovers the predicate sqlparser cannot parse, replays it verbatim on
providers — older-timestamp guard verified); plain and narrow-projection
point reads (`SELECT col WHERE id = …`); fan-out reads; kind-5-style pk-less
`UPDATE` (broad write); `INSERT…SELECT` (broad); `select fn(…)`; trigger
derivation of `event_tags` on providers; knex catalog traffic
(`knex_migrations`, `information_schema`); buffer drain to zero; idempotent
replays; catch-up idempotency (`already exists` tolerated); mesh e2e suite
(12/12). Gateway: `cargo test` 25/25. pg-agent: `deno check` clean.