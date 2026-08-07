#!/bin/bash
# Healthy = initialization complete for this role, firewall active, the
# tunnel interface exists, and the daemon is running. Deliberately does NOT
# require an approved mesh peer — a fresh client waiting on proxy-side
# approval, and a proxy with nobody approved yet, must both still go healthy.
# (Concretely: with an empty roster the daemon reports
# vpn_status="Waiting for participants" and vpn_active=false, so vpn_active
# is NOT a usable health signal here.)
# See ../docs/NVPN_SIDECAR_PLAN.md section 1.
#
# Verified against nvpn v4.0.87: `nvpn status --json` has no top-level
# `.state`; liveness lives under `.daemon.running`, and `.daemon.state` is
# only populated when the daemon was started with `--daemon`
# (entrypoint.sh does).
set -euo pipefail

ROLE="${NVPN_ROLE:?}"
CONFIG="${XDG_CONFIG_HOME:?}/nvpn/config.toml"
TUN_IFACE="${NVPN_TUN_IFACE:-nvpn0}"
MARKER=/data/.sidecar-complete

[ -f "${MARKER}" ] || exit 1
[ -f "${CONFIG}" ] || exit 1
[ -f /data/.firewall-applied ] || exit 1

marker_role="$(jq -r '.role // empty' "${MARKER}" 2>/dev/null || true)"
[ "${marker_role}" = "${ROLE}" ] || exit 1

ip link show "${TUN_IFACE}" >/dev/null 2>&1 || exit 1

status_json="$(nvpn status --config "${CONFIG}" --json 2>/dev/null)" || exit 1
printf '%s' "${status_json}" \
  | jq -e '.daemon.running == true' >/dev/null 2>&1 || exit 1

exit 0
