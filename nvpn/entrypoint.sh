#!/bin/bash
# NVPN sidecar entrypoint: crash-safe state init, daemon supervision, and the
# one-shot client bootstrap mode. See ../docs/NVPN_SIDECAR_PLAN.md section 1.
#
# CLI surface verified against nvpn v4.0.87:
#   - `nvpn init` writes the config and prints plain `key=value` lines on
#     stdout (`nostr_pubkey=npub1...`) — it is NOT JSON, so parse it as text.
#   - there is no `nvpn daemon` subcommand; the daemon is
#     `nvpn start --daemon` (pid/log/state files land beside the config), and
#     `nvpn reload` only works against that daemon.
#   - `nvpn status --json` exposes liveness under `.daemon.running` /
#     `.daemon.state.vpn_active`, not a top-level `.state`.
#   - the tunnel interface is whatever `--iface` says (default `utun100`),
#     so we name it explicitly rather than guessing it back out of status.
set -euo pipefail

ROLE="${NVPN_ROLE:?set NVPN_ROLE to proxy or client}"
SCHEMA_VERSION=1
CONFIG_HOME="${XDG_CONFIG_HOME:?XDG_CONFIG_HOME must be set (see nvpn/compose.yml)}"
CONFIG_DIR="${CONFIG_HOME}/nvpn"
CONFIG="${CONFIG_DIR}/config.toml"
MARKER=/data/.sidecar-complete
LOCK=/data/.init.lock
LISTEN_PORT="${NVPN_LISTEN_PORT:-51820}"
TUN_IFACE="${NVPN_TUN_IFACE:-nvpn0}"

log() { echo "[nvpn:${ROLE}] $*" >&2; }

fatal() {
  log "FATAL: $*"
  exit 1
}

# ---- helpers -----------------------------------------------------------

extract_npub() {
  # `nvpn init` prints plain `key=value` lines, e.g.
  #   wrote /data/.../config.toml
  #   network_id=
  #   nostr_pubkey=npub1...
  sed -n 's/^nostr_pubkey=//p' "$1" 2>/dev/null | head -n1 || true
}

# The npub of whoever issued the invite we imported, read back out of the
# config `import-invite` just wrote. A freshly joined client has an empty
# `devices` list, and `nvpn start` refuses to run with no participants
# ("at least one participant must be configured before running connect"), so
# the client has to put its inviter (the proxy) in its own roster.
extract_inviter_npub() {
  sed -n 's/^invite_inviter[[:space:]]*=[[:space:]]*"\(npub1[^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n1 || true
}

validate_npub() {
  [[ "$1" =~ ^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$ ]]
}

with_tmp_state() {
  # Runs `nvpn init` (and for clients, `import-invite`) in a scratch config
  # under /data, never touching /data/config or /data/home until commit_state.
  local tmp="/data/.tmp-$$-${RANDOM}"
  mkdir -p "${tmp}/config/nvpn" "${tmp}/home"
  printf '%s' "${tmp}"
}

commit_state() {
  # Atomically publish scratch state as the real config/home, then write the
  # completion marker last. rename(2) onto an existing *empty* directory
  # succeeds and replaces it, so this is safe on a truly first run (where
  # /data/config or /data/home may already exist as an empty volume dir) and
  # fails loudly (mv error, non-zero exit) if either is unexpectedly non-empty.
  local tmp="$1" npub="$2" port="$3"
  chmod -R go-rwx "${tmp}/config" "${tmp}/home"
  mv -T "${tmp}/config" /data/config
  mv -T "${tmp}/home" /data/home
  chmod 0700 /data/config /data/home

  local tmp_marker
  tmp_marker="$(mktemp /data/.marker.XXXXXX)"
  jq -n --arg role "${ROLE}" --argjson schema "${SCHEMA_VERSION}" \
        --arg npub "${npub}" --argjson port "${port}" \
        '{role: $role, schemaVersion: $schema, npub: $npub, listenPort: $port}' \
        >"${tmp_marker}"
  mv -T "${tmp_marker}" "${MARKER}"
  rm -rf "${tmp}"
}

discard_tmp_state() {
  local tmp="$1"
  rm -rf "${tmp}"
}

# ---- crash-safe initialization -----------------------------------------

validate_existing_state() {
  local marker_role marker_schema
  marker_role="$(jq -r '.role' "${MARKER}" 2>/dev/null || true)"
  marker_schema="$(jq -r '.schemaVersion' "${MARKER}" 2>/dev/null || true)"
  [ "${marker_role}" = "${ROLE}" ] || fatal "marker role '${marker_role}' != NVPN_ROLE '${ROLE}'"
  [ "${marker_schema}" = "${SCHEMA_VERSION}" ] || fatal "marker schemaVersion '${marker_schema}' != expected ${SCHEMA_VERSION}"
  [ -f "${CONFIG}" ] || fatal "marker present but ${CONFIG} is missing"
  find "${CONFIG_DIR}" -maxdepth 1 -type f ! -name "config.toml" | grep -q . \
    || fatal "marker present but no Nostr secret file found beside ${CONFIG}"
}

init_proxy_state() {
  local tmp npub
  tmp="$(with_tmp_state)"
  local tmp_config="${tmp}/config/nvpn/config.toml"

  if ! XDG_CONFIG_HOME="${tmp}/config" HOME="${tmp}/home" \
      nvpn init --config "${tmp_config}" >"${tmp}/init.out" 2>"${tmp}/init.log"; then
    log "nvpn init failed:"
    cat "${tmp}/init.log" >&2
    discard_tmp_state "${tmp}"
    fatal "proxy initialization aborted"
  fi

  npub="$(extract_npub "${tmp}/init.out")"
  if [ -z "${npub}" ]; then
    discard_tmp_state "${tmp}"
    fatal "could not parse a Nostr pubkey out of 'nvpn init' output"
  fi
  validate_npub "${npub}" || { discard_tmp_state "${tmp}"; fatal "'nvpn init' produced a malformed npub: ${npub}"; }

  # Seeding the roster with our own npub is what activates the network —
  # `nvpn create-invite` fails with "create or join a network first" until
  # this runs.
  if ! XDG_CONFIG_HOME="${tmp}/config" HOME="${tmp}/home" \
      nvpn set --config "${tmp_config}" --device "${npub}"; then
    discard_tmp_state "${tmp}"
    fatal "'nvpn set --device' failed during proxy initialization"
  fi

  commit_state "${tmp}" "${npub}" "${LISTEN_PORT}"
  log "proxy initialized (npub=${npub})"
}

# `nvpn init` records whatever local address it saw at init time as the
# advertised endpoint — inside a container that's the Docker bridge IP
# (172.x), which no remote client can dial. Operators set NVPN_ENDPOINT to
# the proxy host's reachable <host-or-ip>:<port> so generated invites carry
# something usable.
apply_endpoint_if_set() {
  [ -n "${NVPN_ENDPOINT:-}" ] || return 0
  local have
  have="$(jq -r '.endpoint // empty' "${MARKER}" 2>/dev/null || true)"
  [ "${have}" = "${NVPN_ENDPOINT}" ] && return 0

  log "applying NVPN_ENDPOINT: ${have:-<unset>} -> ${NVPN_ENDPOINT}"
  if ! nvpn set --config "${CONFIG}" --endpoint "${NVPN_ENDPOINT}"; then
    fatal "'nvpn set --endpoint' failed applying NVPN_ENDPOINT=${NVPN_ENDPOINT}"
  fi

  local tmp_marker
  tmp_marker="$(mktemp /data/.marker.XXXXXX)"
  jq --arg ep "${NVPN_ENDPOINT}" '.endpoint = $ep' "${MARKER}" >"${tmp_marker}"
  mv -T "${tmp_marker}" "${MARKER}"
}

ensure_initialized() {
  exec 9>"${LOCK}"
  flock -w 60 9 || fatal "could not acquire init lock ${LOCK} within 60s"

  if [ -f "${MARKER}" ]; then
    validate_existing_state
    return
  fi

  if [ -e "${CONFIG}" ]; then
    fatal "${CONFIG} exists without a completion marker (${MARKER}) — refusing to overwrite unknown state. See nvpn/README.md#recovery."
  fi

  case "${ROLE}" in
    proxy)
      init_proxy_state
      ;;
    client)
      fatal "client role requires prior bootstrap: run 'docker compose run --rm --no-deps -T nvpn bootstrap-client' via scripts/nvpn-join.sh first"
      ;;
    *)
      fatal "NVPN_ROLE must be 'proxy' or 'client', got '${ROLE}'"
      ;;
  esac
}

apply_listen_port_if_changed() {
  local have
  have="$(jq -r '.listenPort' "${MARKER}" 2>/dev/null || true)"
  [ "${have}" = "${LISTEN_PORT}" ] && return 0

  log "applying NVPN_LISTEN_PORT change: ${have:-<unset>} -> ${LISTEN_PORT}"
  if ! nvpn set --config "${CONFIG}" --listen-port "${LISTEN_PORT}"; then
    fatal "'nvpn set --listen-port' failed applying NVPN_LISTEN_PORT=${LISTEN_PORT}"
  fi

  local tmp_marker
  tmp_marker="$(mktemp /data/.marker.XXXXXX)"
  jq --argjson port "${LISTEN_PORT}" '.listenPort = $port' "${MARKER}" >"${tmp_marker}"
  mv -T "${tmp_marker}" "${MARKER}"
}

# ---- bootstrap-client mode ----------------------------------------------

bootstrap_client() {
  [ "${ROLE}" = client ] || fatal "bootstrap-client requires NVPN_ROLE=client"

  exec 9>"${LOCK}"
  flock -w 30 9 || fatal "could not acquire init lock ${LOCK} within 30s"

  [ -f "${MARKER}" ] && fatal "already initialized (${MARKER} exists) — bootstrap-client only runs against fresh state"
  [ -e "${CONFIG}" ] && fatal "${CONFIG} exists without a completion marker — refusing to overwrite unknown state. See nvpn/README.md#recovery."

  local invite
  if ! IFS= read -r invite; then
    fatal "no invite received on stdin (run this via scripts/nvpn-join.sh)"
  fi
  [ -n "${invite}" ] || fatal "empty invite on stdin"

  local tmp npub
  tmp="$(with_tmp_state)"
  local tmp_config="${tmp}/config/nvpn/config.toml"

  if ! XDG_CONFIG_HOME="${tmp}/config" HOME="${tmp}/home" \
      nvpn init --config "${tmp_config}" >"${tmp}/init.out" 2>"${tmp}/init.log"; then
    log "nvpn init failed:"
    cat "${tmp}/init.log" >&2
    discard_tmp_state "${tmp}"
    fatal "client bootstrap aborted"
  fi

  npub="$(extract_npub "${tmp}/init.out")"
  if [ -z "${npub}" ]; then
    discard_tmp_state "${tmp}"
    fatal "could not parse a Nostr pubkey out of 'nvpn init' output"
  fi
  validate_npub "${npub}" || { discard_tmp_state "${tmp}"; fatal "'nvpn init' produced a malformed npub: ${npub}"; }

  # The invite is passed as an argv value to this one-shot process only — it
  # is never written to disk, .env, or a log; `docker inspect`/`logs` on this
  # short-lived `run --rm` container never see it in the compose config.
  if ! XDG_CONFIG_HOME="${tmp}/config" HOME="${tmp}/home" \
      nvpn import-invite --config "${tmp_config}" "${invite}" >/dev/null 2>"${tmp}/import.log"; then
    log "nvpn import-invite failed:"
    cat "${tmp}/import.log" >&2
    discard_tmp_state "${tmp}"
    fatal "client bootstrap aborted"
  fi
  unset invite

  # `import-invite` only queues a join request; it leaves `devices = []`, and
  # the proxy's later `add-device --publish` does not reliably reach a client
  # that isn't connected yet (it reports `published_recipients=0`). Add the
  # inviting proxy to our own roster so `nvpn start` has a participant to
  # dial — the proxy still has to approve us before traffic flows.
  local inviter
  inviter="$(extract_inviter_npub "${tmp_config}")"
  if [ -z "${inviter}" ] || ! validate_npub "${inviter}"; then
    discard_tmp_state "${tmp}"
    fatal "could not determine the inviter npub from the imported invite"
  fi
  if ! XDG_CONFIG_HOME="${tmp}/config" HOME="${tmp}/home" \
      nvpn set --config "${tmp_config}" --device "${inviter}"; then
    discard_tmp_state "${tmp}"
    fatal "'nvpn set --device' failed adding the inviting proxy to the roster"
  fi

  commit_state "${tmp}" "${npub}" "${LISTEN_PORT}"
  echo "${npub}"
}

# ---- daemon supervision --------------------------------------------------

daemon_pid_file() { printf '%s' "${CONFIG_DIR}/daemon.pid"; }

daemon_alive() {
  # daemon.pid is JSON ({"pid":109,"config_path":...,"started_at":...}),
  # not a bare number.
  local pid_file pid
  pid_file="$(daemon_pid_file)"
  [ -f "${pid_file}" ] || return 1
  pid="$(jq -r '.pid // empty' "${pid_file}" 2>/dev/null || true)"
  [ -n "${pid}" ] || return 1
  kill -0 "${pid}" 2>/dev/null
}

run_daemon_supervised() {
  ensure_initialized
  apply_listen_port_if_changed
  apply_endpoint_if_set

  # Fail-closed firewall before anything else can start listening/dialing.
  # The tunnel interface doesn't exist yet on the very first call, so this
  # installs the blanket mesh-CIDR reject from firewall.sh; each daemon
  # (re)start below re-runs it once the interface is known.
  firewall.sh install || fatal "initial firewall install failed"

  local backoff=1
  local term_received=0

  on_term() {
    term_received=1
  }
  trap on_term TERM INT

  # `nvpn start --daemon` (not the nonexistent `nvpn daemon`) is what writes
  # daemon.pid/daemon.state.json beside the config and is the only mode
  # `nvpn reload` can talk to — which is how an operator applies a new device
  # approval without recreating this container, and therefore without tearing
  # down the network namespace the app containers share.
  while :; do
    if ! daemon_alive; then
      log "starting nvpn daemon on ${TUN_IFACE}"
      if nvpn start --config "${CONFIG}" --iface "${TUN_IFACE}" --daemon; then
        backoff=1
      else
        log "'nvpn start --daemon' failed; retrying in ${backoff}s"
        sleep "${backoff}"
        backoff=$(( backoff < 30 ? backoff * 2 : 30 ))
        continue
      fi
    fi

    # Upgrade the mesh-CIDR guard from "reject everything" to "reject
    # everything not on the tunnel" (and open the mesh-only app ports on it)
    # as soon as the tunnel interface actually appears. Doing this on every
    # tick rather than once after a fixed sleep matters: the interface can
    # take longer than any single sleep to come up, and losing that race
    # leaves the namespace fail-closed with no mesh traffic at all.
    if [ "$(cat /data/.firewall-applied 2>/dev/null || true)" = notun ] \
       && ip link show "${TUN_IFACE}" >/dev/null 2>&1; then
      firewall.sh install || log "firewall reinstall after tunnel came up failed"
    fi

    # Backgrounded so a SIGTERM interrupts the wait immediately — bash defers
    # traps until a *foreground* child exits, which would add up to 5s to
    # every shutdown.
    sleep 5 & wait $! || true
    if [ "${term_received}" = 1 ]; then
      log "shutting down nvpn daemon"
      nvpn stop --config "${CONFIG}" >/dev/null 2>&1 || true
      exit 0
    fi
  done
}

# ---- dispatch -------------------------------------------------------------

case "${1:-run}" in
  run)
    run_daemon_supervised
    ;;
  bootstrap-client)
    bootstrap_client
    ;;
  *)
    fatal "unknown entrypoint mode '${1:-}' (expected 'run' or 'bootstrap-client')"
    ;;
esac
