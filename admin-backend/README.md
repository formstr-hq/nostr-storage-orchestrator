# Admin backend

Rust/Axum API for authenticated nVPN administration. All Nostr event decoding, NIP-98
payload verification, event ID/signature verification, and NIP-19 key handling is delegated
to the pinned `nostr = 0.45.0` crate.

## API

| Method | Route | Authentication | Response |
|---|---|---|---|
| `GET` | `/health` | None | `{"status":"ok"}` |
| `GET` | `/v1/status` | NIP-98 | `known_clients`, `connected_clients`, and sanitized `peers` |
| `POST` | `/v1/invites` | NIP-98 with payload | `{"invite":"nvpn://invite/..."}` |
| `POST` | `/v1/devices` | NIP-98 with payload | `{"npub":"...","added":true}` |

`POST /v1/invites` accepts an empty body or `{}`. `POST /v1/devices` accepts exactly
`{"npub":"<full canonical npub>"}`. Request bodies are limited to 4 KiB.

nVPN's host invite is a reusable bearer credential, not a single-use token. Operators should
share it only over a secure channel and rotate the host invite secret after suspected exposure.

Every protected request is verified with `nostr::nips::nip98::verify_auth_header`, the
matching NIP-98 HTTP method, `Timestamp::now()`, and the exact external route built from
`ADMIN_PUBLIC_URL`. POST bodies are passed unchanged to the verifier, so a payload tag is
required and must match. The pubkey returned by the verifier must then be in the allowlist.
Forwarded or `Host` headers never alter the signed URL.

Successful mutation authorization event IDs are retained for 90 seconds and may be used only
once, preventing replay during NIP-98's timestamp-validity window.

`GET /v1/status` reads `.daemon.state.peers` from `nvpn status --json`. A client is connected
only when its peer has `reachable=true`; raw nVPN status fields are not forwarded.

## Configuration

| Variable | Required/default | Meaning |
|---|---|---|
| `ADMIN_ALLOWED_PUBKEYS` | Required | Comma-separated canonical npubs or 64-character hex public keys |
| `ADMIN_PUBLIC_URL` | Debug default `http://localhost:<port>`; required in release builds | Exact externally visible base URL, optionally including a reverse-proxy path prefix |
| `ADMIN_API_PORT` | `3002` | Listen port on `0.0.0.0` |
| `NVPN_CONFIG` | `/data/config/nvpn/config.toml` | nVPN config passed after every subcommand |
| `NVPN_BIN` | `nvpn` | nVPN executable path |

Set `ADMIN_PUBLIC_URL` to the URL clients actually sign, for example
`https://admin.example.com` or `https://example.com/admin`. Do not include an API route,
query, fragment, or credentials. The release binary fails closed if it is absent.

All nVPN commands are serialized with one async mutex. Commands have a 45-second timeout,
use `kill_on_drop`, receive no stdin, and have stderr discarded. API errors never include
command output, config contents, or invite data. Adding a device runs:

```text
nvpn add-device --config <config> --device <npub> --publish
nvpn reload --config <config>
```

## Development

```bash
ADMIN_ALLOWED_PUBKEYS=<npub-or-hex> cargo run
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

## Container

The build context must be the orchestrator root:

```bash
docker build -f admin-backend/Dockerfile -t formstr-admin-backend .
docker run --rm -p 3002:3002 \
  -e ADMIN_ALLOWED_PUBKEYS=<npub-or-hex> \
  -e ADMIN_PUBLIC_URL=https://admin.example.com \
  -v nvpn_data:/data \
  formstr-admin-backend
```

The multi-stage Dockerfile builds the Rust binary and independently downloads nVPN `4.0.87`.
The nVPN architecture selection and SHA-256 checksums exactly match `nvpn/Dockerfile` for
`amd64` and `arm64`; unsupported architectures fail the build.
