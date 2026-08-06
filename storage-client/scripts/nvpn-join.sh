#!/usr/bin/env bash
# One-shot NVPN mesh join: prompts for the invite (not echoed to the
# terminal), bootstraps this client's identity in a throwaway
# `docker compose run` container, and prints only the resulting npub — send
# that to the proxy operator for approval. The invite itself is never
# written to .env, disk, or a Docker log.
# See ../../docs/NVPN_SIDECAR_PLAN.md section 5.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${SCRIPT_DIR}"

if [ ! -f .env ]; then
  echo "creating .env from .env.example" >&2
  cp .env.example .env
fi

read -rsp "NVPN invite: " invite
echo >&2
if [ -z "${invite}" ]; then
  echo "empty invite, aborting" >&2
  exit 1
fi

npub="$(printf '%s\n' "${invite}" | docker compose run --rm --no-deps -T nvpn bootstrap-client)"
unset invite

echo "Joined. Send this npub to the proxy operator for approval:" >&2
echo "${npub}"
