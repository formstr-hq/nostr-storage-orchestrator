# Notifier: lifecycle state mirror + expiry/quota/moderation notifications.
# Builds the workspace packages it depends on (db-client, lifecycle) then the
# notifier itself.
# Pinned by digest so rebuilds are reproducible and an upstream retag cannot
# silently change the runtime (see README.md "Pinned images").
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/nip98/package.json packages/nip98/
COPY packages/db-client/package.json packages/db-client/
COPY packages/lifecycle/package.json packages/lifecycle/
COPY packages/notifier/package.json packages/notifier/
COPY proxy/blossom/package.json proxy/blossom/
RUN pnpm install --frozen-lockfile --filter @orchestrator/notifier... --filter @orchestrator/lifecycle... --filter @orchestrator/db-client... --filter @orchestrator/nip98...

COPY packages/nip98 packages/nip98
COPY packages/db-client packages/db-client
COPY packages/lifecycle packages/lifecycle
COPY packages/notifier packages/notifier

RUN pnpm --filter @orchestrator/nip98 build \
  && pnpm --filter @orchestrator/db-client build \
  && pnpm --filter @orchestrator/lifecycle build \
  && pnpm --filter @orchestrator/notifier build

ENV NODE_ENV=production
CMD ["node", "packages/notifier/dist/index.js"]
