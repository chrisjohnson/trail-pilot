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

## Containers

`Dockerfile` is multi-stage and engine-agnostic — docker, podman and buildah
all build it. Fully-qualify base images (`FROM docker.io/library/rust:1.98-slim`):
not every engine enables short-name resolution, and a qualified name works on
all of them. `# syntax=` and `RUN --mount=type=cache` are fine under buildah,
so don't strip them for compatibility.

`/data` (ingested routes) and `/cache` (tile cache) are the only stateful
surface; everything else is derived, so losing them costs re-ingest and
re-prefetch rather than correctness. Mount them as named volumes.
