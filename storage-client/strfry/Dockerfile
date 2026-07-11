# syntax=docker/dockerfile:1

FROM alpine:3.21 AS builder

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

FROM alpine:3.21

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