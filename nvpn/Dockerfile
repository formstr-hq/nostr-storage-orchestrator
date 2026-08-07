# syntax=docker/dockerfile:1
#
# Pinned, checksum-verified NVPN 4.0.87 sidecar. See ../docs/NVPN_SIDECAR_PLAN.md
# for the full design and ./README.md for the runtime contract.

ARG NVPN_VERSION=4.0.87

# ---- builder: download + verify the release binary, nothing else lives here ----
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS builder

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
        echo "unsupported TARGETARCH: '${TARGETARCH}' (only amd64/arm64 have a pinned NVPN ${NVPN_VERSION} release artifact)" >&2; \
        exit 1; \
        ;; \
    esac; \
    cd /tmp; \
    curl -fsSLO "https://github.com/mmalmi/nostr-vpn/releases/download/v${NVPN_VERSION}/${NVPN_ARTIFACT}"; \
    echo "${NVPN_SHA256}  ${NVPN_ARTIFACT}" | sha256sum -c -; \
    tar -xzf "${NVPN_ARTIFACT}"; \
    install -m 0755 nvpn/nvpn /usr/local/bin/nvpn; \
    nvpn --version

# ---- runtime: only the upstream baseline the plan calls for ----
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG NVPN_VERSION
ARG REVISION=unknown

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      iproute2 \
      iptables \
      iputils-ping \
      jq \
      procps \
      wireguard-tools \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/nvpn /usr/local/bin/nvpn

COPY entrypoint.sh /entrypoint.sh
COPY firewall.sh /usr/local/bin/firewall.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod 0755 /entrypoint.sh /usr/local/bin/firewall.sh /usr/local/bin/healthcheck.sh

# Deliberately no USER directive: network administration (iptables, tun setup)
# is this container's entire purpose. Isolation comes from cap_add: NET_ADMIN
# + /dev/net/tun being scoped to this one service, not from running rootless.
# Do not add `privileged` or host networking in compose — see ../docs/NVPN_SIDECAR_PLAN.md.

LABEL org.opencontainers.image.source="https://github.com/formstr-hq/nostr-storage-orchestrator" \
      org.opencontainers.image.title="nvpn-sidecar" \
      org.opencontainers.image.description="NVPN mesh sidecar: owns a network namespace shared via network_mode: service:nvpn" \
      org.opencontainers.image.version="${NVPN_VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["run"]
