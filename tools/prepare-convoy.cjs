// Prepares web/vehicle-convoy.png for use as the Cesium runner-quad/billboard
// texture:
//   1) strips the pure-black background (edge flood-fill -> alpha 0; interior
//      dark pixels like tires stay opaque),
//   2) crops to the content bounding box (+ margin),
//   3) writes web/vehicle-convoy.png (the master is kept as
//      web/vehicle-convoy-src.png and re-runs are idempotent).
//
// Usage: node tools/prepare-convoy.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'web', 'vehicle-convoy.png');
const SRC = path.join(root, 'web', 'vehicle-convoy-src.png');
if (!fs.existsSync(SRC) && fs.existsSync(OUT)) fs.copyFileSync(OUT, SRC);
const input = fs.existsSync(SRC) ? SRC : OUT;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(input).toString('base64');
  const result = await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const w = img.width, h = img.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, w, h);
    const px = id.data;
    const idx = (x, y) => (y * w + x) * 4;
    // "background" = near-black pixels CONNECTED to the image border, so dark
    // interior detail (tires, bed floor, tow line) stays opaque.
    const isBg = (x, y) => {
      const o = idx(x, y);
      return Math.max(px[o], px[o + 1], px[o + 2]) < 28;
    };
    const seen = new Uint8Array(w * h);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      if (seen[i] || !isBg(x, y)) return;
      seen[i] = 1; stack.push(x, y);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      px[idx(x, y) + 3] = 0;
      push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
    }
    // Bounding box of remaining content.
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (px[idx(x, y) + 3] !== 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    const M = 8; // margin so rotation/crop never clips a wheel
    x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M);
    x1 = Math.min(w - 1, x1 + M); y1 = Math.min(h - 1, y1 + M);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const out = document.createElement('canvas'); out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
    return { w: cw, h: ch, b64: out.toDataURL('image/png').split(',')[1] };
  }, dataUrl);
  fs.writeFileSync(OUT, Buffer.from(result.b64, 'base64'));
  console.log('wrote ' + OUT + ' (' + result.w + 'x' + result.h + ')');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
