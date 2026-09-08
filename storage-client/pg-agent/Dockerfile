# syntax=docker/dockerfile:1

FROM denoland/deno:debian@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498

WORKDIR /app

COPY deno.json ./
COPY main.ts ./
COPY src/ ./src/

RUN deno cache main.ts

EXPOSE 3300

ENTRYPOINT ["deno", "task", "start"]