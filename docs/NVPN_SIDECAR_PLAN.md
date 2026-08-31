# Plan: NVPN 4.0.87 Docker Sidecar

## Status

Completed - 07.08.2026

Reviewed against `nostr-vpn` tag `v4.0.87`, built from commit
`9f5d7017f3e7248f9679824481f2ff7a5ca6dd83`.

The sidecar-owned network namespace is the right base design, but the original plan was
not safe to implement as written. This revision fixes the `v4.0.87` CLI syntax,
initialization, Docker isolation, process lifecycle, state ownership, port overrides, and
local smoke-test topology.

## Goal

Provide a plug-and-play Docker sidecar which gives Blossom and relay containers access to
an NVPN private mesh without joining the host to the mesh.

- The root stack exposes the public Blossom and relay proxies.
- Each `storage-client` stack runs a mesh-only Blossom server and strfry relay.
- Application containers share the NVPN sidecar's network namespace with
  `network_mode: "service:nvpn"`.
- NVPN identity and network state persist independently for each Compose project.
- A client joins with one one-shot command. The invite is not retained in Compose
  environment variables or Docker logs.
- Join approval remains an explicit proxy-operator action.
- A Gluetun-style firewall prevents bridge access and private-route leakage.
- A supervisor restarts the NVPN daemon without replacing the sidecar network namespace.

Backward compatibility with the current production host-networking topology is not a
goal. A meshless Compose topology remains available for local development and smoke tests.

## Verified NVPN 4.0.87 Contract

### Release artifacts

Use only versioned release artifacts and verify SHA-256 during the image build.

| Docker platform | Release artifact                                 | SHA-256                                                            |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `linux/amd64`   | `nvpn-v4.0.87-x86_64-unknown-linux-musl.tar.gz`  | `c57498e08ef35916e2125b653d693a0bb5ec174dbf11fadf49f60734eb147e9a` |
| `linux/arm64`   | `nvpn-v4.0.87-aarch64-unknown-linux-musl.tar.gz` | `be14af1cb17dab52d49e9ebd93541e82f903eae864c0122c2ea337f5f08bb89c` |

The image must fail on unsupported `TARGETARCH` values. Do not download an unversioned
asset or use a `latest` NVPN tag.

### CLI syntax

`--config` belongs after each subcommand. The supported forms needed by this sidecar are:

```bash
CONFIG=/data/config/nvpn/config.toml

nvpn init --config "$CONFIG"
nvpn set --config "$CONFIG" --device "$NPUB"
nvpn create-invite --config "$CONFIG"
nvpn import-invite --config "$CONFIG" "$INVITE"
nvpn add-device --config "$CONFIG" --device "$CLIENT_NPUB" --publish
nvpn status --config "$CONFIG" --json
nvpn ip --config "$CONFIG" --peer --json
nvpn daemon --config "$CONFIG"
```

Important corrections from the previous plan:

- `nvpn add-device <npub>` is invalid; `--device` is required.
- `nvpn ip <peer>` is invalid; use `status --json` to map identities to IPs.
- There is no `nvpn join-request --no-wait` command.
- `init` alone does not create a usable active proxy network. After `init`, activate and
  self-enroll it with `set --device "$NPUB"` before creating an invite.
- `import-invite` queues the client's join request; it does not print a join-request URL.
- `daemon` is a foreground internal entrypoint and is appropriate inside the container.
  Do not use `start --daemon`, which forks away from PID 1.

### State and networking

- With `XDG_CONFIG_HOME=/data/config`, config is
  `/data/config/nvpn/config.toml`.
- The Linux Nostr secret is a separate `0600` file beside the TOML, not inline in it.
  Persist and back up the entire `/data` volume.
- Runtime PID, state, and log files are also stored beside the config.
- The default mesh interface is created inside the sidecar network namespace and needs
  `CAP_NET_ADMIN`, `/dev/net/tun`, and `iproute2`.
- The default FIPS UDP listen port is `51820`.
- Bootstrap `udp:2121` and `tcp:8443` addresses are remote, outbound connections. Regular
  nodes do not publish those ports.
- Tunnel IPs are stable for an identity and network. The exact formula is
  `SHA256(normalized_network_id + "\n" + pubkey_hex)`, mapped into `10.44.x.y/32`.
- Nostr relays are used by FIPS discovery/rendezvous. The signed roster is authoritative
  for membership; it is not a separate legacy Nostr peer-announcement mesh.
- MagicDNS modifies resolver or hosts-file state in the sidecar's mount namespace, which
  application containers do not share. Backend configuration therefore uses tunnel IPs.

## Architecture

```text
Public Internet
      |
      | TCP 3001 / 8007
      v
+---------------- root NVPN network namespace ----------------+
| nvpn sidecar + firewall + supervisor                         |
| proxy/blossom :3001       proxy/relay :8007                  |
|             \                /                               |
|              \-- db:4000 --/     (Compose bridge DNS)       |
+--------------------------+-----------------------------------+
                           |
                    FIPS private mesh
                           |
+---------------- client NVPN network namespace ---------------+
| nvpn sidecar + firewall + supervisor                         |
| Blossom :3000              strfry :7777                      |
+--------------------------------------------------------------+
```

The root and each storage client have different NVPN named volumes, identities, network
namespaces, and Compose project names. Remove fixed `container_name` fields so multiple
storage clients can run on one Docker host.

## 1. Sidecar Image

Create this reusable module:

```text
nvpn/
|-- Dockerfile
|-- compose.yml
|-- entrypoint.sh
|-- firewall.sh
|-- healthcheck.sh
`-- README.md
```

### Dockerfile

- Pin NVPN to `4.0.87` with `ARG NVPN_VERSION=4.0.87`.
- Map `TARGETARCH` to the exact artifact and checksum listed above.
- Download the versioned archive and reject a checksum mismatch before extraction.
- Use `debian:bookworm-slim` and install the upstream runtime baseline:
  `ca-certificates`, `iproute2`, `iptables`, `iputils-ping`, `procps`, and
  `wireguard-tools`.
- Add `tini` only if the supervisor does not fully reap and forward signals itself.
- Embed OCI source, revision, version, and license labels.
- Publish a sidecar-specific immutable tag such as
  `ghcr.io/formstr-hq/nvpn-sidecar:4.0.87-1`. Keep `build:` available for cloned-repo use.
- Run as root because network administration is the purpose of this narrowly scoped
  container. Do not use `privileged`, `SYS_ADMIN`, or host networking.

### Runtime Compose fragment

The shared fragment owns only reusable runtime settings. State mounts and published ports
belong in each consuming stack so relative paths and identities cannot accidentally be
shared.

```yaml
services:
  nvpn:
    image: ghcr.io/formstr-hq/nvpn-sidecar:4.0.87-1
    build:
      context: .
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    restart: unless-stopped
    stop_grace_period: 30s
    environment:
      HOME: /data/home
      XDG_CONFIG_HOME: /data/config
      NVPN_DAEMON_STATUS_MODE: state-file
      NVPN_ROLE: ${NVPN_ROLE:?set NVPN_ROLE to proxy or client}
      NVPN_LISTEN_PORT: ${NVPN_LISTEN_PORT:-51820}
```

Use Compose `extends` from the root and storage-client files. Validate path resolution with
Docker Compose V2 in CI. This design targets Compose, not `docker stack deploy`.

### Crash-safe initialization

The entrypoint must not treat the existence of `config.toml` as completed initialization.

1. Acquire an initialization lock in `/data`.
2. If a completion marker exists, validate its role, sidecar schema version, and required
   config/secret files.
3. If a config exists without a completion marker, fail safely with a recovery message.
   Never overwrite an unknown nsec.
4. Build new state under a temporary directory on the `/data` volume.
5. For a proxy, run `init`, parse and validate the generated `nostr_pubkey`, then run
   `set --device "$NPUB"`.
6. For a client, require prior one-shot bootstrap; normal `up` must not read an invite from
   a persistent environment variable.
7. Move the complete temporary state into place atomically, set directory mode `0700`, and
   write the completion marker last.
8. Apply `NVPN_LISTEN_PORT` with the supported `nvpn set` command. Do not edit TOML with
   regex. Persist the configured value and reapply only when it changes.

The image exposes a `bootstrap-client` entrypoint mode. `scripts/nvpn-join.sh` prompts for
the invite without echoing it and passes it over stdin to a one-shot container:

```bash
docker compose run --rm --no-deps -T nvpn bootstrap-client
```

That mode performs `init` and `import-invite` in temporary state, commits it atomically,
prints only the client's public npub, and exits. The invite must not appear in `.env`,
`docker inspect`, container logs, or persisted helper files.

### Gluetun-style supervision

The sidecar container must stay alive if the NVPN daemon crashes. Recreating the sidecar
replaces its network namespace and strands or disconnects namespace-sharing applications.

- The entrypoint/supervisor starts `nvpn daemon --config ...` as a child.
- It forwards SIGTERM, waits for clean tunnel teardown, and reaps child processes.
- Unexpected daemon exits use bounded backoff and restart inside the same container.
- The Docker restart policy is a last resort for supervisor failure, not normal daemon
  recovery.
- Health means initialization complete, firewall active, daemon state fresh/running, and
  required local runtime files valid. It must not require an approved peer, otherwise a new
  client can never become healthy while waiting for approval.

Applications use long-form dependencies:

```yaml
depends_on:
  nvpn:
    condition: service_healthy
    restart: true
```

`restart: true` handles Compose-controlled sidecar updates. It does not cover every Docker
runtime or daemon-restart scenario. Document a recovery command that force-recreates the
sidecar and all namespace-sharing services together.

## 2. Firewall and Leak Protection

No published application ports is not sufficient isolation. On Linux, the host and sibling
bridge containers may access an unpublished container IP directly. The sidecar must install
its firewall before becoming healthy or starting application dependents.

Use role-independent settings so the image remains reusable:

| Variable                  | Root proxy value | Storage-client value |
| ------------------------- | ---------------- | -------------------- |
| `NVPN_PUBLIC_INPUT_PORTS` | `3001,8007`      | empty                |
| `NVPN_MESH_INPUT_PORTS`   | empty            | `3000,7777`          |
| `NVPN_PRIVATE_CIDR`       | `10.44.0.0/16`   | `10.44.0.0/16`       |

The firewall must:

- Install dedicated, idempotent IPv4 and IPv6 chains before the NVPN daemon starts.
- Allow loopback and established/related traffic.
- Allow the configured NVPN UDP listener on the bridge interface.
- Allow public proxy ports from Docker's published-port path only on the root role.
- Allow storage application ports only on loopback and the NVPN tunnel interface.
- Reject storage application ports arriving on the Docker bridge interface.
- Reject traffic to `10.44.0.0/16` when it would leave through a non-NVPN interface. This is
  a split-tunnel leak guard, not a full default-route VPN kill switch.
- Preserve ordinary outbound Internet access needed for Nostr discovery, S3, package APIs,
  and other Blossom behavior.
- Fail closed if the expected tunnel interface or firewall backend cannot be identified.
- Keep firewall policy active while the daemon is restarting.

Do not copy Gluetun's full default-route kill switch. NVPN is a private split-tunnel mesh;
only private mesh destinations and inbound application ports need fail-closed handling.

## 3. Root Proxy Stack

The root `nvpn` service extends the shared fragment and declares its own named volume and
ports:

```yaml
services:
  nvpn:
    extends:
      file: ./nvpn/compose.yml
      service: nvpn
    environment:
      NVPN_ROLE: proxy
      NVPN_PUBLIC_INPUT_PORTS: "${BLOSSOM_PORT:-3001},${RELAY_PORT:-8007}"
    volumes:
      - nvpn_data:/data
    ports:
      - "${BLOSSOM_PORT:-3001}:${BLOSSOM_PORT:-3001}"
      - "${RELAY_PORT:-8007}:${RELAY_PORT:-8007}"
      - "${NVPN_LISTEN_PORT:-51820}:${NVPN_LISTEN_PORT:-51820}/udp"

  blossom:
    network_mode: "service:nvpn"
    environment:
      DB_API_URL: http://db:4000
    depends_on:
      db:
        condition: service_healthy
      nvpn:
        condition: service_healthy
        restart: true

  relay:
    network_mode: "service:nvpn"
    environment:
      DB_API_URL: http://db:4000
    depends_on:
      db:
        condition: service_healthy
      nvpn:
        condition: service_healthy
        restart: true

volumes:
  nvpn_data:
```

Containers sharing the sidecar namespace can resolve and reach `db:4000` through the
sidecar's Compose bridge attachment. Other bridge containers see the shared namespace as
`nvpn`, not as separate `blossom` and `relay` network peers.

Keep local development's `DB_API_URL` default as `localhost`; override it only in the
production proxy containers. Do not change the shared `.env.example` default to `db`, which
would break non-Docker development.

The same internal and host port is used for every override. In particular, an NVPN override
must be `51900:51900/udp`, not `51900:51820/udp`.

Publishing the same UDP port avoids a known-bad remap, but does not guarantee that STUN and
hole punching work through every Docker and router NAT combination. FIPS relay fallback is
required. Direct-path behavior behind Docker NAT must be tested rather than asserted.

## 4. Storage-Client Stack

```yaml
services:
  nvpn:
    extends:
      file: ../nvpn/compose.yml
      service: nvpn
    environment:
      NVPN_ROLE: client
      NVPN_MESH_INPUT_PORTS: "3000,7777"
    volumes:
      - nvpn_data:/data

  blossom:
    network_mode: "service:nvpn"
    depends_on:
      nvpn:
        condition: service_healthy
        restart: true

  relay:
    network_mode: "service:nvpn"
    depends_on:
      nvpn:
        condition: service_healthy
        restart: true

volumes:
  nvpn_data:
```

The storage stack publishes no Blossom or relay host ports. Its firewall additionally
rejects bridge access to those ports.

Direct client UDP is optional and cannot be enabled by an environment variable alone.
Provide `storage-client/compose.direct-udp.yml`:

```yaml
services:
  nvpn:
    ports:
      - "${NVPN_LISTEN_PORT:-51820}:${NVPN_LISTEN_PORT:-51820}/udp"
```

Users enable it explicitly with both Compose files. Multiple client stacks on one host need
different same-value listen ports and distinct Compose project names.

## 5. Operator Flow

### Proxy

```bash
cp .env.example .env
docker compose up -d --build
./scripts/nvpn-invite.sh
```

`nvpn-invite.sh` runs `create-invite` against the initialized sidecar and prints the invite
only to the invoking terminal. It does not write it to logs or disk.

### Storage client

```bash
cd storage-client
cp .env.example .env
./scripts/nvpn-join.sh
docker compose up -d --build
```

The join helper prints the client npub. Send only that public identifier to the proxy
operator.

### Approval

```bash
./scripts/nvpn-approve.sh <client-npub>
```

The helper validates the npub and runs:

```bash
docker compose exec nvpn \
  nvpn add-device --config /data/config/nvpn/config.toml \
  --device "$CLIENT_NPUB" --publish
```

The running daemon reloads and distributes the signed roster. Use a peer-list helper based
on `nvpn status --json` to obtain the approved client's tunnel IP, then configure:

```bash
BLOSSOM_SERVERS=http://10.44.x.y:3000
BACKEND_RELAYS=ws://10.44.x.y:7777
```

Restart or recreate only the proxy application services after changing those values; do not
recreate the NVPN sidecar unnecessarily.

## 6. Local Development and Smoke Tests

The meshless topology is required in the initial implementation, not a follow-up.

- Add complete `docker-compose.dev.yml` files for root and `storage-client`, or factor common
  service definitions into fragments consumed by separate production and development entry
  files.
- Preserve the current local behavior: storage Blossom and strfry publish `3000` and `7777`,
  root proxies can reach those local backends, and DB API remains loopback-only.
- `scripts/docker-smoke-test.sh` must explicitly select the development files. It must not
  consume production NVPN state, invite data, or operator `.env` values.
- Remove fixed `container_name` assumptions. Resolve containers with
  `docker compose ps -q <service>` and use a unique temporary project name.
- Keep the protocol-level smoke suite independent of Internet relays and NVPN approval.

## 7. Platform and Security Boundaries

- Supported first: Linux Docker Engine with Compose V2 and `/dev/net/tun`.
- Rootless Docker is unsupported because it generally cannot grant the required TUN device
  and network capability.
- Docker Desktop and WSL2 are best-effort until the complete data path is tested inside their
  Linux VM.
- Native Windows containers are unsupported.
- The NVPN state volume contains the Nostr secret key and signed network state. Never mount
  the same volume into two running sidecars.
- Pin the sidecar image tag in Compose. Production deployments should pin its image digest as
  well.
- Pin strfry to a tested tag or digest instead of `latest` as part of the reproducible release.

## 8. Verification Gates

### Static and build checks

```bash
docker compose config
docker compose --project-directory storage-client \
  -f storage-client/docker-compose.yml config
docker buildx build --platform linux/amd64,linux/arm64 ./nvpn
```

- Confirm `nvpn version` reports exactly `4.0.87` in both images.
- Confirm a modified checksum makes the build fail.
- Confirm unsupported architectures fail with a clear message.

### Lifecycle checks

- Fresh proxy state initializes once and survives container recreation.
- Failed initialization never leaves a valid completion marker.
- Existing unmarked state is preserved and rejected, not overwritten.
- Client bootstrap consumes the invite over stdin and leaves no invite in inspect output,
  logs, `.env`, or helper files.
- A daemon crash restarts the child without replacing the sidecar network namespace.
- SIGTERM performs clean daemon and tunnel shutdown within `stop_grace_period`.
- Changing `NVPN_LISTEN_PORT` updates both daemon config and same-port Docker publication.

### Isolation checks

- Host and sibling bridge containers cannot reach client ports `3000` or `7777` through the
  sidecar bridge IP.
- Approved mesh peers can reach both client services.
- Root public ports remain reachable through Docker publication.
- Removing the tunnel or killing the daemon cannot route `10.44.0.0/16` through `eth0`.
- Ordinary outbound Internet and configured S3 access continue to work.
- IPv6 cannot bypass the inbound service policy.

### Integration checks

- Run two storage-client projects on one host and confirm distinct identities, volumes, and
  namespaces.
- Exercise direct UDP and FIPS fallback separately.
- Run the existing Blossom and relay protocol smoke tests through the meshless development
  topology.
- Run a real two-node NVPN integration test when Internet relay access is available.

## Files to Change

| File                                    | Change                                                      |
| --------------------------------------- | ----------------------------------------------------------- |
| `nvpn/Dockerfile`                       | Pinned/checksummed `4.0.87` multi-arch image                |
| `nvpn/compose.yml`                      | Shared capability, device, environment, and health settings |
| `nvpn/entrypoint.sh`                    | Atomic bootstrap, role validation, and daemon supervisor    |
| `nvpn/firewall.sh`                      | Split-tunnel inbound and route leak protection              |
| `nvpn/healthcheck.sh`                   | Initialization, firewall, and daemon-state health           |
| `nvpn/README.md`                        | Generic sidecar contract and supported platforms            |
| `docker-compose.yml`                    | Root sidecar namespace and per-project state volume         |
| `storage-client/docker-compose.yml`     | Client sidecar namespace; remove app publications           |
| `storage-client/compose.direct-udp.yml` | Optional same-port UDP publication                          |
| `docker-compose.dev.yml`                | Meshless root development topology                          |
| `storage-client/docker-compose.dev.yml` | Meshless backend development topology                       |
| `.env.example`                          | NVPN settings while preserving local URL defaults           |
| `storage-client/.env.example`           | Client NVPN settings and join instructions                  |
| `scripts/nvpn-invite.sh`                | Terminal-only invite generation                             |
| `scripts/nvpn-join.sh`                  | Stdin-only, one-shot client bootstrap                       |
| `scripts/nvpn-approve.sh`               | Validated `add-device --device ... --publish` wrapper       |
| `scripts/docker-smoke-test.sh`          | Explicit meshless files and no fixed container names        |
| `README.md`                             | Production operator flow, recovery, and security boundaries |

## Upstream References

- NVPN `v4.0.87` release: <https://github.com/mmalmi/nostr-vpn/releases/tag/v4.0.87>
- NVPN CLI arguments at the release commit:
  <https://github.com/mmalmi/nostr-vpn/blob/9f5d7017f3e7248f9679824481f2ff7a5ca6dd83/crates/nostr-vpn-cli/src/main/cli_args.rs>
- NVPN protocol at the release commit:
  <https://github.com/mmalmi/nostr-vpn/blob/9f5d7017f3e7248f9679824481f2ff7a5ca6dd83/docs/protocol.md>
- NVPN Umbrel runtime:
  <https://github.com/mmalmi/nostr-vpn/tree/9f5d7017f3e7248f9679824481f2ff7a5ca6dd83/umbrel>
- Gluetun container sharing pattern:
  <https://github.com/qdm12/gluetun-wiki/blob/main/setup/connect-a-container-to-gluetun.md>
- Gluetun firewall model:
  <https://github.com/qdm12/gluetun-wiki/blob/main/faq/firewall.md>
- Docker Compose `extends`:
  <https://docs.docker.com/compose/how-tos/multiple-compose-files/extends/>
