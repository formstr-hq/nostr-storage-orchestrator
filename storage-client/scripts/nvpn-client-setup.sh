#!/usr/bin/env bash
# Guided setup for the CLIENT (storage) side of an NVPN mesh, run on the
# machine that actually holds the blobs and relay data. Its counterpart is
# ../scripts/nvpn-host-setup.sh, run by the proxy operator on a different
# machine — this script pauses where a human has to carry a value between the
# two.
#
# It takes the invite the host operator sent you, bootstraps this machine's
# mesh identity, prints the npub for you to send back, brings the storage
# backends up, and waits until the host has approved you.
#
# Safe to re-run: if this machine has already joined, it keeps its existing
# identity instead of trying to re-bootstrap.
#
# Env vars:
#   PEER_TIMEOUT=300   seconds to wait for the host to approve this client
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${CLIENT_DIR}"

PEER_TIMEOUT="${PEER_TIMEOUT:-300}"

log()  { echo "[client] $*" >&2; }
fail() { echo "[client] ERROR: $*" >&2; exit 1; }

nvpn_cli() {
  local sub="$1"; shift
  docker compose exec -T nvpn nvpn "${sub}" --config /data/config/nvpn/config.toml "$@"
}

# Reads the npub recorded at bootstrap, without needing the stack to be up.
existing_npub() {
  docker compose run --rm --no-deps -T --entrypoint sh nvpn \
    -c 'jq -r ".npub // empty" /data/.sidecar-complete 2>/dev/null' 2>/dev/null </dev/null \
    | tr -d '\r' | grep -o 'npub1[a-z0-9]*' | head -n1 || true
}

# ---- step 1: config -------------------------------------------------------

log "step 1/5: checking configuration"
if [ ! -f .env ]; then
  log "creating .env from .env.example"
  cp .env.example .env
fi

log "building images (first run pulls Deno and compiles the blossom bundle — this takes a few minutes)"
docker compose build >/dev/null </dev/null

# ---- step 2: join the mesh ------------------------------------------------

client_npub="$(existing_npub)"

if [ -n "${client_npub}" ]; then
  log "step 2/5: this machine has already joined a mesh — keeping its identity"
  log "npub: ${client_npub}"
else
  log "step 2/5: joining the host's mesh"
  cat >&2 <<'EOF'

  ─────────────────────────────────────────────────────────────────────────
  Paste the invite the host operator sent you (it will not be echoed).
  It is used once, in a throwaway container, and is never written to .env,
  to disk, or to a Docker log.
  ─────────────────────────────────────────────────────────────────────────

EOF
  read -rsp "NVPN invite: " invite
  echo >&2
  [ -n "${invite}" ] || fail "empty invite"

  client_npub="$(printf '%s\n' "${invite}" \
    | docker compose run --rm --no-deps -T nvpn bootstrap-client \
    | tr -d '\r' | grep -o 'npub1[a-z0-9]*' | head -n1)"
  unset invite
  [ -n "${client_npub}" ] || fail "bootstrap did not produce an npub"
fi

cat >&2 <<EOF

  ─────────────────────────────────────────────────────────────────────────
  Send this npub back to the host operator so they can approve you.
  It is a public identifier — it is safe to send over any channel.

EOF
printf '%s\n' "${client_npub}"
cat >&2 <<'EOF'

  They paste it into their running ./scripts/nvpn-host-setup.sh.
  ─────────────────────────────────────────────────────────────────────────

EOF

# ---- step 3: bring the backends up ----------------------------------------

log "step 3/5: starting the storage backends"
docker compose up -d

log "waiting for the nvpn sidecar to become healthy"
waited=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q nvpn)" 2>/dev/null || echo missing)" = healthy ]; do
  waited=$((waited + 2))
  [ "${waited}" -ge 120 ] && { docker compose logs nvpn; fail "nvpn sidecar did not become healthy"; }
  sleep 2
done

# Healthy deliberately does not mean "approved" — a client waiting on the host
# must still be able to go healthy, so pending is distinguishable from broken.
log "sidecar healthy (this does not yet mean the host has approved you)"

# ---- step 4: wait for approval --------------------------------------------

log "step 4/5: waiting for the host to approve this client (up to ${PEER_TIMEOUT}s)"
peered=0
waited=0
while [ "${waited}" -lt "${PEER_TIMEOUT}" ]; do
  if nvpn_cli status --json 2>/dev/null \
      | jq -e '[.daemon.state.peers[]? | select(.reachable == true)] | length > 0' >/dev/null 2>&1; then
    peered=1
    break
  fi
  sleep 5
  waited=$((waited + 5))
done

if [ "${peered}" != 1 ]; then
  cat >&2 <<EOF

  Not approved yet after ${PEER_TIMEOUT}s. This is not necessarily an error —
  the host operator may simply not have pasted your npub yet.

  The stack stays running and will connect on its own once they approve.
  Check progress at any time with:

      docker compose exec nvpn nvpn status --config /data/config/nvpn/config.toml --json | jq '.daemon.state.peers'

EOF
  exit 0
fi

# ---- step 5: report ---------------------------------------------------------

tunnel_ip="$(nvpn_cli status --json | jq -r '.tunnel_ip // empty' | cut -d/ -f1)"

cat >&2 <<EOF

  ─────────────────────────────────────────────────────────────────────────
  Approved and connected.

    this machine's tunnel IP   ${tunnel_ip}
    blossom backend            ${tunnel_ip}:3000  (mesh-only)
    strfry backend             ${tunnel_ip}:7777  (mesh-only)

  Neither backend is published on this host or reachable from the Docker
  bridge — the sidecar's firewall rejects both from anywhere but the tunnel
  and loopback.

  The host operator's script picks up this tunnel IP automatically; nothing
  further is needed on this machine.
  ─────────────────────────────────────────────────────────────────────────

EOF
