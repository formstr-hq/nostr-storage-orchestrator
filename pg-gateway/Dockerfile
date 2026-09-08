# syntax=docker/dockerfile:1

# Build stage: pinned rust image, locked deps (see the control-plane
# Dockerfile for the same pattern).
FROM rust:1.97-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN cargo build --locked --release

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
COPY --from=build /src/target/release/pg-gateway /usr/local/bin/pg-gateway
ENTRYPOINT ["/usr/local/bin/pg-gateway"]