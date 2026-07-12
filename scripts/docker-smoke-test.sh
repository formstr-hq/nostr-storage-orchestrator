#!/usr/bin/env bash
# End-to-end smoke test for the orchestrator's docker-compose stack.
#
# Brings up storage-client's backends (if not already running) plus the root
# stack (postgres, db-api, blossom proxy, relay proxy), waits for everything
# to become reachable, then drives the real HTTP/WebSocket protocols through
# packages/smoke-test.
#
# Env vars:
#   KEEP_UP=1   leave the root docker-compose stack running after the test
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

KEEP_UP="${KEEP_UP:-0}"

log() { echo "[smoke-test] $*"; }

cleanup() {
  if [ "${KEEP_UP}" != "1" ]; then
    log "tearing down root docker-compose stack (set KEEP_UP=1 to skip this)"
    docker compose down --remove-orphans >/dev/null 2>&1 || true
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

wait_for_healthy() {
  local container="$1" timeout="${2:-120}" waited=0
  while [ "$(docker inspect -f '{{.State.Health.Status}}' "${container}" 2>/dev/null || echo missing)" != "healthy" ]; do
    waited=$((waited + 1))
    if [ "${waited}" -ge "${timeout}" ]; then
      return 1
    fi
    sleep 1
  done
  return 0
}

log "step 1/5: ensuring .env exists"
if [ ! -f .env ]; then
  log "creating .env from .env.example"
  cp .env.example .env
fi

log "step 2/5: ensuring storage-client backends are reachable (blossom :3000, strfry :7777)"
if wait_for_tcp localhost 3000 1 && wait_for_tcp localhost 7777 1; then
  log "storage-client backends already running"
else
  log "starting storage-client backends..."
  (cd storage-client && docker compose up --build -d)
  log "waiting for storage-client blossom backend to become healthy (Deno startup can take ~30s)..."
  wait_for_healthy blossom 120 || { log "storage-client blossom backend (:3000) did not become healthy"; (cd storage-client && docker compose logs blossom); exit 1; }
  wait_for_tcp localhost 7777 60 || { log "storage-client strfry backend (:7777) did not come up"; exit 1; }
  log "storage-client backends are up and left running for reuse;"
  log "stop them manually with: (cd storage-client && docker compose down)"
fi

log "step 3/5: building and starting the root docker-compose stack"
docker compose up --build -d

log "step 4/5: waiting for services to become healthy"
wait_for_healthy nso_db 120 || { log "db-api did not become healthy"; docker compose logs db; exit 1; }
wait_for_tcp localhost 3001 60 || { log "blossom proxy (:3001) did not come up"; docker compose logs blossom; exit 1; }
wait_for_tcp localhost 8007 60 || { log "relay proxy (:8007) did not come up"; docker compose logs relay; exit 1; }
log "all services are up"

log "step 5/5: running protocol-level checks (packages/smoke-test)"
pnpm install >/dev/null
pnpm --filter @orchestrator/smoke-test run smoke
