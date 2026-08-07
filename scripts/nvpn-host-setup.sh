#!/usr/bin/env bash
# Guided setup for the HOST (proxy) side of an NVPN mesh, run on the machine
# that serves public traffic. Its counterpart is
# storage-client/scripts/nvpn-client-setup.sh, run on the storage machine —
# the two are never on the same host, so this script pauses where a human has
# to carry a value between them.
#
# It brings up the proxy stack, prints an invite for you to send, waits for
# the client's npub, approves it, waits for the mesh to come up, then points
# BLOSSOM_SERVERS/BACKEND_RELAYS at the peer's tunnel IP and restarts only the
# proxy services.
#
# Safe to re-run: an already-initialized sidecar keeps its identity, so
# existing approvals and invites survive.
#
# Env vars:
#   PEER_TIMEOUT=300   seconds to wait for the client to become reachable
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PEER_TIMEOUT="${PEER_TIMEOUT:-300}"

log()  { echo "[host] $*" >&2; }
fail() { echo "[host] ERROR: $*" >&2; exit 1; }

nvpn_cli() {
  local sub="$1"; shift
  docker compose exec -T nvpn nvpn "${sub}" --config /data/config/nvpn/config.toml "$@"
}

# ---- step 1: config -------------------------------------------------------

log "step 1/6: checking configuration"
if [ ! -f .env ]; then
  log "creating .env from .env.example"
  cp .env.example .env
fi

if ! grep -qE '^NVPN_ENDPOINT=.+' .env; then
  cat >&2 <<'EOF'

  NVPN_ENDPOINT is not set in .env.

  `nvpn init` records whatever local address it sees, which inside a container
  is the Docker bridge IP (172.x). Invites carry that address, so without
  NVPN_ENDPOINT a remote client cannot reach you on the direct path and has to
  depend entirely on the FIPS relay fallback.

  Set it to this host's reachable address and make sure that UDP port is open:

      NVPN_ENDPOINT=<public-ip-or-hostname>:51820

EOF
  read -rp "Continue anyway (relay-only fallback)? [y/N] " reply
  [[ "${reply}" =~ ^[Yy]$ ]] || fail "aborted — set NVPN_ENDPOINT in .env and re-run"
fi

# ---- step 2: bring the stack up -------------------------------------------

log "step 2/6: building and starting the proxy stack"
docker compose up -d --build </dev/null

log "waiting for the nvpn sidecar to become healthy"
waited=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q nvpn)" 2>/dev/null || echo missing)" = healthy ]; do
  waited=$((waited + 2))
  [ "${waited}" -ge 120 ] && { docker compose logs nvpn; fail "nvpn sidecar did not become healthy"; }
  sleep 2
done
log "proxy stack up"

# ---- step 3: hand out an invite -------------------------------------------

log "step 3/6: generating a mesh invite"
invite="$(nvpn_cli create-invite | tr -d '\r' | grep -o 'nvpn://invite/[A-Za-z0-9_=-]*' | head -n1)"
[ -n "${invite}" ] || fail "could not generate an invite"

cat >&2 <<EOF

  ─────────────────────────────────────────────────────────────────────────
  Send this invite to the storage-client operator, over a private channel.
  Anyone holding it can queue a join request against your network, so send
  it to exactly one operator and do not paste it anywhere it will be logged.

EOF
printf '%s\n' "${invite}"
cat >&2 <<'EOF'

  They run, on the storage machine:

      ./scripts/nvpn-client-setup.sh

  ...which prints an npub. Paste that npub below.
  ─────────────────────────────────────────────────────────────────────────

EOF

# ---- step 4: approve the client -------------------------------------------

read -rp "Client npub: " client_npub
client_npub="$(printf '%s' "${client_npub}" | tr -d '[:space:]')"
[[ "${client_npub}" =~ ^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$ ]] \
  || fail "'${client_npub}' does not look like a valid npub"

log "step 4/6: approving ${client_npub}"
./scripts/nvpn-approve.sh "${client_npub}" >/dev/null

# ---- step 5: wait for the mesh --------------------------------------------

log "step 5/6: waiting for the client to become reachable (up to ${PEER_TIMEOUT}s)"
log "(the client stack must be up on their side for this to complete)"
peer_ip=""
waited=0
while [ "${waited}" -lt "${PEER_TIMEOUT}" ]; do
  peer_ip="$(nvpn_cli status --json 2>/dev/null \
    | jq -r --arg npub "${client_npub}" \
        '[.daemon.state.peers[]? | select(.fips_endpoint_npub == $npub and .reachable == true) | .tunnel_ip] | first // empty' \
    | cut -d/ -f1)"
  [ -n "${peer_ip}" ] && break
  sleep 5
  waited=$((waited + 5))
done

if [ -z "${peer_ip}" ]; then
  log "the client did not become reachable within ${PEER_TIMEOUT}s"
  log "current peer state:"
  nvpn_cli status --json | jq '.daemon.state.peers' >&2 || true
  fail "mesh did not come up — check that the client's stack is running, then re-run this script"
fi
log "mesh established; client tunnel IP is ${peer_ip}"

# ---- step 6: point the proxies at the peer --------------------------------

log "step 6/6: pointing BLOSSOM_SERVERS/BACKEND_RELAYS at ${peer_ip}"
cp .env .env.bak
sed -i \
  -e "s|^BLOSSOM_SERVERS=.*|BLOSSOM_SERVERS=http://${peer_ip}:3000|" \
  -e "s|^BACKEND_RELAYS=.*|BACKEND_RELAYS=ws://${peer_ip}:7777|" \
  .env
log "updated .env (previous version saved as .env.bak):"
grep -E '^(BLOSSOM_SERVERS|BACKEND_RELAYS)=' .env >&2

# Only the application services — recreating the sidecar would tear down the
# network namespace they share with it.
docker compose up -d --force-recreate blossom relay

for port in "$(grep -E '^BLOSSOM_PORT=' .env | cut -d= -f2)" "$(grep -E '^RELAY_PORT=' .env | cut -d= -f2)"; do
  [ -n "${port}" ] || continue
  waited=0
  until (exec 3<>"/dev/tcp/localhost/${port}") 2>/dev/null; do
    waited=$((waited + 1))
    [ "${waited}" -ge 60 ] && { docker compose logs blossom relay; fail "port ${port} never came up"; }
    sleep 1
  done
done

# An open TCP port is not the same as a working proxy: changing .env makes
# Compose recreate `db` alongside blossom/relay, and until db-api is answering
# again every blossom request 500s. Poll for a real application response (an
# unauthenticated /storage must be rejected with 401, not fail with 5xx) so
# this script does not hand back a stack that is still settling.
log "waiting for the proxies to serve requests"
waited=0
until docker compose exec -T blossom node -e '
  fetch("http://localhost:" + process.env.BLOSSOM_PORT + "/storage")
    .then(r => process.exit(r.status >= 500 ? 1 : 0))
    .catch(() => process.exit(1));
' >/dev/null 2>&1; do
  waited=$((waited + 2))
  [ "${waited}" -ge 90 ] && { docker compose logs blossom db; fail "blossom never started serving requests"; }
  sleep 2
done
log "proxies are serving"

cat >&2 <<EOF

  ─────────────────────────────────────────────────────────────────────────
  Host is live.

    blossom proxy   http://localhost:$(grep -E '^BLOSSOM_PORT=' .env | cut -d= -f2)
    relay proxy     ws://localhost:$(grep -E '^RELAY_PORT=' .env | cut -d= -f2)
    backend peer    ${peer_ip} (over the NVPN tunnel)

  Verify the full protocol path end to end:

      pnpm --filter @orchestrator/smoke-test run smoke

  To approve additional storage clients later, re-run this script or use the
  individual steps: scripts/nvpn-invite.sh and scripts/nvpn-approve.sh.
  ─────────────────────────────────────────────────────────────────────────

EOF
