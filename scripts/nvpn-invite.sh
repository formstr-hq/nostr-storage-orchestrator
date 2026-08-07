#!/usr/bin/env bash
# Generate an NVPN mesh invite from the root proxy's sidecar and print it
# only to this terminal — never written to a file or Docker log. Send it to
# exactly one client operator you intend to approve.
# See ../docs/NVPN_SIDECAR_PLAN.md section 5.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "Generating an NVPN invite — send it only to the client operator you intend to approve:" >&2
docker compose exec nvpn sh -c 'nvpn create-invite --config "$XDG_CONFIG_HOME/nvpn/config.toml"'
