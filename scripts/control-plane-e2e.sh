#!/usr/bin/env bash
# Destructive end-to-end test for DB-backed self-service enrollment. This uses
# fresh host/client nVPN volumes, then removes them unless KEEP_UP=1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

KEEP_UP="${KEEP_UP:-0}"
TIMEOUT="${CONTROL_PLANE_E2E_TIMEOUT:-240}"
API_PORT="${ADMIN_API_PORT:-3002}"
API_URL="http://127.0.0.1:${API_PORT}"

log() { echo "[control-plane-e2e] $*"; }
root_compose() { docker compose -f docker-compose.yml "$@"; }
client_compose() { (cd storage-client && docker compose "$@"); }
api() {
  local nsec="$1" method="$2" path="$3" body="${4:-}"
  if [ "${method}" = GET ]; then
    CONTROL_PLANE_NSEC="${nsec}" pnpm --silent --filter @orchestrator/smoke-test \
      run control-plane request GET "${API_URL}${path}"
  else
    [ -n "${body}" ] || body='{}'
    CONTROL_PLANE_NSEC="${nsec}" pnpm --silent --filter @orchestrator/smoke-test \
      run control-plane request POST "${API_URL}${path}" "${body}"
  fi
}

cleanup() {
  if [ "${KEEP_UP}" = 1 ]; then
    log "KEEP_UP=1; leaving disposable stacks running"
    return
  fi
  client_compose --profile agent down --remove-orphans >/dev/null 2>&1 || true
  root_compose down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

for command in docker jq pnpm curl; do
  command -v "${command}" >/dev/null || { log "missing command: ${command}"; exit 1; }
done
[ -e /dev/net/tun ] || { log "/dev/net/tun is required"; exit 1; }
[ -f .env ] || cp .env.example .env
[ -f storage-client/.env ] || cp storage-client/.env.example storage-client/.env

log "resetting disposable host/client state"
client_compose --profile agent down --remove-orphans >/dev/null 2>&1 || true
root_compose down --remove-orphans >/dev/null 2>&1 || true
docker volume rm -f "$(basename "${ROOT_DIR}")_nvpn_data" storage-client_nvpn_data \
  "$(basename "${ROOT_DIR}")_nso_postgres_data" >/dev/null 2>&1 || true

admin_identity="$(pnpm --silent --filter @orchestrator/smoke-test run control-plane identity)"
client_identity="$(pnpm --silent --filter @orchestrator/smoke-test run control-plane identity)"
admin_npub="$(jq -r .npub <<<"${admin_identity}")"
admin_nsec="$(jq -r .nsec <<<"${admin_identity}")"
client_npub="$(jq -r .npub <<<"${client_identity}")"
client_nsec="$(jq -r .nsec <<<"${client_identity}")"
unset admin_identity client_identity

log "starting host with a bootstrap admin"
export ADMIN_ALLOWED_PUBKEYS="${admin_npub}"
export ADMIN_PUBLIC_URL="${API_URL}"
root_compose up -d --build

ready=0
for _ in $(seq 1 "${TIMEOUT}"); do
  if curl -fsS "${API_URL}/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "${ready}" = 1 ] || { log "control plane did not become healthy"; exit 1; }

log "authorizing client member"
api "${admin_nsec}" POST /v1/members \
  "$(jq -cn --arg npub "${client_npub}" '{npub:$npub,role:"client"}')" >/dev/null

log "client requesting its own invite"
invite_response="$(api "${client_nsec}" POST /v1/invites '{}')"
invite="$(jq -r .invite <<<"${invite_response}")"
unset invite_response
[ "${invite}" != null ] && [ -n "${invite}" ] || { log "invite response was empty"; exit 1; }

log "bootstrapping a distinct storage identity"
client_compose build nvpn >/dev/null
storage_npub="$(printf '%s\n' "${invite}" \
  | client_compose run --rm --no-deps -T nvpn bootstrap-client \
  | tr -d '\r' | grep -o 'npub1[a-z0-9]*' | head -n1)"
unset invite
[ -n "${storage_npub}" ] || { log "storage bootstrap returned no npub"; exit 1; }

log "client linking and approving its storage"
api "${client_nsec}" POST /v1/storage \
  "$(jq -cn --arg npub "${storage_npub}" '{npub:$npub}')" >/dev/null
unset admin_nsec client_nsec

log "starting storage backends and reporting agent"
client_compose --profile agent up -d --build

active=0
for _ in $(seq 1 "${TIMEOUT}"); do
  if curl -fsS "http://127.0.0.1:${DB_API_PORT:-4000}/storages/active" 2>/dev/null \
      | jq -e --arg npub "${storage_npub}" 'any(.[]; .npub == $npub)' >/dev/null 2>&1; then
    active=1
    break
  fi
  sleep 1
done
[ "${active}" = 1 ] || { log "storage-agent never made the storage active"; exit 1; }

log "waiting one registry poll, then running protocol smoke checks"
sleep "${STORAGE_REGISTRY_POLL_SECS:-16}"
pnpm --filter @orchestrator/smoke-test run smoke
log "control-plane enrollment, mesh ping, dynamic registry, and protocol checks passed"
