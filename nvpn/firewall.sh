#!/bin/bash
# Split-tunnel inbound and route-leak firewall for the NVPN sidecar's own
# network namespace (shared by app containers via network_mode: service:nvpn).
# See ../docs/NVPN_SIDECAR_PLAN.md section 2. Idempotent: safe to call
# `firewall.sh install` repeatedly — it flushes and rebuilds its own chains
# each time rather than accumulating rules.
#
# `nvpn status --json` has no tunnel-interface field (verified against
# v4.0.87) — the interface is simply whatever `nvpn start --iface` was given,
# so entrypoint.sh and this script both read it from NVPN_TUN_IFACE rather
# than trying to discover it.
set -euo pipefail

ROLE="${NVPN_ROLE:?set NVPN_ROLE to proxy or client}"
CONFIG="${XDG_CONFIG_HOME:?}/nvpn/config.toml"
PRIVATE_CIDR="${NVPN_PRIVATE_CIDR:-10.44.0.0/16}"
LISTEN_PORT="${NVPN_LISTEN_PORT:-51820}"
TUN_IFACE="${NVPN_TUN_IFACE:-nvpn0}"

log() { echo "[nvpn:${ROLE}:firewall] $*" >&2; }

detect_bridge_iface() {
  # The interface with the default route is the Compose bridge attachment
  # (conventionally eth0) — Docker's published-port DNAT path arrives here.
  ip -o route show default 2>/dev/null | awk '{print $5}' | head -n1
}

detect_tunnel_iface() {
  # Only report the tunnel once it actually exists; before that the caller
  # installs the blanket mesh-CIDR reject instead.
  ip link show "${TUN_IFACE}" >/dev/null 2>&1 && printf '%s' "${TUN_IFACE}"
}

install_chain() {
  local fam="$1" chain="$2" builtin="$3"
  "${fam}" -N "${chain}" 2>/dev/null || "${fam}" -F "${chain}"
  "${fam}" -C "${builtin}" -j "${chain}" 2>/dev/null || "${fam}" -I "${builtin}" 1 -j "${chain}"
}

main() {
  [ "${1:-}" = install ] || { log "usage: firewall.sh install"; exit 1; }

  local bridge_iface tun_iface
  bridge_iface="$(detect_bridge_iface)"
  [ -n "${bridge_iface}" ] || { log "FATAL: could not detect the bridge interface (no default route)"; exit 1; }
  tun_iface="$(detect_tunnel_iface || true)"

  for fam in iptables ip6tables; do
    install_chain "${fam}" NVPN_INPUT INPUT
    install_chain "${fam}" NVPN_OUTPUT OUTPUT
    "${fam}" -A NVPN_INPUT -i lo -j ACCEPT
    "${fam}" -A NVPN_INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  done

  # NVPN's own UDP listener must be reachable on the bridge for bootstrap/direct-UDP.
  iptables  -A NVPN_INPUT -i "${bridge_iface}" -p udp --dport "${LISTEN_PORT}" -j ACCEPT
  ip6tables -A NVPN_INPUT -i "${bridge_iface}" -p udp --dport "${LISTEN_PORT}" -j ACCEPT

  if [ "${ROLE}" = proxy ]; then
    IFS=',' read -ra public_ports <<<"${NVPN_PUBLIC_INPUT_PORTS:-}"
    for p in "${public_ports[@]}"; do
      [ -n "${p}" ] || continue
      # Docker's published-port path also arrives on the bridge interface.
      iptables  -A NVPN_INPUT -i "${bridge_iface}" -p tcp --dport "${p}" -j ACCEPT
      ip6tables -A NVPN_INPUT -i "${bridge_iface}" -p tcp --dport "${p}" -j ACCEPT
    done
  fi

  IFS=',' read -ra mesh_ports <<<"${NVPN_MESH_INPUT_PORTS:-}"
  for p in "${mesh_ports[@]}"; do
    [ -n "${p}" ] || continue
    iptables  -A NVPN_INPUT -i lo -p tcp --dport "${p}" -j ACCEPT
    ip6tables -A NVPN_INPUT -i lo -p tcp --dport "${p}" -j ACCEPT
    if [ -n "${tun_iface}" ]; then
      iptables -A NVPN_INPUT -i "${tun_iface}" -p tcp --dport "${p}" -j ACCEPT
    fi
    # Explicit reject from the bridge so sibling bridge containers/the host
    # cannot reach mesh-only app ports even without a published port mapping.
    iptables  -A NVPN_INPUT -i "${bridge_iface}" -p tcp --dport "${p}" -j REJECT --reject-with tcp-reset
    ip6tables -A NVPN_INPUT -i "${bridge_iface}" -p tcp --dport "${p}" -j REJECT --reject-with tcp-reset
  done

  # Split-tunnel leak guard: private-mesh-destined traffic must never leave
  # via a non-tunnel interface. Fail closed (block all of it) until the
  # tunnel interface is known, rather than allowing it out unrestricted.
  # /data/.firewall-applied records whether this pass saw the tunnel. The
  # supervisor in entrypoint.sh keeps re-running us while it says `notun`,
  # so a slow-to-appear tunnel can't strand the namespace in the fully
  # blocked state (which silently kills all mesh traffic).
  if [ -n "${tun_iface}" ]; then
    iptables -A NVPN_OUTPUT -d "${PRIVATE_CIDR}" ! -o "${tun_iface}" -j REJECT
    log "installed (bridge=${bridge_iface}, tunnel=${tun_iface})"
    echo "tun=${tun_iface}" >/data/.firewall-applied
  else
    iptables -A NVPN_OUTPUT -d "${PRIVATE_CIDR}" -j REJECT
    log "installed (bridge=${bridge_iface}, tunnel not yet known — mesh-CIDR egress fully blocked until next reinstall)"
    echo "notun" >/data/.firewall-applied
  fi
}

main "$@"
