# trail-pilot

A trail-run route viewer that runs as a small local **server** (Rust, single
static binary) + a single-file Cesium web app. Drop in a GPX and you get a
phone-friendly 3D map with break detection, an elevation scrubber, and an
**offline tile cache** you can pre-fill for the whole route before you lose
cell signal.

## Quick start

```sh
./run.sh 8137 input/your-run.gpx
```

That builds the server (first run only), ingests the GPX, and serves:

- http://localhost:8137/ — the viewer (machine)
- http://<LAN IP>:8137/ — the viewer (phone, same Wi-Fi)

Open the page, then hit **Pre-fetch offline** in the banner: it walks the
route corridor (±1 km, zooms 10–15) through the server's pull-through cache
and durably stores every tile as files. After that, the whole page —
imagery, Cesium bundle, route data — works with no internet at all.

## How it works

```
GPX ──▶ trailpilot server (Rust, one binary)
         ├─ route pipeline (in-process): parse, breaks, timezone, route_data.json
         ├─ web viewer (single-file Cesium app)
         ├─ pull-through tile cache ──▶ files under cache/  (1-year TTL)
         │     /tiles/otm/{z}/{x}/{y}.png  (OpenTopoMap, via server)
         │     /cdn/{host}/{path}          (Cesium bundle, via server)
         └─ prefetch jobs: warm the cache for a route corridor
```

**The server is the only network path.** The browser never talks to
tile.openstreetmap.org, tile.opentopomap.org, or unpkg.com directly — every
byte goes through the server's cache. On a cache hit the response comes from
a file; on a miss the server fetches upstream once, stores the file
atomically (tmp + rename), and serves it. Restart the server all you want —
the cache is just files and survives.

### Cache semantics

- Layout: `cache/<2-hex>/<16-hex>.bin` + `.meta.json` (upstream URL,
  content-type, stored-at, size).
- Invalidation: 1 year TTL. Terrain/imagery tiles effectively don't change;
  if one ever does, delete its file (or the whole `cache/`).
- Responses carry `X-Cache: HIT` or `X-Cache: MISS` and
  `Cache-Control: max-age=31536000`.
- Concurrent misses for the same URL are deduped in-flight (one upstream
  fetch, many waiters).
- `POST /mode {"offline": true}` (or `--offline` at startup) makes the
  server never touch upstream: hits serve from files, misses 404. That's the
  "local cache only" mode — exactly what a phone in the mountains wants.

### Prefetch

```sh
curl -X POST localhost:8137/prefetch \
  -H 'Content-Type: application/json' \
  -d '{"route":"friday-morning-hard-trail-run","zmin":10,"zmax":15,"marginKm":1}'
curl localhost:8137/prefetch/1     # {state, total, done, failed, pct}
```

`route` defaults to the current route. It computes the set of slippy-map
tiles covering every route point ± `marginKm` at each zoom in range and
pulls them through the cache with bounded concurrency (12). For the example
115-mile run, z10–15 @ 1 km margin is 1,248 tiles (~140 MB).

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | the web viewer (static) |
| `GET /route_data.json` | current route data |
| `POST /routes/ingest` | ingest a GPX (raw body) → becomes current route |
| `GET /routes` | list ingested routes |
| `GET /routes/{slug}/data.json` | one route's data |
| `GET /tiles/otm/{z}/{x}/{y}.png` | OpenTopoMap tile via pull-through cache |
| `GET /cdn/{host}/{path}` | CDN asset via pull-through cache (allow-listed hosts) |
| `POST /prefetch` | start a pre-fetch job |
| `GET /prefetch/{id}`, `GET /prefetch` | job progress / list |
| `GET /mode`, `POST /mode` | inspect / set offline mode |
| `GET /healthz` | cache size, routes, offline flag |

### Server flags

```
trailpilot --port 8137 [--data data] [--cache cache] [--web web]
           [--ingest file.gpx]... [--offline]
           [--tile-origin https://tile.opentopomap.org]
           [--cdn-allow unpkg.com] [--tz-grid build/tz-grid.json]
```

## What the viewer does

- **Route track** — the full GPX track on the globe, with a progress glow.
- **Breaks** — automatically detected (sliding 10-minute window, total GPS
  drift under 200 m). Each break is a tappable pin with duration + start time.
- **Elevation scrubber** — time-based elevation profile; drag/tap to scrub.
- **Camera controls** — tilt, rotate, compass reset (screen-center pivot);
  double-tap to zoom.
- **Times** — GPX UTC converted to the start point's local timezone
  (auto-detected from the start coordinates via an offline 0.25° IANA
  boundary grid, `build/tz-grid.json`; eastern Kentucky →
  `America/New_York`, not the Central that longitude would suggest).
  Override in the Node CLI with `--tz=Area/Location`.
- **Mobile** — full-bleed map, collapsed break list, touch scrubbing.

## File layout

```
run.sh                   one-shot: build + ingest + serve
web/index.html           the app (single file, Cesium via /cdn)
server/                  Rust server (crate "trailpilot")
  src/main.rs            HTTP routes, registry, ingest, config
  src/pipeline.rs        GPX parse, break detection, tz lookup (ports build/gpx2route.js)
  src/cache.rs           durable pull-through cache (files, 1y TTL, dedupe)
  src/prefetch.rs        corridor tile math + job runner
build/gpx2route.js       standalone Node CLI converter (parity-checked vs server)
build/tz-grid.json       offline coord→IANA-timezone grid (generated artifact)
build/gen-tz-grid.js     regenerates the grid (needs network; rarely)
data/                    ingested routes + "current" (gitignored)
cache/                   durable tile/CDN file cache (gitignored)
input/                   drop GPX files here
```

## Why Rust (and where this is heading)

The server is written in Rust so the same code can become the mobile app:
`aarch64-linux-android` and `aarch64-apple-ios` are first-class rustup
targets, and the binary has zero runtime dependencies. The plan:

1. **Now** — the server runs on the box (or any Linux/macOS machine); the
   phone uses it over Wi-Fi/LAN. Pre-fill the cache before the trail.
2. **Android** — embed the same crate in an Android app (JNI) with a
   foreground service: the pipeline, file cache, and pre-fetch live in the
   app process; a WebView (or native map) renders the viewer. App kill →
   restart loses nothing (cache + routes are files).
3. **iOS** — same crate via FFI when it's time.

Go was the main alternative but can't target iOS; Node/Python/Kotlin have no
native-mobile server story. Rust is the only one that covers all three with
one codebase.

## Development

- Build: `cargo build --release --manifest-path server/Cargo.toml`
  (a workspace-local toolchain lives in `.toolchain/`, gitignored).
- Pipeline parity: the server's `route_data.json` is byte-identical to
  `node build/gpx2route.js` output for the same GPX (verified).
- Regenerate the tz grid: `node build/gen-tz-grid.js` (~17 s, downloads
  geo-tz; `TZ_GRID_RES` overrides resolution).
