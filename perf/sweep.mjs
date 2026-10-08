// Performance harness: drives the real UX at a desktop viewport and measures
// what the app actually costs. Everything is a proxy for the thing we cannot
// measure headless (watts): frames rendered, draw calls, triangles, geometry
// rebuilds, main-thread blocking, and bytes fetched.
//
//   node perf/sweep.mjs [label]     # writes perf/out/<label>.json
//
// Frames are counted from scene.postRender, which in requestRenderMode only
// fires for frames that were actually drawn — so "frames while idle" is a
// direct read on whether the app is burning the GPU while nobody is looking.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const LABEL = process.argv[2] || 'run';
const BASE = process.env.TP_URL || 'http://127.0.0.1:8137/viewer?route=friday-morning-hard-trail-run';
const W = Number(process.env.TP_W || 1512), H = Number(process.env.TP_H || 950);
const DPR = Number(process.env.TP_DPR || 1);
const OUT = process.env.TP_OUT || new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.TP_CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
let tileReqs = 0;
page.on('request', (r) => { if (r.url().includes('/tiles/')) tileReqs++; });

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__viewer', null, { timeout: 60000 });
await page.waitForFunction('window.__viewer.entities.values.length > 5 && window.__viewer.scene.primitives.length >= 3', null, { timeout: 60000 });

// ---- collector -------------------------------------------------------------
await page.waitForFunction('window.__viewer.scene.globe.tilesLoaded === true', null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500);

const boot = await page.evaluate(() => {
  const sc = window.__viewer.scene;
  const P = { marks: [], frames: [], stats: [], tasks: [], reqs: 0, tiles: 0 };
  window.__P = P;
  // Draw calls and triangles come from the command list itself. debugCommandFilter
  // is called once per command as it executes, so counting there is the only
  // reading that reflects what was actually submitted - frustumCommandsList
  // sampled between frames reports whatever the last pass left behind.
  let cmds = 0, tris = 0;
  sc.debugCommandFilter = (c) => {
    cmds++;
    if (c.primitiveType === 4 && c.count) tris += Math.floor(c.count / 3);
    return true;
  };
  sc.postRender.addEventListener(() => {
    let tiles = 0;
    try { tiles = sc.globe._surface._tilesToRender.length; } catch (e) {}
    P.frames.push(performance.now());
    P.stats.push([cmds, tris, sc.primitives.length, 0, 0, tiles]);
    cmds = 0; tris = 0;
  });
  const orig = sc.requestRender.bind(sc);
  sc.requestRender = function () { P.reqs++; return orig(); };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.tasks.push([Math.round(e.startTime), Math.round(e.duration)]); })
      .observe({ entryTypes: ['longtask'] });
  } catch (e) { P.noLongTask = true; }
  P.marks.push(['boot', performance.now()]);
  return { entities: window.__viewer.entities.values.length, dpr: window.devicePixelRatio,
           canvas: [sc.canvas.width, sc.canvas.height] };
});

const mark = (name) => page.evaluate((n) => window.__P.marks.push([n, performance.now()]), name);
const wait = (ms) => page.waitForTimeout(ms);
const canvas = await page.locator('#cesiumContainer').boundingBox();
const elev = await page.locator('#elev').boundingBox();
const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;

// ---- scenario --------------------------------------------------------------
await wait(2500);
await mark('idle');                                  // should render ~nothing
await wait(3000);

await mark('scrub-hover');                           // hover the elevation strip
for (let pass = 0; pass < 3; pass++) {
  for (let i = 0; i <= 20; i++) {
    const f = pass % 2 ? 1 - i / 20 : i / 20;
    await page.mouse.move(elev.x + elev.width * f, elev.y + elev.height / 2);
  }
}
await wait(400);

await mark('scrub-drag');                            // click-drag across it, fast
for (let pass = 0; pass < 3; pass++) {
  await page.mouse.move(elev.x + 4, elev.y + elev.height / 2);
  await page.mouse.down();
  for (let i = 0; i <= 24; i++) await page.mouse.move(elev.x + elev.width * (i / 24), elev.y + elev.height / 2);
  await page.mouse.up();
}
await wait(400);

await mark('play-120x');                             // press play at 120x
await page.click('#playBtn');
await wait(4000);

await mark('play+pan');                              // pan the map while playing
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 0; i < 40; i++) await page.mouse.move(cx + Math.sin(i / 5) * 220, cy + Math.cos(i / 7) * 140);
await page.mouse.up();
await wait(200);

await mark('play+scrub');                            // scrub while it plays
for (let pass = 0; pass < 2; pass++) {
  for (let i = 0; i <= 20; i++) {
    const f = pass % 2 ? 1 - i / 20 : i / 20;
    await page.mouse.move(elev.x + elev.width * f, elev.y + elev.height / 2);
  }
}
await wait(300);
await page.click('#playBtn');                        // stop
await wait(300);

await mark('zoom');                                  // wheel in and out
for (let i = 0; i < 24; i++) await page.mouse.wheel(0, i % 2 ? 260 : -260);
await wait(400);

await mark('rotate');                                // right-drag orbit
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
for (let i = 0; i < 40; i++) await page.mouse.move(cx + Math.sin(i / 6) * 260, cy + Math.cos(i / 6) * 90);
await page.mouse.up({ button: 'right' });
await wait(400);

await mark('idle-after');                            // does it settle back down?
await wait(3000);
await mark('end');

// ---- report ----------------------------------------------------------------
const raw = await page.evaluate(() => {
  const P = window.__P, sc = window.__viewer.scene;
  const res = performance.getEntriesByType('resource');
  const bytes = res.reduce((a, e) => a + (e.transferSize || 0), 0);
  const tiles = res.filter((e) => e.name.includes('/tiles/'));
  const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  return { marks: P.marks, frames: P.frames, stats: P.stats, tasks: P.tasks, reqs: P.reqs,
           renderedFrames: sc.renderedFrames, entities: window.__viewer.entities.values.length,
           resCount: res.length, resBytes: bytes, tileCount: tiles.length,
           tileBytes: tiles.reduce((a, e) => a + (e.transferSize || 0), 0), heapMB: heap,
           canvas: [sc.canvas.width, sc.canvas.height] };
});

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const rows = [];
for (let i = 0; i < raw.marks.length - 1; i++) {
  const [name, t0] = raw.marks[i], [, t1] = raw.marks[i + 1];
  const idx = [];
  for (let k = 0; k < raw.frames.length; k++) if (raw.frames[k] >= t0 && raw.frames[k] < t1) idx.push(k);
  const fr = idx.map((k) => raw.frames[k]);
  const gaps = [];
  for (let k = 1; k < fr.length; k++) gaps.push(fr[k] - fr[k - 1]);
  const st = idx.map((k) => raw.stats[k]).filter(Boolean);
  const dur = (t1 - t0) / 1000;
  rows.push({
    scenario: name, seconds: +dur.toFixed(2),
    frames: fr.length, fps: +(fr.length / dur).toFixed(1),
    frameMs_p50: +pct(gaps, 0.5).toFixed(1), frameMs_p95: +pct(gaps, 0.95).toFixed(1), frameMs_max: +pct(gaps, 0.99).toFixed(1),
    drawCalls: Math.round(mean(st.map((s) => s[0]))), drawCallsMax: Math.max(0, ...st.map((s) => s[0])),
    triangles: Math.round(mean(st.map((s) => s[1]))),
    primitives: Math.round(mean(st.map((s) => s[2]))),
    tilesRendered: Math.round(mean(st.map((s) => s[5]))),
    longTasks: raw.tasks.filter(([t]) => t >= t0 && t < t1).length,
    blockedMs: Math.round(raw.tasks.filter(([t]) => t >= t0 && t < t1).reduce((a, [, d]) => a + Math.max(0, d - 50), 0)),
  });
}
const report = { label: LABEL, viewport: `${W}x${H}@${DPR}`, backingStore: raw.canvas.join('x'),
                 bootMs: Date.now() - t0, entities: raw.entities,
                 resources: { count: raw.resCount, bytes: raw.resBytes, tiles: raw.tileCount, tileBytes: raw.tileBytes },
                 heapMB: raw.heapMB, tileRequestsDuringScenario: tileReqs, scenarios: rows };
writeFileSync(`${OUT}${LABEL}.json`, JSON.stringify(report, null, 1));
console.log(`\n${LABEL}  ${W}x${H}@${DPR}  backing ${raw.canvas.join('x')}  entities ${raw.entities}  heap ${raw.heapMB}MB  tiles ${raw.tileCount} (${(raw.tileBytes / 1048576).toFixed(1)}MB)`);
console.log('scenario      sec  frames   fps   p50/p95/max ms   calls   tris  prims tiles  long/blkd');
for (const r of rows) {
  console.log(
    r.scenario.padEnd(13) + String(r.seconds).padStart(4) + String(r.frames).padStart(7) + String(r.fps).padStart(7) +
    `   ${String(r.frameMs_p50).padStart(5)}/${String(r.frameMs_p95).padStart(5)}/${String(r.frameMs_max).padStart(6)}` +
    String(r.drawCalls).padStart(7) + String(r.triangles).padStart(7) + String(r.primitives).padStart(6) +
    String(r.tilesRendered).padStart(6) + String(r.longTasks).padStart(6) + '/' + String(r.blockedMs).padStart(5));
}
if (errors.length) console.log('ERRORS: ' + errors.slice(0, 5).join(' | '));
await browser.close();
