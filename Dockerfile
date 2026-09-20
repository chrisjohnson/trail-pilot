# ============================================================================
# trail-pilot — Rust tile-cache server + static viewer
#
#   docker build -t trail-pilot .
#   docker run -p 8137:8137 -v tp-data:/data -v tp-cache:/cache trail-pilot
#
# Behavior knobs are env vars (TRAILPILOT_SLOW_MPH, TRAILPILOT_STOP_MPH,
# TRAILPILOT_VEHICLE, TRAILPILOT_DEBUG) — see the README.
# ============================================================================
# syntax=docker/dockerfile:1

# ---- Build stage: release binary ----
FROM rust:1.98-slim AS build
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
# Note: cache mounts are NOT committed to the stage filesystem, so the binary
# is copied out of the target cache dir within the same RUN step.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release \
    && cp target/release/trailpilot /build/trailpilot

# ---- Runtime: minimal, static assets baked in ----
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/trailpilot /usr/local/bin/trailpilot
COPY web/ /app/web/
COPY build/tz-grid.json /app/build/tz-grid.json
WORKDIR /app
EXPOSE 8137
VOLUME ["/data", "/cache"]
# /data (routes) and /cache (durable tile cache) are the stateful bits —
# mount volumes there so prefetches survive container recreation.
CMD ["trailpilot", "--data", "/data", "--cache", "/cache"]
