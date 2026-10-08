// CPU profile per interaction, aggregated to self-time. The point is to separate
// "the software rasteriser is slow" (a headless artefact) from "our JavaScript is
// doing N ms of work per frame" (a real mobile cost), so GL/driver frames are
// reported separately rather than mixed into the JS ranking.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.TP_CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1512, height: 950 } });
const cdp = await page.context().newCDPSession(page);
await page.goto(process.env.TP_URL || 'http://127.0.0.1:8137/viewer?route=friday-morning-hard-trail-run', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__viewer && window.__viewer.entities.values.length > 100', null, { timeout: 60000 });
await page.waitForFunction('window.__viewer.scene.globe.tilesLoaded === true', null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500);

const canvas = await page.locator('#cesiumContainer').boundingBox();
const elev = await page.locator('#elev').boundingBox();
const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;

const GL = /gl[A-Z]|SwiftShader|libGL|_gl|bindTexture|drawElements|drawArrays|texImage|bufferData|flush|finish/i;

async function profile(name, fn) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await fn();
  const { profile: p } = await cdp.send('Profiler.stop');
  const ms = Date.now() - t0;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of p.nodes) for (const c of n.children || []) children.set(c, n.id);
  const self = new Map();
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i] || 0) / 1000;
    const n = byId.get(p.samples[i]); if (!n) continue;
    const f = n.callFrame;
    const url = (f.url || '').replace(/^https?:\/\/[^/]+/, '').split('/').slice(-1)[0] || '(native)';
    const key = `${f.functionName || '(anonymous)'}  ${url}`;
    self.set(key, (self.get(key) || 0) + dt);
  }
  const all = [...self].sort((a, b) => b[1] - a[1]);
  const gl = all.filter(([k]) => GL.test(k)).reduce((a, [, v]) => a + v, 0);
  const js = all.filter(([k]) => !GL.test(k));
  console.log(`\n### ${name}  (${ms} ms wall, ${p.samples.length} samples; GL/native ${gl.toFixed(0)} ms)`);
  for (const [k, v] of js.slice(0, 10)) console.log(`  ${v.toFixed(0).padStart(6)} ms  ${k}`);
}

await profile('play @120x', async () => { await page.click('#playBtn'); await page.waitForTimeout(5000); await page.click('#playBtn'); });
await profile('rotate', async () => {
  await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' });
  for (let i = 0; i < 40; i++) { await page.mouse.move(cx + Math.sin(i / 6) * 260, cy + Math.cos(i / 6) * 90); }
  await page.mouse.up({ button: 'right' }); await page.waitForTimeout(1200);
});
await profile('scrub hover', async () => {
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i <= 20; i++)
    await page.mouse.move(elev.x + elev.width * (pass % 2 ? 1 - i / 20 : i / 20), elev.y + elev.height / 2);
  await page.waitForTimeout(600);
});
await profile('pan', async () => {
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(cx + Math.sin(i / 5) * 220, cy + Math.cos(i / 7) * 140);
  await page.mouse.up(); await page.waitForTimeout(1200);
});
await browser.close();
