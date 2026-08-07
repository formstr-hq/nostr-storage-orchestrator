#!/usr/bin/env bash
# End-to-end smoke test for the orchestrator's docker-compose stack.
#
# Brings up storage-client's backends (if not already running) plus the root
# stack (postgres, db-api, blossom proxy, relay proxy), waits for everything
# to become reachable, then drives the real HTTP/WebSocket protocols through
# packages/smoke-test.
#
# Deliberately uses the meshless docker-compose.dev.yml files (not
# docker-compose.yml, which requires the NVPN sidecar) so this test stays
# independent of NVPN state, invites, or operator .env values — see
# docs/NVPN_SIDECAR_PLAN.md section 6. Container names are resolved via
# `docker compose ps -q` rather than assumed, since the mesh compose files
# drop fixed container_name fields.
#
# Env vars:
#   KEEP_UP=1   leave the root docker-compose stack running after the test
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

KEEP_UP="${KEEP_UP:-0}"

log() { echo "[smoke-test] $*"; }

root_compose() { docker compose -f docker-compose.dev.yml "$@"; }
storage_compose() { (cd storage-client && docker compose -f docker-compose.dev.yml "$@"); }

cleanup() {
  if [ "${KEEP_UP}" != "1" ]; then
    log "tearing down root docker-compose stack (set KEEP_UP=1 to skip this)"
    root_compose down --remove-orphans >/dev/null 2>&1 || true
  else
    log "KEEP_UP=1 — leaving the root docker-compose stack running"
  fi
}
trap cleanup EXIT

wait_for_tcp() {
  local host="$1" port="$2" timeout="${3:-60}" waited=0
  while ! (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; do
    waited=$((waited + 1))
    if [ "${waited}" -ge "${timeout}" ]; then
      return 1
    fi
    sleep 1
  done
  exec 3>&- 3<&- 2>/dev/null || true
  return 0
}

# $1: resolver function name returning a container id (e.g. `root_compose ps -q db`)
# $2: label for log messages, $3: timeout in seconds
wait_for_healthy() {
  local resolver="$1" label="$2" timeout="${3:-120}" waited=0 cid status
  while :; do
    cid="$("${resolver}")"
    status="missing"
    if [ -n "${cid}" ]; then
      status="$(docker inspect -f '{{.State.Health.Status}}' "${cid}" 2>/dev/null || echo missing)"
    fi
    [ "${status}" = "healthy" ] && return 0
    waited=$((waited + 1))
    if [ "${waited}" -ge "${timeout}" ]; then
      log "${label} did not become healthy (last status: ${status})"
      return 1
    fi
    sleep 1
  done
}

root_db_id() { root_compose ps -q db; }
storage_blossom_id() { storage_compose ps -q blossom; }

log "step 1/5: ensuring .env files exist"
if [ ! -f .env ]; then
  log "creating .env from .env.example"
  cp .env.example .env
fi
if [ ! -f storage-client/.env ]; then
  log "creating storage-client/.env from storage-client/.env.example"
  cp storage-client/.env.example storage-client/.env
fi

# Read BLOSSOM_PORT from storage-client/.env for log messages below.
BLOSSOM_STORAGE_PORT="$(grep -m1 '^BLOSSOM_PORT=' storage-client/.env | cut -d= -f2 || echo 3000)"

log "step 2/5: ensuring storage-client backends are reachable (blossom :${BLOSSOM_STORAGE_PORT}, strfry :7777)"
if wait_for_tcp localhost "${BLOSSOM_STORAGE_PORT}" 1 && wait_for_tcp localhost 7777 1; then
  log "storage-client backends already running"
else
  log "starting storage-client backends..."
  storage_compose up --build -d
  log "waiting for storage-client blossom backend to become healthy (Deno startup can take ~30s)..."
  wait_for_healthy storage_blossom_id "storage-client blossom backend (:${BLOSSOM_STORAGE_PORT})" 120 || { storage_compose logs blossom; exit 1; }
  wait_for_tcp localhost 7777 60 || { log "storage-client strfry backend (:7777) did not come up"; exit 1; }
  log "storage-client backends are up and left running for reuse;"
  log "stop them manually with: (cd storage-client && docker compose -f docker-compose.dev.yml down)"
fi

log "step 3/5: building and starting the root docker-compose stack"
root_compose up --build -d

log "step 4/5: waiting for services to become healthy"
wait_for_healthy root_db_id "db-api" 120 || { root_compose logs db; exit 1; }
wait_for_tcp localhost 3001 60 || { log "blossom proxy (:3001) did not come up"; root_compose logs blossom; exit 1; }
wait_for_tcp localhost 8007 60 || { log "relay proxy (:8007) did not come up"; root_compose logs relay; exit 1; }
log "all services are up"

log "step 5/5: running protocol-level checks (packages/smoke-test)"
pnpm install >/dev/null
pnpm --filter @orchestrator/smoke-test run smoke
