#!/usr/bin/env bash
# Print only the host mesh identity and addresses needed by storage operators.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

host_npub="$(docker compose exec -T nvpn jq -er '.npub' /data/.sidecar-complete)"
iface_line="$(docker compose exec -T nvpn sh -eu -c 'ip -o -4 addr show "${NVPN_TUN_IFACE:-nvpn0}"')"
read -r _ _ _ host_cidr _ <<<"${iface_line}"
host_ip="${host_cidr%/*}"
api_port="$(docker compose exec -T admin sh -eu -c 'printf %s "${ADMIN_API_PORT:-3002}"')"

printf 'HOST_NPUB=%s\nHOST_TUNNEL_IP=%s\nCONTROL_PLANE_API_PORT=%s\n' \
  "${host_npub}" "${host_ip}" "${api_port}"
