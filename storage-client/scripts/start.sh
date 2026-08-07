#!/bin/bash
# Local dev entry point: meshless topology (no NVPN sidecar), backends
# published directly on the host as before. For the NVPN mesh production
# topology, use `docker compose up --build` (docker-compose.yml) directly
# after running ./scripts/nvpn-join.sh — see ../docs/NVPN_SIDECAR_PLAN.md.

set -e

mkdir -p data/nostream
mkdir -p data/blossom
mkdir -p data/strfry

sudo docker compose -f docker-compose.dev.yml up --build