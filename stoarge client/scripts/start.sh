#!/bin/bash

set -e

mkdir -p data/nostream
mkdir -p data/blossom

sudo docker compose up --build