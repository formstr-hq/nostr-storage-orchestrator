#!/usr/bin/env bash
# End-to-end test of the NVPN mesh topology: brings up the root proxy stack
# (the "host"), joins a storage-client to its mesh through the real
# invite/join/approve flow, points the proxies at the client's tunnel IP, and
# runs the protocol checks in packages/smoke-test across that tunnel.
#
# This is the mesh counterpart to scripts/docker-smoke-test.sh, which
# deliberately tests the meshless docker-compose.dev.yml topology instead.
# Between them, both topologies in the repo are covered.
#
# Requires a fresh mesh identity on both sides, so it recreates the two
# `nvpn_data` volumes — do NOT run this against a stack whose mesh identity
# you care about (it would invalidate every invite you have handed out).
#
# Env vars:
#   KEEP_UP=1   leave both stacks running after the test
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

KEEP_UP="${KEEP_UP:-0}"
MESH_TIMEOUT="${MESH_TIMEOUT:-180}"

log() { echo "[mesh-e2e] $*"; }

root_compose() { docker compose -f docker-compose.yml "$@"; }
mesh_compose() { docker compose -f docker-compose.yml -f compose.mesh-e2e.yml "$@"; }
client_compose() { (cd storage-client && docker compose "$@"); }

cleanup() {
  if [ "${KEEP_UP}" != "1" ]; then
    log "tearing down both stacks (set KEEP_UP=1 to skip this)"
    client_compose down --remove-orphans >/dev/null 2>&1 || true
    root_compose down --remove-orphans >/dev/null 2>&1 || true
  else
    log "KEEP_UP=1 — leaving both stacks running"
  fi
}
trap cleanup EXIT

# Runs `nvpn <subcommand> [args]` inside a stack's sidecar against its own
# config. `--config` is a per-subcommand flag, not a global one, so it has to
# go after the subcommand.
proxy_nvpn() {
  local sub="$1"; shift
  root_compose exec -T nvpn nvpn "${sub}" --config /data/config/nvpn/config.toml "$@"
}
client_nvpn() {
  local sub="$1"; shift
  client_compose exec -T nvpn nvpn "${sub}" --config /data/config/nvpn/config.toml "$@"
}

log "step 1/7: resetting mesh state and bringing up the host (proxy) stack"
[ -f .env ] || cp .env.example .env
[ -f storage-client/.env ] || cp storage-client/.env.example storage-client/.env

client_compose down --remove-orphans >/dev/null 2>&1 || true
root_compose down --remove-orphans >/dev/null 2>&1 || true
# Fresh identities on both sides: a reused proxy identity still holds the
# previous run's approvals, which would let a broken join flow appear to pass.
docker volume rm -f "$(basename "${ROOT_DIR}")_nvpn_data" >/dev/null 2>&1 || true
docker volume rm -f storage-client_nvpn_data >/dev/null 2>&1 || true

root_compose up -d --build
log "host stack up"

log "step 2/7: generating a mesh invite on the host"
invite="$(proxy_nvpn create-invite | tr -d '\r' | grep -o 'nvpn://invite/[A-Za-z0-9_=-]*' | head -n1)"
[ -n "${invite}" ] || { log "FAIL: could not generate an invite"; root_compose logs nvpn; exit 1; }
log "invite generated (${#invite} chars, not printed — it is a bearer credential)"

log "step 3/7: joining the client to the mesh"
client_compose build >/dev/null
client_npub="$(printf '%s\n' "${invite}" \
  | client_compose run --rm --no-deps -T nvpn bootstrap-client \
  | tr -d '\r' | grep -o 'npub1[a-z0-9]*' | head -n1)"
[ -n "${client_npub}" ] || { log "FAIL: client bootstrap produced no npub"; exit 1; }
log "client joined as ${client_npub}"

log "step 4/7: approving the client on the host"
./scripts/nvpn-approve.sh "${client_npub}" >/dev/null
client_compose up -d
log "client stack up"

log "step 5/7: waiting for the two sidecars to peer (up to ${MESH_TIMEOUT}s)"
client_ip=""
waited=0
while [ "${waited}" -lt "${MESH_TIMEOUT}" ]; do
  # Authoritative direction: the host must see the client as reachable, since
  # that is the direction the proxies actually send traffic.
  if proxy_nvpn status --json 2>/dev/null \
      | jq -e '[.daemon.state.peers[]? | select(.reachable == true)] | length > 0' >/dev/null 2>&1; then
    client_ip="$(client_nvpn status --json 2>/dev/null | jq -r '.tunnel_ip // empty' | cut -d/ -f1)"
    [ -n "${client_ip}" ] && break
  fi
  sleep 5
  waited=$((waited + 5))
done

if [ -z "${client_ip}" ]; then
  log "FAIL: host and client did not peer within ${MESH_TIMEOUT}s"
  log "--- host sidecar status ---"; proxy_nvpn status --json || true
  log "--- client sidecar status ---"; client_nvpn status --json || true
  exit 1
fi
log "mesh established; client tunnel IP is ${client_ip}"

log "step 6/7: pointing the host's proxies at the client's backends over the mesh"
export MESH_BLOSSOM_SERVERS="http://${client_ip}:3000"
export MESH_BACKEND_RELAYS="ws://${client_ip}:7777"
mesh_compose up -d --force-recreate blossom relay

# The proxies bind inside the sidecar's namespace; the sidecar publishes them.
for port in "${BLOSSOM_PORT:-3001}" "${RELAY_PORT:-8007}"; do
  waited=0
  until (exec 3<>"/dev/tcp/localhost/${port}") 2>/dev/null; do
    waited=$((waited + 1))
    [ "${waited}" -ge 60 ] && { log "FAIL: port ${port} never came up"; root_compose logs blossom relay; exit 1; }
    sleep 1
  done
done
log "proxies listening on :${BLOSSOM_PORT:-3001} and :${RELAY_PORT:-8007}"

log "step 7/7: running protocol-level checks across the mesh (packages/smoke-test)"
pnpm --filter @orchestrator/smoke-test run smoke
log "mesh e2e passed — every blob and relay operation above crossed the NVPN tunnel"
