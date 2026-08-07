# Pinned by digest so rebuilds are reproducible and an upstream retag
# cannot silently change the runtime (see README.md "Pinned images").
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app

RUN npm install -g pnpm@10.15.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db-client/package.json ./packages/db-client/
COPY packages/db/package.json ./packages/db/

RUN pnpm install --frozen-lockfile

COPY packages/db-client ./packages/db-client
COPY packages/db ./packages/db

RUN pnpm --filter @orchestrator/db-client run build
RUN pnpm --filter @orchestrator/db-api run generate
RUN pnpm --filter @orchestrator/db-api run build

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["sh", "-c", "pnpm --filter @orchestrator/db-api run migrate:deploy && node packages/db/dist/src/index.js"]
