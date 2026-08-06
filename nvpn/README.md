# `nvpn/` — NVPN Docker sidecar

Reusable module providing NVPN (`nostr-vpn` v4.0.87) mesh access to a Compose stack without
joining the host to the mesh. Full design: [`../docs/NVPN_SIDECAR_PLAN.md`](../docs/NVPN_SIDECAR_PLAN.md).

## Contract

- One `nvpn` service per Compose project, extending [`compose.yml`](./compose.yml).
- Application services join its network namespace with `network_mode: "service:nvpn"` and
  depend on it with `condition: service_healthy, restart: true`.
- State (Nostr identity, NVPN config, firewall/init markers) lives entirely on the named volume
  mounted at `/data` — one volume per Compose project, never shared between two running sidecars.
- `NVPN_ROLE` is required (`proxy` or `client`); everything else has a sane default (see
  [`compose.yml`](./compose.yml)).
- Health means: initialization completed for this role, the firewall is installed, and the
  daemon reports a fresh/running state. It does **not** require an approved mesh peer — a
  freshly bootstrapped client must be able to go healthy while waiting for proxy-side approval.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Pinned/checksummed multi-arch NVPN 4.0.87 build |
| `compose.yml` | Shared capability/device/environment/health fragment |
| `entrypoint.sh` | Crash-safe atomic init, `bootstrap-client` one-shot mode, daemon supervisor |
| `firewall.sh` | Idempotent split-tunnel inbound + route-leak iptables/ip6tables rules |
| `healthcheck.sh` | Docker healthcheck script |

## Entrypoint modes

- `run` (default): installs the firewall, completes crash-safe initialization if needed, then
  runs the daemon via `nvpn start --daemon` under a small supervisor that stops it cleanly on
  `SIGTERM`, restarts it on unexpected exit with bounded backoff, re-runs the firewall once the
  tunnel interface appears, and never replaces the sidecar's network namespace. `--daemon` (not
  a foreground session) is required so `nvpn reload` works — that is how `scripts/nvpn-approve.sh`
  applies a new device approval without recreating the sidecar and tearing down the namespace
  its app containers share.
- `bootstrap-client`: one-shot mode for `docker compose run --rm --no-deps -T nvpn
  bootstrap-client`, used by `scripts/nvpn-join.sh`. Reads an invite from stdin (never from an
  env var, `.env`, or a log), runs `init` + `import-invite` in scratch state, adds the inviting
  proxy to its own roster (`import-invite` alone leaves `devices = []`, and `nvpn start` refuses
  to run with no participants), atomically commits it, prints only the resulting npub, and exits.

## Recovery

If the container logs `... exists without a completion marker ... refusing to overwrite unknown
state`, initialization was interrupted mid-write before this revision's atomic-commit fix, or the
volume was tampered with outside the sidecar. Do not delete data blindly:

1. `docker compose exec nvpn ls -la "$XDG_CONFIG_HOME/nvpn"` to inspect what's actually there.
2. If it's genuinely unrecoverable, back up the volume, then remove only the config directory
   (not the whole volume, in case other files are salvageable) and let `entrypoint.sh` reinitialize
   the role from scratch (a proxy re-init just needs re-inviting clients; a client re-init needs a
   fresh `nvpn-join.sh` run).

If a Compose-controlled sidecar update leaves namespace-sharing app containers stuck (see
`depends_on: ... restart: true` in the plan), force-recreate the sidecar and its dependents
together:

```bash
docker compose up -d --force-recreate nvpn blossom relay
```

## Supported platforms

- **Supported**: Linux Docker Engine with Compose V2 and `/dev/net/tun`.
- **Unsupported**: rootless Docker (cannot grant the required TUN device/`NET_ADMIN`), native
  Windows containers.
- **Best-effort**: Docker Desktop / WSL2, until the full data path is tested inside their Linux VM.

## Security boundaries

- The `/data` volume contains the Nostr secret key and signed network state — treat it like any
  other private key material (back it up, never mount it into two running sidecars at once).
- Nothing is published to a registry — `compose.yml` has no `image:`, so every machine builds
  this from source (pinned/checksummed NVPN release, see `Dockerfile`). If this ever does get
  published under a registry tag, add `image:` back and pin it (and, for production, its digest)
  rather than tracking `latest`.
- No `privileged`, no `network_mode: host` — isolation comes from `cap_add: NET_ADMIN` +
  `/dev/net/tun` scoped to this one service.
