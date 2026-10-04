# Build the Blossom console SPA first. Kept as a stage so the runtime image
# never carries the Node/react toolchain, and so `docker build` works from the
# repo root even before `console/dist` exists on the host.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS console
WORKDIR /console
COPY console/package.json console/package-lock.json ./
RUN npm ci
COPY console ./
RUN npm run build

# Pinned by digest so rebuilds are reproducible and an upstream retag
# cannot silently change the runtime (see README.md "Pinned images").
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

RUN npm install -g pnpm@10.15.1

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY proxy/blossom/package.json ./proxy/blossom/
COPY packages/nip98/package.json ./packages/nip98/
COPY packages/db-client/package.json ./packages/db-client/
COPY packages/lifecycle/package.json ./packages/lifecycle/
COPY packages/notifier/package.json ./packages/notifier/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code (only what this image needs — no Prisma/db-api here)
COPY packages/nip98 ./packages/nip98
COPY packages/db-client ./packages/db-client
COPY packages/lifecycle ./packages/lifecycle
COPY packages/notifier ./packages/notifier
COPY proxy/blossom ./proxy/blossom
# Console SPA build output, served at the blossom hostname. Built by the
# `console` stage above; an empty placeholder keeps the COPY valid even when
# the console has not been built (API + hash routes still work).
COPY --from=console /console/dist ./console/dist

# Build the workspace dependencies first
RUN pnpm --filter @orchestrator/nip98 run build \
  && pnpm --filter @orchestrator/db-client run build \
  && pnpm --filter @orchestrator/lifecycle run build \
  && pnpm --filter @orchestrator/notifier run build

# Then build blossom
RUN pnpm --filter @orchestrator/blossom run build

ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
EXPOSE 3001

CMD ["node", "proxy/blossom/dist/index.js"]
