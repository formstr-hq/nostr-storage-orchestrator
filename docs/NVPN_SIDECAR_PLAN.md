# Plan: nostr-vpn Docker Sidecar for Proxy ↔ Storage-Client Mesh

## Goal

The proxy stack (root `docker-compose.yml`) is the publicly exposed server; storage-client
stacks are the actual storage backends. They connect over [nostr-vpn](https://github.com/mmalmi/nostr-vpn)
(`nvpn`), with the mesh confined to a Docker sidecar's network namespace — **the host machine
never joins the VPN**. A single shared nvpn compose fragment is consumed by both stacks.
Config is generated per stack on first start; the operator supplies the invite URL exactly
once (client side) and accepts join requests from the proxy side.

Anyone can clone the repo, run the client stack, and request to join the network; the proxy
operator approves with one command.

Backwards compatibility with the current host-networking setup is explicitly **not** a goal.

## Upstream facts this design relies on

Verified against the nostr-vpn repo (mirror: github.com/mmalmi/nostr-vpn):

- Official Docker pattern exists (its Umbrel package): `cap_add: NET_ADMIN` +
  `/dev/net/tun` device, running `nvpn daemon --config /data/config/nvpn/config.toml`,
  with `XDG_CONFIG_HOME` pointed at a mounted volume for persistence.
- Headless join approval: `nvpn add-device <npub>` (alias `add-participant`) is how an
  admin accepts a join request. `nvpn import-invite` on the client queues the join
  request; the daemon waits in "Waiting for participants" until approved. Roster syncs
  over Nostr relays.
- Tunnel IPs are deterministic: `SHA256(network_id + pubkey_hex)` →
  `10.44.x.y/32`. Stable per identity+network, so backend URLs don't churn.
- Other useful CLI: `nvpn init [--config PATH]`, `nvpn create-invite`, `nvpn status`,
  `nvpn ip <peer>`, `nvpn join-request --no-wait`.
- Mesh data plane listens on `listen_port` (default 51820/udp). FIPS bootstrap peers
  (`udp:2121`, `tcp:8443`) are outbound-only — nothing to publish for those.
- MagicDNS requires installing a resolver into systemd-resolved via D-Bus — unreliable
  inside containers. **Use tunnel IPs, not MagicDNS names.**

## Core pattern: sidecar-owned netns

The `nvpn` container runs as a normal bridge-networked compose service (no
`network_mode: host`) with `NET_ADMIN` + `/dev/net/tun`. The tun device is created
*inside its container netns*. App containers join that netns with
`network_mode: "service:nvpn"` — only they are reachable over the mesh.

What this buys:

- **Client machine exposes nothing.** strfry's `7777:7777` and blossom's port mappings
  are deleted. Backends are reachable only via `http://<client-tunnel-ip>:3000` /
  `ws://<client-tunnel-ip>:7777` over the mesh. No firewall configuration needed for
  a clone-and-run storage node.
- **Proxy is exposed only through the sidecar's published ports** (`:3001`, `:8007`).
  The proxies reach mesh backends because they share the netns with the tun.
- **Host never appears on the mesh** on either side.

## 1. New shared module: `nvpn/` at repo root

```
nvpn/
├── docker-compose.nvpn.yml   # the single shared compose fragment
├── Dockerfile                # fetches the nvpn CLI release binary
├── entrypoint.sh             # role-aware init-then-daemon logic
└── .gitignore                # ignores nvpn state dirs (they hold the nsec)
```

### Dockerfile

`debian:bookworm-slim` + `ca-certificates iproute2 iptables`, with the `nvpn` Linux CLI
binary downloaded from the GitHub release tarball. Multi-arch via `TARGETARCH`
(x86_64 + arm64 — works on the Pi). Avoids a long cargo build.

### docker-compose.nvpn.yml (shared fragment)

```yaml
services:
  nvpn:
    build: .
    cap_add: [NET_ADMIN]
    devices: ["/dev/net/tun:/dev/net/tun"]
    restart: unless-stopped
    environment:
      NVPN_ROLE: ${NVPN_ROLE:?}        # proxy | client
      NVPN_INVITE: ${NVPN_INVITE:-}
    volumes:
      - ${NVPN_STATE_DIR:?}:/data
```

`:?` makes misconfiguration fail loudly. Consumed via **`extends`** (not `include`)
because port publishing must differ per stack — `extends` allows adding fields,
`include` forbids overriding.

### entrypoint.sh — "config per stack, invite supplied once"

On container start:

1. **Config exists** (`/data/config/nvpn/config.toml`) → skip straight to daemon.
   `NVPN_INVITE` is ignored from then on — supplying it once is enough.
2. **No config, `NVPN_ROLE=proxy`** → `nvpn init`, add own npub as device + admin,
   `nvpn create-invite`, print the invite prominently in the logs **and** write it to
   `/data/invite.txt` (retrievable any time via `cat nvpn-data/invite.txt`).
3. **No config, `NVPN_ROLE=client`** → require `NVPN_INVITE` (fail with a clear message
   if unset), `nvpn init`, `nvpn import-invite "$NVPN_INVITE"`, print own npub +
   join-request link to logs.
4. If `NVPN_LISTEN_PORT` differs from the default, set `listen_port` in the config to
   match (see UDP note below).
5. `exec nvpn daemon --config /data/config/nvpn/config.toml` (foreground, PID 1,
   Umbrel-style). `XDG_CONFIG_HOME=/data/config`, `HOME=/data/home`.

## 2. Consuming it from both stacks

### Root `docker-compose.yml` (proxy)

```yaml
services:
  nvpn:
    extends: { file: ./nvpn/docker-compose.nvpn.yml, service: nvpn }
    ports:
      - "${BLOSSOM_PORT:-3001}:3001"             # public ports live on the sidecar
      - "${RELAY_PORT:-8007}:8007"               # because it owns the netns
      - "${NVPN_LISTEN_PORT:-51820}:51820/udp"   # direct mesh connectivity

  blossom:
    network_mode: "service:nvpn"    # replaces network_mode: host
    depends_on: [nvpn]
  relay:
    network_mode: "service:nvpn"
    depends_on: [nvpn]
```

Proxy loses `network_mode: host`, so db-api wiring changes: the nvpn sidecar sits on the
default compose bridge network, so containers sharing its netns reach compose services by
DNS name — `DB_API_URL=http://db:4000` replaces the derived `localhost:4000`, and the
`127.0.0.1` port binding on `db` can be dropped entirely (bridge-internal only). This
becomes the default in `.env.example`.

### `storage-client/docker-compose.yml`

```yaml
services:
  nvpn:
    extends: { file: ../nvpn/docker-compose.nvpn.yml, service: nvpn }
    # ports:
    #   - "${NVPN_LISTEN_PORT:-51820}:51820/udp"  # optional, see UDP note

  blossom:
    network_mode: "service:nvpn"
    depends_on: [nvpn]
  relay:   # strfry
    network_mode: "service:nvpn"
    depends_on: [nvpn]
```

No published service ports — backends are mesh-only.

### UDP port publishing

The mesh data-plane port (51820/udp) can be published without undermining isolation:
it's the encrypted FIPS tunnel endpoint, authenticated by the roster — it exposes no
service, it just enables direct tunnels instead of relaying through bootstrap peers.

- **Host port must match the container listen port** (51820:51820, not a remap). nvpn
  advertises its endpoint from what STUN discovers; a same-port mapping through Docker's
  NAT keeps the advertised port truthful so hole-punching works. If the operator
  overrides `NVPN_LISTEN_PORT`, the entrypoint also sets `listen_port` in the config.
- **Proxy: always published** — it's the stable, publicly reachable side.
- **Client: optional but recommended** (present-but-commented in `.env.example`). With
  the proxy directly reachable on UDP, NATed clients get direct tunnels anyway — one
  reachable side suffices. Default clone-and-run posture stays "nothing exposed unless
  you opt in."

### Per-stack env (`.env` / `.env.example` additions)

| Var | Proxy `.env` | Client `.env` |
|---|---|---|
| `NVPN_ROLE` | `proxy` | `client` |
| `NVPN_STATE_DIR` | `./nvpn-data` | `./nvpn-data` (its own dir) |
| `NVPN_INVITE` | — | pasted once before first `up` |
| `NVPN_LISTEN_PORT` | `51820` | `51820` (commented ports mapping) |

Two state dirs = two identities = config generated per compose stack. Both state dirs
are gitignored (they contain the nsec and invite secret).

## 3. Operator flow (to be documented in README)

**Proxy machine:**

```bash
cp .env.example .env            # NVPN_ROLE=proxy is the default there
docker compose up -d --build
docker compose logs nvpn        # copy the printed nvpn://invite/... code
```

**Client machine (anyone cloning the repo):**

```bash
cd storage-client
cp .env.example .env            # set NVPN_INVITE=nvpn://invite/...
docker compose up -d --build    # inits, imports invite, sends join request
docker compose logs nvpn        # shows this device's npub
```

**Proxy operator accepts the join** (helper: `scripts/nvpn-approve.sh`):

```bash
docker compose exec nvpn nvpn add-device <client-npub> --config /data/config/nvpn/config.toml
```

Roster syncs over Nostr, the mesh comes up; `docker compose exec nvpn nvpn status`
shows the peer and its tunnel IP.

**Wire the backends** — in the proxy `.env`, using the client tunnel IP from
`nvpn status` / `nvpn ip <peer>`:

```bash
BLOSSOM_SERVERS=http://10.44.x.y:3000
BACKEND_RELAYS=ws://10.44.x.y:7777
```

## 4. Caveats (documented, not blockers)

- **Intra-netns port collisions:** containers sharing one netns share one localhost —
  port sets must be disjoint. Client: 3000 (blossom) + 7777 (strfry) ✓.
  Proxy: 3001 + 8007 ✓. Healthchecks (`wget localhost:3000`) keep working.
- **NAT traversal:** the sidecar sits behind Docker's bridge NAT in addition to machine
  NAT. FIPS falls back to relaying through bootstrap peers when direct UDP fails;
  publishing 51820/udp on the proxy makes direct tunnels the normal case.
- **Sidecar restart replaces the netns:** if the nvpn container is recreated, dependents
  must be restarted too (`docker compose up -d` handles it; a bare
  `docker restart nvpn` does not). Goes in the README.
- **No mesh-off escape hatch:** app containers structurally depend on the sidecar's
  netns, so the mesh is always part of these stacks. For local dev / the smoke test,
  a compose override (`docker-compose.dev.yml`) swaps `network_mode: service:nvpn`
  back to the default bridge. Small follow-up, not part of the initial implementation.
- **Approval stays manual** — matches the "accept request to join" requirement. An
  auto-approve mode could be added later via roster join-request settings if desired.

## Files touched

| File | Change |
|---|---|
| `nvpn/docker-compose.nvpn.yml` | new — shared sidecar fragment |
| `nvpn/Dockerfile` | new — nvpn release binary, multi-arch |
| `nvpn/entrypoint.sh` | new — role-aware init + daemon |
| `nvpn/.gitignore` | new — ignore state dirs |
| `scripts/nvpn-approve.sh` | new — join-approval helper |
| `docker-compose.yml` | nvpn extends block; blossom/relay → `service:nvpn`; drop host networking; db loopback binding removed |
| `storage-client/docker-compose.yml` | nvpn extends block; blossom/strfry → `service:nvpn`; remove published ports |
| `.env.example` | NVPN_* vars; `DB_API_URL=http://db:4000` default; mesh-IP examples for `BLOSSOM_SERVERS`/`BACKEND_RELAYS` |
| `storage-client/.env.example` | new or extended — NVPN_* vars incl. `NVPN_INVITE` |
| `README.md` | operator flow section |
| `docker-compose.dev.yml` | optional follow-up — mesh-less local dev |
