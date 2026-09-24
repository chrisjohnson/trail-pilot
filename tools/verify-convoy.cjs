// Playwright verification of the runner-convoy quad:
// waits for the viewer + convoy texture, then flies the camera to a battery
// of poses (nadir, oblique, 90-degree heading sweeps, far zoom) with a
// screenshot at each, and reports console/page errors.
// Usage: node tools/verify-convoy.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const SHOTS = path.resolve(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://127.0.0.1:8137/viewer?route=friday-morning-hard-trail-run', { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__viewer && window.__runnerBillboard && window.__runnerBillboard.runSVG !== null,
    null, { timeout: 90000 });
  await page.waitForTimeout(5000); // let tiles + entities settle

  const runner = await page.evaluate(async () => {
    const r = await (await fetch('route_data.json?route=friday-morning-hard-trail-run', { cache: 'no-store' })).json();
    const p = r.route[0];
    return { lon: p[0], lat: p[1] };
  });
  console.log('runner at', runner);
  const tex = await page.evaluate(() => {
    const c = window.__runnerBillboard.runSVG;
    return { canvas: !!c, w: c && c.width, h: c && c.height, imgW: window.__convImgW || null };
  });
  console.log('texture:', JSON.stringify(tex));

  const shot = async (name, pose) => {
    if (pose) {
      await page.evaluate((p) => {
        window.__viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
          orientation: { heading: (p.heading || 0) * Math.PI / 180, pitch: (p.pitch || -45) * Math.PI / 180, roll: 0 }
        });
      }, Object.assign({ lon: runner.lon, lat: runner.lat }, pose));
      await page.waitForTimeout(2600);
    }
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
    console.log('shot:', name);
  };

  await shot('01-nadir-150m', { alt: 150, pitch: -90, heading: 0 });
  await shot('02-nadir-60m', { alt: 60, pitch: -90, heading: 0 });
  await shot('03-oblique-45m-n', { alt: 45, pitch: -28, heading: 0 });
  await shot('04-oblique-120m-e', { alt: 120, pitch: -50, heading: 90 });
  await shot('05-oblique-120m-s', { alt: 120, pitch: -50, heading: 180 });
  await shot('06-oblique-120m-w', { alt: 120, pitch: -50, heading: 270 });
  await shot('07-far-3km', { alt: 3000, pitch: -45, heading: 30 });
  await shot('08-overview-15km', { alt: 15000, pitch: -55, heading: 0 });

  // Playback sanity: press play and confirm no crash + heading re-bake works.
  await page.evaluate(() => {
    const b = document.getElementById('play-btn') || document.querySelector('#pf-btn') ? null : null;
  });
  const playBtn = await page.$('#play-btn');
  if (playBtn) {
    await playBtn.click();
    await page.waitForTimeout(6000);
    const st = await page.evaluate(() => ({
      ready: !!window.__runnerBillboard.runSVG,
      hd: window.__lastHdDeg
    }));
    console.log('after play tick:', JSON.stringify(st));
    await shot('09-after-playback-60m', { alt: 60, pitch: -90, heading: 0 });
  }

  console.log('ERRORS(' + errors.length + '):');
  errors.slice(0, 20).forEach((e) => console.log('  ' + e));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
