FROM node:20-alpine

WORKDIR /app

RUN npm install -g pnpm@10.15.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/

RUN pnpm install --frozen-lockfile

COPY . .

WORKDIR /app/packages/db

CMD ["sh", "-c", "pnpm run migrate:deploy && tail -f /dev/null"]
