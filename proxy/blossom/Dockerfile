FROM node:20-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@10.15.1

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY proxy/blossom/package.json ./proxy/blossom/
COPY packages/db-client/package.json ./packages/db-client/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code (only what this image needs — no Prisma/db-api here)
COPY packages/db-client ./packages/db-client
COPY proxy/blossom ./proxy/blossom

# Build the db-client package first
RUN pnpm --filter @orchestrator/db-client run build

# Then build blossom
RUN pnpm --filter @orchestrator/blossom run build

ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
EXPOSE 3001

CMD ["node", "proxy/blossom/dist/index.js"]
