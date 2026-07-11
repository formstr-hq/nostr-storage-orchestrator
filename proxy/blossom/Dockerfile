FROM node:20-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@10.15.1

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY proxy/blossom/package.json ./proxy/blossom/
COPY packages/db/package.json ./packages/db/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the db package first
RUN pnpm --filter @orchestrator/db run build

# Then build blossom
RUN pnpm --filter @orchestrator/blossom run build

ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
EXPOSE 3001

CMD ["node", "proxy/blossom/dist/index.js"]