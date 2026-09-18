# Staging nostream relay (relay.stg.formstr.app)

Declarative deployment for the `nso_nostream` relay that fronts mesh-PG on the
staging orchestrator host. This replaces a hand-started container that was not
part of any compose project — so a host reboot used to leave the relay down.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | `nostream` + `nostream-cache`, pinned network |
| `settings.yaml` | Relay settings overrides, mounted read-only |
| `resources/` | Landing page (`index.html`, `css/style.css`), mounted read-only |
| `.env.example` | Secrets / tuning template |

## Why these exist

1. **Restart survival.** The old container had `restart: unless-stopped` but no
   compose project, so it did not come back after a `docker compose down` or a
   host reboot that recreated containers. Declaring the service fixes that.
2. **Settings are source-controlled.** The public-relay overrides and the
   `network.trustedProxies` list (which is what makes rate limiting key on the
   real client IP) previously lived only in the host's
   `.nostr/settings.yaml`. They are now committed and mounted read-only, so the
   running relay cannot drift from the repo.

## Landing page

`resources/` holds the relay's landing page, mounted read-only over the image's
`/app/resources/index.html` and `/app/resources/css/style.css`.

This exists because the deployed `nostream-mesh:staging` image predates the
redesign: it was built 2026-09-07 14:00 UTC, while the redesign commits landed
16:28–16:39 UTC. The redesigned page had been copied into the running
container's writable layer, so recreating the container reverted the relay to
the old bootstrap page. Mounting the files from the repo makes the page
durable across recreation.

To change the page: edit `resources/index.html` / `resources/css/style.css`
or refresh them from the nostream fork's `landing-redesign` branch, then
`docker compose up -d` (compose recreates on mount change). The page must stay
self-contained — no external fonts/scripts — to satisfy the image's CSP.


## Deploy

```bash
cd deploy/nostream-staging
cp .env.example .env && $EDITOR .env          # set SECRET, DB_PASSWORD, REDIS_PASSWORD
docker compose up -d
```

The nostream image (`NOSTREAM_IMAGE`, default `nostream-mesh:staging`) must
already be loaded on the host. See the fork build notes in
`docs/DEPLOY_STAGING_NOSTREAM_MESHPG.md`.

## Migrating the existing (hand-started) containers

Compose cannot adopt containers it did not create, and the existing
`nostream-net` network is unmanaged, so the first cutover needs a short
outage:

```bash
# 1. Stop and remove the old containers (the nostream-net network is recreated
#    by compose with the same subnet, so the bridge IP stays 172.28.0.1).
docker rm -f nso_nostream nso_nostream_cache
docker network rm nostream-net

# 2. Bring the stack up from this directory.
cd deploy/nostream-staging
docker compose up -d
```

The old redis `cache` volume is not reused (compose gets a fresh project
volume). Relay state that matters — events — lives in mesh-PG, not redis, so
this only costs transient cache contents.

## Trusted proxy / rate limiting

`settings.yaml` sets `network.remoteIpHeader: x-forwarded-for` and lists
`172.28.0.1` in `network.trustedProxies`. `docker-compose.yml` pins the
`nostream-net` subnet to `172.28.0.0/16`, whose gateway is always the first
host address (`172.28.0.1`), so the two stay consistent. nginx already sends
`X-Forwarded-For`.

Without this, every public connection appears to come from the proxy, and the
default `limits.connection` bucket (12/sec, 48/min) is shared by all clients —
connections get terminated right after the AUTH challenge and publishes fail.

## Verify

```bash
docker compose ps
curl -s http://127.0.0.1:8008/ -H 'Accept: application/nostr+json' | head -c 200
docker exec nso_nostream_cache redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  KEYS '*:connection:*' | head
```

Rate-limit keys should show real client IPs, not `172.28.0.1`.
