#!/usr/bin/env bash
# Approve a pending NVPN join request from the root proxy's sidecar.
# Usage: scripts/nvpn-approve.sh <client-npub>
# See ../docs/NVPN_SIDECAR_PLAN.md section 5.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

CLIENT_NPUB="${1:-}"
if [ -z "${CLIENT_NPUB}" ]; then
  echo "usage: $0 <client-npub>" >&2
  exit 1
fi
if ! [[ "${CLIENT_NPUB}" =~ ^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$ ]]; then
  echo "'${CLIENT_NPUB}' does not look like a valid npub" >&2
  exit 1
fi

docker compose exec nvpn sh -c \
  'nvpn add-device --config "$XDG_CONFIG_HOME/nvpn/config.toml" --device "$1" --publish' \
  _ "${CLIENT_NPUB}"

# add-device only edits the config; the running daemon has to be told to pick
# up the new roster. `reload` works because entrypoint.sh runs the daemon via
# `nvpn start --daemon` — this avoids recreating the sidecar, which would tear
# down the network namespace blossom/relay share with it.
docker compose exec nvpn sh -c \
  'nvpn reload --config "$XDG_CONFIG_HOME/nvpn/config.toml"'

echo "Approved ${CLIENT_NPUB}. Once the roster syncs, look up its tunnel IP with:" >&2
echo '  docker compose exec nvpn sh -c '"'"'nvpn status --config "$XDG_CONFIG_HOME/nvpn/config.toml" --json'"'"'' >&2
echo "...then point BLOSSOM_SERVERS/BACKEND_RELAYS at it and restart the proxy services (not the nvpn sidecar)." >&2
