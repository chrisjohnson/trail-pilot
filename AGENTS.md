# AGENTS.md — trail-pilot

## The one non-obvious invariant: the server always listens on **8137**, and it is
## published on **loopback only**

`-p 127.0.0.1:8137:8137`. Never `-p 8137:8137`, never `0.0.0.0`, never a different
port.

Both halves are load-bearing and both are easy to break by accident, because
`-p 8137:8137` looks identical to the correct form and simply binds every interface.

**Why 8137 is fixed, not just "the default":** the service is fronted by a
*hard-coded* reverse-proxy entry in the `local-ai-machine` infra repo —
`docker/caddy/Caddyfile` routes `trail-pilot.local-ai-machine.johnsonlab.dev`
to `127.0.0.1:8137`. Nothing discovers this service; the port number is the entire
contract between the two repos. Change it here and the hostname starts 502-ing with
no error anywhere in this codebase. If the port ever genuinely needs to move, move
both sides in the same change and say so in the commit message.

**Why loopback-only:** on the host, `trailpilot` is reached through Caddy, which is
the only thing that should face the LAN (Caddy terminates TLS on :443, already the
one open inbound port). Publishing `0.0.0.0` would bypass that entirely — the app
has no authentication of any kind (`POST /routes/ingest` accepts arbitrary GPX from
anyone, `/cdn` is an on-demand fetcher, CORS is `*`), so a bare published port means
any device that can route to it can push routes and drive outbound tile fetches.
The infra repo's standing decision on this
(`knowledge/decisions/2026-07-23-firewall-loopback-binding-fix.md`) is that the
host firewall is *not* a trustworthy gate for published container ports, so services
bind loopback and Caddy does the exposing. Follow that pattern; don't assume a
firewall rule will save you.

**Local dev is unaffected:** `./run.sh 8137 input/foo.gpx` binds `0.0.0.0` for
convenience on a dev machine, which is fine for a laptop. It is not fine on a shared
or networked host — that's what the Caddy path is for.

## How it actually runs on `local-ai-machine`

Not in that repo's compose project, and not under dockerd. It runs as a
**rootless Podman container owned by the `dsh` user**, driven over that user's
systemd-activated API socket:

```sh
export XDG_RUNTIME_DIR=/run/user/1002
POD="podman -H unix:///run/user/1002/podman/podman.sock"
$POD run -d --name trailpilot \
  -p 127.0.0.1:8137:8137 \
  -v tp-data:/data -v tp-cache:/cache \
  --memory=2g \
  ghcr.io/chrisjohnson/trail-pilot:latest
```

Things worth knowing before changing that invocation:

- **`--memory=…` is not optional there.** That box runs large LLMs and routinely
  sits at ~98% memory; the kernel OOM-killer has already taken an uncapped
  `trailpilot` container once. It's a ~50 MB steady-state process, so 1–2 GB is a
  generous cap and costs nothing.
- **`tp-data` / `tp-cache` are the whole stateful surface** — ingested routes and
  the durable tile cache. Keep them as named volumes; losing them means re-ingesting
  and re-prefetching.
- **Rootless builds need fully-qualified base images.** `podman build` fails on this
  host with `short-name "rust:1.98-slim" did not resolve to an alias` — the OS
  generates `[[registry]]` entries but never `unqualified-search-registries`, so no
  short-name resolution exists at all. `FROM docker.io/library/rust:1.98-slim` and
  `docker.io/library/debian:bookworm-slim` are the fix (verified: those two lines are
  the only thing standing between a clean build and a failed one under Podman, and
  fully-qualified `FROM`s are better practice regardless of engine). The
  `# syntax=` directive and `RUN --mount=type=cache` are both fine under buildah —
  don't touch them for podman-compat reasons.
- **`/cdn` host allow-list is a real security boundary**, not a nicety — it's an
  on-demand network fetcher reachable over HTTP. New entries need thought; a request
  for a non-allow-listed host must return 403.

## Verifying a change end-to-end

The pipeline has a byte-for-byte oracle: the server's `route_data.json` must stay
identical to `node build/gpx2route.js` for the same GPX. Re-check that whenever
touching `server/src/pipeline.rs`. For everything else,
`friday-morning-hard-trail-run.gpx` (115.5 mi, 6,775 points, 6 breaks,
`America/New_York`) is the reference fixture — if a change moves the break count or
the timezone on that file, it needs justifying.
