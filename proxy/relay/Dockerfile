# Pinned by digest so rebuilds are reproducible and an upstream retag
# cannot silently change the runtime (see README.md "Pinned images").
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

RUN npm install -g pnpm@10.15.1

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY proxy/relay/package.json ./proxy/relay/
COPY packages/db-client/package.json ./packages/db-client/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code (only what this image needs — no Prisma/db-api here)
COPY packages/db-client ./packages/db-client
COPY proxy/relay ./proxy/relay

# Build workspace packages in dependency order
RUN pnpm --filter @orchestrator/db-client run build
RUN pnpm --filter @orchestrator/relay run build

ENV NODE_ENV=production
ENV PORT=8007
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

EXPOSE 8007

CMD ["node", "proxy/relay/dist/index.js"]
