#!/bin/bash

set -e

mkdir -p data/nostream
mkdir -p data/blossom
mkdir -p data/strfry

sudo docker compose up --build