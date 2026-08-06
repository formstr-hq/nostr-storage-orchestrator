# syntax=docker/dockerfile:1

FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d AS builder

RUN apk add --no-cache \
    git \
    build-base \
    cmake \
    g++ \
    make \
    lmdb-dev \
    openssl-dev \
    yaml-cpp-dev \
    boost-dev \
    zlib-dev

WORKDIR /build

RUN git clone https://github.com/hoytech/strfry.git .

RUN git submodule update --init

RUN make setup-golpe

RUN make -j$(nproc)

FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

RUN apk add --no-cache \
    lmdb \
    yaml-cpp \
    libstdc++ \
    openssl

WORKDIR /app

COPY --from=builder /build/strfry /usr/local/bin/strfry
COPY --from=builder /build/strfry.conf /app/strfry.conf

RUN mkdir -p /app/db

EXPOSE 7777

CMD ["strfry", "relay", "/app/strfry.conf"]