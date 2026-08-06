#!/usr/bin/env bash
# Promote an npub to a co-admin of this proxy's mesh network.
#
# This is the one step that removes the "someone must SSH into the server to
# approve every client" bottleneck. Run it once per admin. From then on that
# admin can generate invites and approve storage clients from their own
# machine or phone; the proxy picks up their signed roster over Nostr on its
# own, with nobody logging in here.
#
# Usage:
#   scripts/nvpn-add-admin.sh <admin-npub>
#
# The admin must already have joined this network (they need the network
# config before they can sign rosters for it), so the full sequence is:
#
#   1. here:        scripts/nvpn-invite.sh          → send the invite to them
#   2. their side:  nvpn import-invite '<invite>'   → prints their npub
#   3. here:        scripts/nvpn-add-admin.sh <their-npub>
#
# See README.md "Delegated admins".
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

ADMIN_NPUB="${1:-}"
if [ -z "${ADMIN_NPUB}" ]; then
  echo "usage: $0 <admin-npub>" >&2
  exit 1
fi
if ! [[ "${ADMIN_NPUB}" =~ ^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$ ]]; then
  echo "'${ADMIN_NPUB}' does not look like a valid npub" >&2
  exit 1
fi

cat >&2 <<EOF

  You are granting ${ADMIN_NPUB} ADMIN rights on this mesh.

  An admin can add and remove any device on this network, including revoking
  others. Only do this for an operator you would otherwise hand server access
  to — it is a comparable level of trust, just scoped to the mesh roster
  rather than to the host.

EOF
read -rp "Proceed? [y/N] " reply
[[ "${reply}" =~ ^[Yy]$ ]] || { echo "aborted" >&2; exit 1; }

nvpn_cli() {
  local sub="$1"; shift
  docker compose exec -T nvpn nvpn "${sub}" --config /data/config/nvpn/config.toml "$@"
}

# An admin must also be a device on the roster — `add-admin` alone grants the
# signing right without giving them a place in the network they sign for.
nvpn_cli add-device --device "${ADMIN_NPUB}" --publish >/dev/null
nvpn_cli add-admin  --device "${ADMIN_NPUB}" --publish >/dev/null

# Apply to the running daemon in place, so the sidecar (and the network
# namespace blossom/relay share with it) is never recreated.
nvpn_cli reload >/dev/null

echo >&2
echo "${ADMIN_NPUB} is now an admin." >&2
echo "They can now run 'nvpn create-invite' and 'nvpn add-device --publish' from" >&2
echo "their own machine; this proxy will pick up their signed roster over Nostr." >&2
echo >&2
echo "Current admins:" >&2
nvpn_cli status --json | jq -r '.network_id as $n | "  network \($n)"' >&2 || true
docker compose exec -T nvpn sh -c \
  'sed -n "/^admins/,/]/p" "$XDG_CONFIG_HOME/nvpn/config.toml"' >&2 || true
