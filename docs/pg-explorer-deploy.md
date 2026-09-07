# mesh-PG explorer (pgweb + NIP-98) — deploy notes

Admin-only web UI over the mesh-PG database, live at **https://dbase.stg.formstr.app**.

```
dbase.stg.formstr.app (nginx, *.stg wildcard TLS)
  → pg-explorer :8090   NIP-98 login → session cookie → read-only guard
    → pgweb :8081        (private, no ports)
      → mesh-PG gateway  meshdb  (host.docker.internal:55432, PG_GATEWAY_PASSWORD)
```

## Components
- `pg-explorer/` (this repo) — Node reverse proxy. Sign-in page produces a
  NIP-98 event (NIP-07 extension / NIP-46 bunker / ncryptsec). It's verified
  (sig, kind 27235, u-tag, method, 5-min replay window) against an **admin
  allowlist**, minting an HttpOnly session cookie (8h).
  - **Fail-closed:** with no `ALLOWED_NPUBS`/`ALLOWED_NPUBS_FILE` and no
    `ALLOW_ALL=1`, every login is denied.
  - **Read-only** enforced in the proxy (pgweb's own `--readonly` crash-loops
    against the gateway): SQL to pgweb's execute endpoints must be
    SELECT/WITH/EXPLAIN/SHOW, single-statement, no data-modifying CTEs.
- `compose.pg-explorer.yml` — runs `pgweb` (private) + `pg-explorer` (loopback).

## Deploy / update (staging: /root/Servers/storage)
```
git pull
# .env.pgweb holds: PG_GATEWAY_PASSWORD, GATEWAY_HOST=host.docker.internal,
#   GATEWAY_PORT=55432, EXPLORER_URL=https://dbase.stg.formstr.app/, ALLOWED_NPUBS=<npubs>
docker compose -f compose.pg-explorer.yml --env-file .env.pgweb up -d --build
```
nginx vhost: `/etc/nginx/sites-enabled/dbase.stg.formstr.app` → `127.0.0.1:8090`
(wildcard cert, websocket-friendly). `nginx -t && nginx -s reload`.

**Admins:** currently only `npub1cgd35mxmy37vhkfcmjckk9dylguz6q8l67cj6h9m45tj5rx569cql9kfex`.
Add more by appending comma-separated npubs to `ALLOWED_NPUBS` in `.env.pgweb`
and re-running the compose up. (The control-plane's `ADMIN_ALLOWED_PUBKEYS`
lists the other operators, if you want them added — not done automatically.)

## Known limitations (gateway is a SQL subset)
- **Table-click browsing in pgweb's sidebar may error** — its metadata/pagination
  queries use a `lib/pq` param path that the gateway rejects. The **Query tab
  works** for SELECTs within the gateway's supported subset (no aggregates yet;
  see the aggregation follow-up).
- `EXPLORER_URL` must exactly match the origin users visit (the NIP-98 `u`-tag).

## Gateway changes that made this work (committed on decentralized-pg)
- accept `public.<table>` schema qualifier; report real `$N` parameter count
  (`da5cd66`) — needed for pgweb's queries.
