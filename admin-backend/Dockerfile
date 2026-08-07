# syntax=docker/dockerfile:1

ARG NVPN_VERSION=4.0.87

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS nvpn
ARG NVPN_VERSION
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    : "${TARGETARCH:=$(dpkg --print-architecture)}"; \
    case "${TARGETARCH}" in \
      amd64) \
        NVPN_ARTIFACT="nvpn-v${NVPN_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
        NVPN_SHA256="c57498e08ef35916e2125b653d693a0bb5ec174dbf11fadf49f60734eb147e9a"; \
        ;; \
      arm64) \
        NVPN_ARTIFACT="nvpn-v${NVPN_VERSION}-aarch64-unknown-linux-musl.tar.gz"; \
        NVPN_SHA256="be14af1cb17dab52d49e9ebd93541e82f903eae864c0122c2ea337f5f08bb89c"; \
        ;; \
      *) \
        echo "unsupported TARGETARCH: '${TARGETARCH}'" >&2; \
        exit 1; \
        ;; \
    esac; \
    cd /tmp; \
    curl -fsSLO "https://github.com/mmalmi/nostr-vpn/releases/download/v${NVPN_VERSION}/${NVPN_ARTIFACT}"; \
    echo "${NVPN_SHA256}  ${NVPN_ARTIFACT}" | sha256sum -c -; \
    tar -xzf "${NVPN_ARTIFACT}"; \
    install -m 0755 nvpn/nvpn /usr/local/bin/nvpn; \
    nvpn --version

FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073 AS build
WORKDIR /build
COPY admin-backend/Cargo.toml admin-backend/Cargo.lock ./
COPY admin-backend/src ./src
RUN cargo build --locked --release

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/target/release/admin-backend /usr/local/bin/admin-backend
COPY --from=nvpn /usr/local/bin/nvpn /usr/local/bin/nvpn

ENV ADMIN_API_PORT=3002 \
    NVPN_CONFIG=/data/config/nvpn/config.toml \
    NVPN_BIN=/usr/local/bin/nvpn
EXPOSE 3002
ENTRYPOINT ["/usr/local/bin/admin-backend"]
