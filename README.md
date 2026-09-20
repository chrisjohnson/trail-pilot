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

- http://localhost:8137/ — route index (machine)
- http://<LAN IP>:8137/ — route index (phone, same Wi-Fi); tap a card for the 3D viewer

Open the page, then hit **Pre-fetch offline** in the banner: it walks the
route corridor (±1 km, every zoom level 10–17) through the server's
pull-through cache and durably stores every tile as files. After that, the
whole page — imagery, Cesium bundle, route data — works with no internet at
all.

Ingest as many GPX files as you like — each is added to the route list and
the **tile cache is shared across all of them** (keyed by upstream URL, not
by route): a second route over overlapping ground reuses every cached tile
and only downloads the new ones. View a specific route by name:
`http://<host>:8137/viewer?route=short-overlap-run` (slug or
display name).

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
  -d '{"route":"friday-morning-hard-trail-run","zmin":10,"zmax":17,"marginKm":1}'
curl localhost:8137/prefetch/1     # {state, total, done, failed, pct}
```

`route` (slug or display name) is required. It computes the set of slippy-map
tiles covering every route point ± `marginKm` at each zoom in range and
pulls them through the cache with bounded concurrency (12); any failures get
sequential retry passes (with backoff) so a rate-limited burst still ends
clean. Job progress includes a per-zoom breakdown (`byZoom`). The viewer's
button pre-fills **z10–17** — every detail level the viewer can show, so
deep zoom stays sharp offline. For the example 115-mile run that's 11,313
tiles (~135 MB; per-zoom split 16/25/47/102/241/817/2382/7683 for z10..z17).

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | the web viewer (static) |
| `GET /route_data.json?route=<slug-or-name>` | one route's data (what the viewer fetches) |
| `POST /routes/ingest` | ingest a GPX (raw body) → added to the route list (the index page has a **Load GPX** button + drag-and-drop) |
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
`TRAILPILOT_DEBUG=1 ./run.sh …` arms the click diagnostics in the viewer (off by default).
`TRAILPILOT_SLOW_MPH` (default 20) and `TRAILPILOT_STOP_MPH` (default 2 — a
GPS-jitter floor, since a parked phone still reads 1-2 mph) set the
speed-band thresholds on the route and scrubber: full red at `stop_mph`, full
green at `slow_mph`, yellow blended between (both are focal points of the
gradient, not hard cutoffs). They are injected into the viewer at serve time,
so changing them needs no re-ingest.
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
web/routes.html          route index (landing page)
  web/viewer.html        the 3D viewer (single file, Cesium via /cdn)
server/                  Rust server (crate "trailpilot")
  src/main.rs            HTTP routes, registry, ingest, config
  src/pipeline.rs        GPX parse, break detection, tz lookup (ports build/gpx2route.js)
  src/cache.rs           durable pull-through cache (files, 1y TTL, dedupe)
  src/prefetch.rs        corridor tile math + job runner
build/gpx2route.js       standalone Node CLI converter (parity-checked vs server)
build/tz-grid.json       offline coord→IANA-timezone grid (generated artifact)
build/gen-tz-grid.js     regenerates the grid (needs network; rarely)
data/                    ingested routes (gitignored)
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

## Performance (mobile readiness)

The code paths that would hurt on a phone CPU are already off the async
worker pool:

- **Cache reads/writes use `tokio::fs`** — a burst of tile hits during a
  pan/zoom never blocks a worker thread (each entry is a small file, served
  from the OS page cache).
- **Prefetch tile math runs in `spawn_blocking`** (6,775 points × 8 zooms
  is ~10⁶ set inserts) — it won't stall request handling on a weak CPU.
- **`/healthz` cache-stats walk runs in `spawn_blocking`** (can be 100k+
  files).

Known properties worth knowing on a phone:

- **Jobs are in-memory** — if the process dies mid-prefetch, re-issue the
  same `POST /prefetch`: cached tiles are instant file hits, so it acts as a
  resume. (Durable job state is a natural next step.)
- **In-flight dedupe** means N viewers watching the same uncached tile
  cause exactly 1 upstream fetch.
- **Prefetch concurrency is 12** — polite to tile providers over cellular;
  when signal drops, in-flight requests fail and the retry passes pick them
  back up.
- **Route data is held in memory** (≈2 MB per 6,775-point route as a JSON
  value). Fine for many routes; dense 10 Hz tracks (100k+ points) would
  eventually want the point buffer stored separately.
- Cache growth is unbounded by design (that's the point) — `rm -rf cache/`
  is the reset.

## Development

- Build: `cargo build --release --manifest-path server/Cargo.toml`
  (a workspace-local toolchain lives in `.toolchain/`, gitignored).
- Pipeline parity: the server's `route_data.json` is byte-identical to
  `node build/gpx2route.js` output for the same GPX (verified).
- Regenerate the tz grid: `node build/gen-tz-grid.js` (~17 s, downloads
  geo-tz; `TZ_GRID_RES` overrides resolution).
