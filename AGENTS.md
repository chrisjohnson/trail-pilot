# AGENTS.md — trail-pilot

A Rust binary that ingests GPX, works out where a run stopped and why, and
serves a Cesium viewer over a tile cache. One process, no database, no
authentication and no multi-user story — it's a personal tool, and that shapes
both security rules below.

## Getting it running

```sh
./run.sh 8137 input/your-run.gpx     # dev: build + serve a route
```

`--port` defaults to `8137`. Any deployment that fronts the app with a reverse
proxy pins that number **by hand** — nothing advertises or discovers the
service, so the port number is the entire contract between this repo and
whatever sits in front of it. Changing the default means editing the proxy in
the same commit.

## Don't publish it beyond loopback on a shared host

The server binds `0.0.0.0` unconditionally; containment is entirely a function
of how you publish it, so under Docker/podman use `-p 127.0.0.1:8137:8137`, not
`-p 8137:8137`. There is no auth anywhere: `POST /routes/ingest` accepts
arbitrary GPX, `/cdn` is an on-demand fetcher, and CORS is `*`. Binding a
routable interface means any device that can reach it can push routes and drive
outbound fetches. Behind a reverse proxy is the intended exposure; a laptop or
throwaway CI box can bind whatever it likes.

## Two things not to weaken

- **`/cdn`'s host allow-list is a security boundary**, not a nicety. Only
  hosts in `--cdn-allow` (default: `unpkg.com`) may be fetched, and anything
  else must return `403`. New entries deserve thought — it's an HTTP-reachable
  fetcher.
- **The pipeline must stay byte-identical to the JS oracle.** The server's
  `route_data.json` has to match `node build/gpx2route.js` output for the same
  GPX. Re-check whenever touching `server/src/pipeline.rs`.

`friday-morning-hard-trail-run.gpx` (115.5 mi, 6,775 points, 6 breaks,
`America/New_York`) is the reference fixture. A change that moves the break
count or the timezone on that file needs justifying.

It is not sufficient on its own. That GPX **keeps logging stationary points
through its breaks**, so it cannot tell "parked, still writing" apart from
"parked, logger went quiet" — and the pipeline treats a >600 s gap with no
points in it as the stopped case. `fixtures/silent-gap-breaks.gpx` (2h30m, 283
points, 2 silent 40-minute gaps, `breaks: 2`) covers the second case. It is
synthetic, so unlike the reference run it can be tracked — `input/*.gpx` is
ignored because that is where a user drops their own, which is also why the
reference fixture only exists on a box that has ingested it. Anything
that reads stopped-ness from time or speed should be checked against both; a
change that is right on the reference fixture and wrong on silent gaps has
already shipped once this way.

## Containers

`Dockerfile` is multi-stage and engine-agnostic — docker, podman and buildah
all build it. Fully-qualify base images (`FROM docker.io/library/rust:1.98-slim`):
not every engine enables short-name resolution, and a qualified name works on
all of them. `# syntax=` and `RUN --mount=type=cache` are fine under buildah,
so don't strip them for compatibility.

`/data` (ingested routes) and `/cache` (tile cache) are the only stateful
surface; everything else is derived, so losing them costs re-ingest and
re-prefetch rather than correctness. Mount them as named volumes.

### The instance on 8137 is scratch — keep it on your build

Whatever is serving `127.0.0.1:8137` on a dev box is the current session's
preview, not a deployment. Nothing supervises it and it is meant to be replaced.
A stale container there is worse than none: it shows whoever is reviewing the
work the build from two changes ago, and they will review *that*. If you have
touched `web/` or the server, build and swap before asking anyone to look.

Reuse the name, the port and both volumes, so the swap is invisible to whatever
reverse proxy fronts it and the ingested routes survive:

```sh
podman build --layers -t trail-pilot:dev .
podman rm -f trailpilot
podman run -d --name trailpilot -p 127.0.0.1:8137:8137 \
  -v tp-data:/data -v tp-cache:/cache trail-pilot:dev
curl -sf localhost:8137/healthz
```

Those volumes are what make a swap cheap; recreating with fresh ones costs a
re-ingest of every GPX and a re-prefetch of the tile cache.

The behaviour knobs (`TRAILPILOT_VEHICLE`, `TRAILPILOT_SLOW_MPH`,
`TRAILPILOT_STOP_MPH`, `TRAILPILOT_DEBUG`) are read by the server and injected
into the page as `window.TP_CONFIG`. They are container environment, not query
parameters — `?vehicle=subaru` on a URL does nothing on its own.
