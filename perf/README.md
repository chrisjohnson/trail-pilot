# perf

Two Playwright harnesses that drive the real viewer and report what it costs.
The thing we actually care about — watts on a phone — cannot be measured
headless, so everything here is a proxy for it, chosen because it moves the
battery: frames drawn, draw calls, triangles, tiles fetched, main-thread
blocking. `requestRenderMode = 'demand'` makes "frames while idle" a direct
read on whether the app is burning the GPU while nobody is looking at it.

```sh
npm i -D playwright            # or point TP_CHROME at any Chromium
node perf/sweep.mjs before     # UX sweep -> perf/out/before.json
node perf/flame.mjs            # CPU profile per interaction
TP_W=390 TP_H=844 TP_DPR=3 node perf/sweep.mjs phone
```

`TP_URL` (default the local 8137 route), `TP_W`/`TP_H`/`TP_DPR`, `TP_CHROME`,
`TP_OUT`. The sweep walks idle → scrub → play → play-while-panning → play-then-
scrub → zoom → rotate → idle, because each of those stresses a different path,
and it waits for `globe.tilesLoaded` before measuring so tile loading does not
masquerade as a per-frame cost.

## Read this before believing any number here

Headless Chromium renders through **SwiftShader, a software rasteriser**. Frame
times are 5–15× worse than any real GPU and do not transfer. What does transfer
is the *work per frame*, not the wall clock: draw calls, triangles, tiles,
bytes, geometry rebuilds, and how much JavaScript runs.

`flame.mjs` exists because of exactly this. Its first run said "rotate costs
22 seconds", and the profile showed 19.9 s of that inside `readPixels` — the
software rasteriser copying its own framebuffer — against ~2 s of everything
else. Our own JavaScript in the same profiles is *single-digit milliseconds per
interaction*: `drawElev` 5–15 ms, `showAt` 3 ms, across a scenario that renders
60+ frames. The app's JS is not the problem and optimising it would achieve
nothing. Fragment load and tile fetches are.

## What was wrong, and what the numbers moved

Measured at 1512×950, same route, same scenarios, before and after.

| | before | after |
|---|---|---|
| frame p50, scrubbing | 467 ms | 111 ms |
| draw calls / frame | 110 | 85 |
| triangles / frame | 49,460 | 35,210 |
| tiles rendered / frame | 74 | 49 |
| main-thread blocking, rotate | 14,252 ms | 1,318 ms |
| frames while idle (settled) | 0 | 0 |
| entities | 172 | 44 |

Three changes, in order of effect:

1. **The route stopped being draped.** It was 160 separate `clampToGround`
   polylines — one per speed chunk — plus a core and a "traveled" glow that
   regrew a 6,775-point draped geometry every 130 ms during playback. Draping
   is the most expensive thing Cesium does to a polyline: each one becomes a
   `GroundPolylinePrimitive` subdivided against terrain in a worker, so 160 of
   them is 160 worker jobs before the map is interactive. The terrain provider
   is `EllipsoidTerrainProvider` — the globe is *flat*, and all the relief in
   the picture comes from hillshaded imagery. A plain polyline at a constant
   height sits exactly on that surface. **If real terrain is ever added this
   has to go back to `clampToGround`**; a flat line through mountains is wrong
   in a way a flat map is not.
   The three lines now live at 0.40 / 0.42 / 0.44 m so the depth buffer does
   what `zIndex` used to do for coplanar draped lines, where draw order is
   undefined.
2. **Atmosphere, sky, sun, moon, stars and fog off.** `enableLighting` is
   false, so none of it was visible; ground atmosphere in particular is a
   per-fragment scattering approximation being evaluated to shade a topographic
   map that is never in shadow.
3. **`globe.maximumScreenSpaceError` 2 → 3.** This is the dial for "how sharp
   before fetching another level", and it is the cheapest fragment/tile lever
   there is: 74 tiles per frame → 49. It does soften the map slightly at deep
   zoom, which is the trade to revisit if anyone objects.

## Mobile

`TP_W=390 TP_H=844 TP_DPR=3` (Pixel-class viewport and density): frame p50
**57–61 ms**, 51 draw calls, 19.7k triangles, 27 tiles, 7.5 MB of tiles to
settle the first view.

Worth knowing: the canvas backing store stayed **390×844, not 1170×2532**.
Cesium's `useBrowserRecommendedResolution` defaults to true, so a phone's
device-pixel-ratio does *not* multiply our fragment load. That is the right
default for battery, and it is also why the map looks soft on a phone — if
anyone wants it sharper, `resolutionScale` is the knob, and it is the single
biggest power lever in the whole app, in both directions.

## Still open

- **Idle is clean and stays clean**: 0 frames, 0 `requestRender`, 0 tile
  requests once the queue drains. The earlier "2 fps while idle" reading was
  initial tile loading, not a battery bug — the globe's `afterRender` pump only
  forces frames while the tile queue is non-empty.
- **~10 MB / 235 tiles to settle one view** is now the largest remaining cost
  on a phone, and it is network, not GPU. Prefetching the route corridor at
  ingest time, or a lower max level for the initial view, is the next thing to
  look at.
- Per-vertex polyline colour would collapse the 32 halo chunks into one
  primitive. `PolylineGraphics` has no `colors` and silently ignores one; the
  documented route (`PolylineGeometry` + `PolylineColorAppearance`) drew
  nothing at all in 1.125 across translucent/opaque, released/unreleased and
  both arc types. Worth another look on a Cesium upgrade.
- The harness waits on `entities.values.length > 5`; if the route is ever
  rebuilt with fewer entities again, that guard needs updating, not the app.
