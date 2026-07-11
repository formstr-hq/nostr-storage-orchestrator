FROM node:20-alpine

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
