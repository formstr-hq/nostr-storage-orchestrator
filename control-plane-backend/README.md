# Control plane backend

Rust/Axum control-plane API for DB-backed members and storage machines. NIP-98
event decoding, URL/payload verification, signatures, and NIP-19 keys use the
pinned `nostr` crate. The nVPN CLI is used only for host roster operations and
host-authoritative peer status.

## API

| Method | Route | Authorization |
|---|---|---|
| `GET` | `/health` | None |
| `GET` | `/v1/me` | Valid NIP-98 signature; absent/revoked members receive role `none` |
| `GET` | `/v1/status` | Active admin |
| `GET` | `/v1/roster` | Active admin |
| `GET` | `/v1/members` | Active admin |
| `POST` | `/v1/members` | Active admin; `{"npub":"...","role":"client"|"admin"}` |
| `POST` | `/v1/members/remove` | Active admin; `{"npub":"..."}` |
| `POST` | `/v1/invites` | Active member; empty body or `{}` |
| `GET` | `/v1/storages` | Admin sees all; active client sees only owned storage |
| `POST` | `/v1/storage` | Active member; `{"npub":"..."}` links storage to caller |
| `POST` | `/v1/storage/ping` | Existing linked storage identity |
| `POST` | `/v1/storage/:npub/capacity` | Owner or admin |
| `POST` | `/v1/storage/:npub/remove` | Owner or admin; empty body or `{}` |

All public roles, statuses, and liveness values are lowercase. The internal
db-api contract uses uppercase enum values (`ADMIN`, `ACTIVE`, `LINKED`, etc.)
and decimal strings for BigInt capacity fields. `POST /v1/invites` returns only
`{"invite":"nvpn://invite/..."}`; the invite is self-sufficient.

The old `/v1/devices` and `/v1/devices/remove` routes do not exist. Storage
linking owns mesh enrollment. A storage npub can be reactivated by its existing
owner but can never be reassigned. Member revocation marks the member revoked,
marks each linked storage removed, and then removes each mesh device. Storage
removal follows the same lifecycle-first ordering. If a later nVPN operation
fails, the API returns a partial-cleanup error that states which authoritative
DB change already happened.

An admin cannot revoke themselves. Revoking or demoting the last active admin
is also rejected.

## Ping trust boundary

The ping body is:

```json
{
  "blossomPort": 3000,
  "relayPort": 7777,
  "reportedTotalBytes": "1000000000",
  "reportedFreeBytes": "750000000"
}
```

There is deliberately no `tunnelIp`. The host resolves it by matching the
signing storage npub to `fips_endpoint_npub` in its own `nvpn status --json`,
removes any CIDR suffix, and requires the result to be inside
`NVPN_PRIVATE_CIDR`. Peer status is cached for 15 seconds by default.

Ports are trusted after validation to `1024..=65535`; they are not checked
against per-peer firewall policy. This is a weaker SSRF posture than an
allowlist of fixed service ports: a storage key can select any unprivileged
port on its own host-resolved mesh IP. It cannot choose another IP, a service
name, or a non-mesh address. Operators should keep the mesh firewall's allowed
ports narrow.

Capacity is self-reported, not verified. Both fields must be decimal strings,
and free bytes cannot exceed total bytes. A report whose peer cannot be safely
resolved records capacity but does not update `lastPingAt`, so it cannot enter
active backend rotation.

## Authentication

Signature verification is separate from authorization. Every request is
checked against its exact configured URL, method, current NIP-98 timestamp
window, and unchanged POST bytes. Successful mutation events are accepted once
within the 90-second replay window. The resulting npub is then authorized as an
active member, admin, owner, or linked storage as required by the route.

`ADMIN_ALLOWED_PUBKEYS` is not an allowlist after startup. It is an optional
bootstrap seed used only when `GET /members` returns an empty member table.

## Configuration

| Variable | Required/default | Meaning |
|---|---|---|
| `DB_API_URL` | `http://db:4000` | Internal db-api base URL |
| `ADMIN_PUBLIC_URL` | Required in release | Exact public NIP-98 base URL |
| `CONTROL_PLANE_MESH_URL` | Host nVPN `tunnel_ip` + API port | Exact internal NIP-98 base used by storage pings |
| `NVPN_PRIVATE_CIDR` | `10.44.0.0/16` | Allowed host-resolved peer addresses |
| `ACTIVE_FRESHNESS_SECS` | `960` | Last-ping active window |
| `PENDING_REAP_SECS` | `86400` | Grace before never-pinged linked rows are removed |
| `PING_PEER_CACHE_SECS` | `15` | nVPN status peer cache lifetime |
| `ADMIN_ALLOWED_PUBKEYS` | Optional | Comma-separated bootstrap admin npubs or hex keys |
| `ADMIN_API_PORT` | `3002` | Listen port |
| `NVPN_CONFIG` | `/data/config/nvpn/config.toml` | nVPN host config |
| `NVPN_BIN` | `nvpn` | nVPN executable |

When the mesh URL is unset, the backend reads the host's assigned `tunnel_ip`
from `NVPN_CONFIG`. Set it explicitly only for a non-standard listener address.

## db-api contract

The thin client expects the plan's internal methods: member list/get/upsert/
soft-delete, storage list/get/create/patch/soft-delete, and `GET /plans`.
Responses are direct member/storage arrays or objects with camelCase fields,
uppercase enum values, ISO-8601 timestamps, and decimal-string BigInts.

## Development

```bash
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Build the container from the repository root:

```bash
docker build -f control-plane-backend/Dockerfile -t formstr-control-plane-backend .
```
