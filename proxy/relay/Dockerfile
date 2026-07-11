FROM node:20-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@10.15.1

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY proxy/relay/package.json ./proxy/relay/
COPY packages/db/package.json ./packages/db/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build workspace packages in dependency order
RUN pnpm --filter @orchestrator/db run build
RUN pnpm --filter @orchestrator/relay run build

ENV NODE_ENV=production
ENV PORT=8007
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

EXPOSE 8007

CMD ["node", "proxy/relay/dist/index.js"]