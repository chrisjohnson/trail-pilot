// Comprehensive Playwright camera battery for the runner-convoy quad.
// Moves the camera ALL AROUND: nadir, oblique, far, close, pans, rotations,
// zooms, playback, and mid-route follow. Reports console/page errors.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const SHOTS = path.resolve(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let shotCount = 0;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      errors.push(m.type() + ': ' + m.text());
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://127.0.0.1:8137/viewer?route=friday-morning-hard-trail-run', { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__viewer && window.__runnerBillboard && window.__runnerBillboard.runSVG !== null,
    null, { timeout: 90000 });
  await page.waitForTimeout(5000); // let tiles + entities settle

  const runner = await page.evaluate(async () => {
    const r = await (await fetch('route_data.json?route=friday-morning-hard-trail-run', { cache: 'no-store' })).json();
    const p = r.route[0];
    return { lon: p[0], lat: p[1], totalDur: r.totalDurationSec };
  });
  console.log('runner at', runner);

  // Confirm texture dimensions (deliverable says 382x1614 RGBA)
  const texInfo = await page.evaluate(() => {
    const bb = window.__runnerBillboard;
    return {
      ready: !!bb.ready,
      runSVG: bb.runSVG ? { w: bb.runSVG.width, h: bb.runSVG.height } : null,
      runW: bb.runW, runH: bb.runH
    };
  });
  console.log('texture info:', JSON.stringify(texInfo));

  // Safe screenshot helper that checks page state first
  const safeShot = async (name, opts) => {
    // Pause playback if running
    try {
      await page.evaluate(() => {
        const pb = document.getElementById('playBtn');
        if (pb && pb.textContent.includes('Pause')) {
          pb.click();
        }
      });
      await page.waitForTimeout(1000);
    } catch(e) {}

    const locStr = opts ? ` at [${opts.lon || runner.lon}, ${opts.lat || runner.lat}, ${opts.range || 'n/a'}m]` : '';
    console.log(`shot: ${name}${locStr}`);
    await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
    shotCount++;
  };

  // lookAt helper: target = runner position, controlled heading/pitch/range.
  const look = async (name, opts) => {
    const defaultOpts = { lon: runner.lon, lat: runner.lat, targetH: 2 };
    await page.evaluate((a) => {
      const V = window.__viewer;
      const t = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.targetH || 2);
      V.camera.lookAt(t, new Cesium.HeadingPitchRange(
        a.heading * Math.PI / 180, a.pitch * Math.PI / 180, a.range));
    }, Object.assign(defaultOpts, opts));
    await page.waitForTimeout(2500);
    await safeShot(name, { ...defaultOpts, ...opts });
  };

  // ---- 1. Nadir views (top-down) ----
  await look('01-nadir-150m',  { heading: 0,   pitch: -90, range: 150 });
  await look('02-nadir-60m',   { heading: 0,   pitch: -90, range: 60 });
  await look('03-nadir-120m',  { heading: 0,   pitch: -90, range: 120 });

  // ---- 2. 4-direction oblique sweeps (30-60° angles) ----
  await look('04-oblique-45m-n',  { heading: 0,   pitch: -60, range: 45 });
  await look('05-oblique-120m-e', { heading: 90,  pitch: -60, range: 120 });
  await look('06-oblique-120m-s', { heading: 180, pitch: -60, range: 120 });
  await look('07-oblique-120m-w', { heading: 270, pitch: -60, range: 120 });

  // ---- 3. 3/4 quarter views (orbit around convoy) ----
  await look('08-quarter-NE',  { heading: 225, pitch: -50, range: 100 });
  await look('09-quarter-SE',  { heading: 315, pitch: -50, range: 100 });
  await look('10-quarter-SW',  { heading: 135, pitch: -50, range: 100 });
  await look('11-quarter-NW',  { heading: 45,  pitch: -50, range: 100 });

  // ---- 4. Far views (zoom out) ----
  await look('12-far-3km',     { heading: 30,  pitch: -45, range: 3000 });
  await look('13-overview-15km',{ heading: 0,  pitch: -55, range: 15000 });

  // ---- 5. Side views from cardinal directions (eye-level-ish) ----
  await look('14-side-fromE',  { heading: 270, pitch: -10, range: 42 });
  await look('15-side-fromW',  { heading: 90,  pitch: -10, range: 42 });
  await look('16-side-fromS',  { heading: 0,   pitch: -14, range: 46 });
  await look('17-side-fromN',  { heading: 180, pitch: -14, range: 46 });

  // ---- 6. Near-grazing angles (test the flat-quad edge-on behavior) ----
  await look('18-grazing-low', { heading: 0,   pitch: -5,  range: 35 });
  await look('19-grazing-high',{ heading: 90,  pitch: -8,  range: 80 });

  // ---- 7. Playback sanity: press play and confirm no crash + heading re-bake ----
  const playBtn = await page.$('#playBtn');
  if (playBtn) {
    await playBtn.click();
    await page.waitForTimeout(12000); // 12s playback at 120x = 24min route time
    const playState = await page.evaluate(() => {
      const c = window.__viewer.camera;
      return {
        ready: !!window.__runnerBillboard.runSVG,
        alt: Math.round(c.positionCartographic.height),
        heading: Cesium.Math.toDegrees(c.heading).toFixed(1) + '°',
        pitch: Cesium.Math.toDegrees(c.pitch).toFixed(1) + '°'
      };
    });
    console.log('after 12s playback:', JSON.stringify(playState));
    await look('20-playback-70m', { heading: 0, pitch: -90, range: 70 });
  } else {
    console.log('no play button found');
  }

  // ---- 8. Mid-route follow: scrub timeline via direct elapsed set ----
  // Use the public showAt function via the page evaluate
  await page.evaluate(() => {
    // Set elapsed to ~6.5mi equivalent (approx 40% through a 30min route = 720s)
    window.__elapsed = 720;
    window.__playing = false;
  });
  await page.waitForTimeout(2000);
  await look('21-midroute-follow', { heading: 180, pitch: -45, range: 80 });

  // ---- 9. Zoom in/out test ----
  await page.evaluate(() => {
    const c = window.__viewer.camera;
    c.zoomIn(50);
  });
  await page.waitForTimeout(2000);
  await look('22-zoom-in-close', { heading: 45, pitch: -30, range: 25 });

  await page.evaluate(() => {
    const c = window.__viewer.camera;
    c.zoomOut(200);
  });
  await page.waitForTimeout(2000);
  await look('23-zoom-out-mid', { heading: 90, pitch: -45, range: 400 });

  // ---- 10. Pan around the route (move camera to different route positions) ----
  await look('24-pan-midroute', { lon: runner.lon + 0.001, lat: runner.lat + 0.001, heading: 180, pitch: -45, range: 200, targetH: 2 });

  // ---- 11. Rotate heading (orbit around convoy in 90° increments) ----
  for (let h = 0; h < 360; h += 90) {
    await look(`25-rotate-${h}deg`, { heading: h, pitch: -45, range: 100 });
  }

  // ---- 12. Full 360 orbit (smooth rotation around convoy) ----
  for (let h = 0; h < 360; h += 30) {
    await look(`26-orbit-${h}deg`, { heading: h, pitch: -35, range: 60 });
  }

  // release lookAt so normal control resumes
  await page.evaluate(() => { window.__viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); });

  console.log(`\nTotal screenshots: ${shotCount}`);
  console.log('ERRORS(' + errors.length + '):');
  errors.slice(0, 30).forEach((e) => console.log('  ' + e));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
