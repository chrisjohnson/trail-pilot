#!/usr/bin/env bash
# trail-pilot one-shot: convert a GPX and serve the map.
#
#   ./run.sh <file.gpx> [port]
#
# Converts the GPX to route_data.json (detecting breaks + the start
# location's timezone), then serves this folder so index.html can load
# it. The phone connects to the LAN URL while on the same Wi-Fi.
set -euo pipefail
cd "$(dirname "$0")"

if [ $# -lt 1 ] || [ ! -f "$1" ]; then
  echo "Usage: ./run.sh <file.gpx> [port]" >&2
  exit 1
fi
GPX="$1"
PORT="${2:-8137}"

node build/gpx2route.js "$GPX"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Need python3 (or python) to serve — or serve this folder with any static file server." >&2
  exit 1
fi

"$PY" -m http.server "$PORT" --bind 0.0.0.0 >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT INT TERM

echo
echo "Serving trail-pilot on port $PORT"
echo "  This machine:  http://localhost:$PORT/"
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "${LAN_IP:-}" ] && LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -n "${LAN_IP:-}" ]; then
  echo "  Phone (same Wi-Fi): http://$LAN_IP:$PORT/"
else
  echo "  Phone: open http://<this machine's LAN IP>:$PORT/"
fi
wait "$SRV"
