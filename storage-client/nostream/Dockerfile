ARG PNPM_VERSION=10.33.0

FROM node:24-alpine AS build

ARG PNPM_VERSION

WORKDIR /build

RUN apk add --no-cache git && \
    git clone https://github.com/Cameri/nostream.git .

RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate && \
    pnpm install --frozen-lockfile --silent

RUN pnpm build

FROM node:24-alpine

ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache --update git

COPY --from=build /build/resources /app/resources
COPY --from=build /build/dist .
COPY --from=build /build/package.json /build/pnpm-lock.yaml ./

RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate && \
    pnpm install --prod --frozen-lockfile --silent

RUN mkdir -p /app/.nostr && \
    cp /app/resources/default-settings.yaml /app/.nostr/settings.yaml && \
    chown -R node:node /app

USER node:node

EXPOSE 8008

CMD ["node", "src/index.js"]
