#!/usr/bin/env bash
# trail-pilot one-shot: build the server (once), ingest a GPX, serve.
#
#   ./run.sh [port] [file.gpx ...]
#
# Starts the trailpilot server. Any GPX files given are ingested at startup
# (the last one becomes the current route). The server then serves the web
# viewer, the route pipeline, and the pull-through tile cache.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8137}"
[ "$1" != "" ] && shift || true
GPXS=("$@")

# workspace-local Rust toolchain (if present)
[ -f .toolchain/cargo/env ] && . ./.toolchain/cargo/env

BIN=server/target/release/trailpilot
NEED_BUILD=0
[ -x "$BIN" ] || NEED_BUILD=1
# rebuild if any source (or manifest) is newer than the binary
if [ "$NEED_BUILD" -eq 0 ] && [ -n "$(find server/src server/Cargo.toml -newer "$BIN" -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
fi
if [ "$NEED_BUILD" -eq 1 ]; then
  echo "building trailpilot…"
  cargo build --release --manifest-path server/Cargo.toml
fi

INGEST=()
for g in "${GPXS[@]:-}"; do
  [ -n "$g" ] || continue
  [ -f "$g" ] || { echo "no such GPX: $g" >&2; exit 1; }
  INGEST+=(--ingest "$g")
done
exec "$BIN" --port "$PORT" "${INGEST[*]+"${INGEST[@]}"}"
