// Renders the trail-pilot vehicle-convoy marker as a transparent PNG.
//
// The viewer lays a square quad flat on the ground and bakes the compass
// heading into the image (front of the lead vehicle points to the top edge =
// north; the texture is rotated around its center). This script draws a
// 2.5D "extruded" 3/4 aerial of the convoy — a red 4-door Jeep Wrangler JKU
// tows a blue 4-door Toyota Tacoma — so it reads as real vehicles (roof,
// glass, grille, roof rack, open pickup bed, treaded tires, drop shadow)
// rather than flat rectangular blocks. Front points UP.
//
// The convoy's bounding box is inscribed in the square so it never clips at
// any rotation. Output: web/vehicle-convoy.png (transparent background).
//
// Run: node tools/render-convoy.mjs   (needs PLAYWRIGHT_BROWSERS_PATH chromium)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SIZE = 896; // output square (px)
const FIT = 0.92; // inscribe to this fraction of SIZE so 45deg rotation fits

// ---- tiny SVG emitters (rounded to 2dp) ----
const R2 = (n) => Math.round(n * 100) / 100;
const rr = (x, y, w, h, r, fill, stroke, sw, extra = '') =>
  `<rect x='${R2(x)}' y='${R2(y)}' width='${R2(w)}' height='${R2(h)}' rx='${R2(r)}' ry='${R2(r)}' fill='${fill}'${stroke ? ` stroke='${stroke}' stroke-width='${sw}'` : ''} ${extra}/>`;
const el = (x, y, rx, ry, fill, stroke, sw, rot, extra = '') =>
  `<ellipse cx='${R2(x)}' cy='${R2(y)}' rx='${R2(rx)}' ry='${R2(ry)}' fill='${fill}'${stroke ? ` stroke='${stroke}' stroke-width='${sw}'` : ''}${rot ? ` transform='rotate(${R2(rot)} ${R2(x)} ${R2(y)})'` : ''} ${extra}/>`;
const pa = (d, fill, stroke, sw, extra = '') =>
  `<path d='${d}'${fill ? ` fill='${fill}'` : ''}${stroke ? ` stroke='${stroke}' stroke-width='${sw}' stroke-linecap='round' stroke-linejoin='round'` : ''} ${extra}/>`;
const ln = (x1, y1, x2, y2, stroke, sw, extra = '') =>
  `<line x1='${R2(x1)}' y1='${R2(y1)}' x2='${R2(x2)}' y2='${R2(y2)}' stroke='${stroke}' stroke-width='${sw}' ${extra}/>`;
const dot = (x, y, r, fill, stroke, sw) =>
  `<circle cx='${R2(x)}' cy='${R2(y)}' r='${R2(r)}' fill='${fill}'${stroke ? ` stroke='${stroke}' stroke-width='${sw}'` : ''}/>`;

// A treaded wheel: rounded dark tire straddling a body edge, with a tread seam.
// cx,cy = wheel center; vertical tire (tread runs top-bottom).
function wheel(cx, cy, w, h, side) {
  const tire = rr(cx - w / 2, cy - h / 2, w, h, w * 0.42, '#0e1013', '#000', 0.6);
  const tread = ln(cx, cy - h * 0.32, cx, cy + h * 0.32, '#3a3f47', 2.4, `stroke-dasharray='${R2(w * 0.28)} ${R2(w * 0.22)}'`);
  const hub = el(cx, cy, w * 0.22, h * 0.16, '#2c3038');
  return tire + tread + hub;
}

// Draw one vehicle. (ox,oy) = top-left of the TOP face. Front points UP.
// c = palette. Returns { svg, bbox } where bbox is the local extents used for layout.
function vehicle(kind, ox, oy, c) {
  const W = 92;                                        // body width
  const L = kind === 'taco' ? 262 : 224;               // body length (taco longer: bed)
  const D = kind === 'taco' ? 44 : 40;                 // front (hood) wall height
  const Ds = 30;                                       // side (left) wall thickness
  const Rr = 17;                                       // top-face corner radius
  const x0 = ox, y0 = oy;

  let s = '';
  // --- drop shadow (soft, offset lower-right) plants the vehicle on the ground
  s += `<rect x='${R2(x0 + Ds - 4)}' y='${R2(y0 + D + 5)}' width='${R2(W + 10)}' height='${R2(L + 4)}' rx='${R2(Rr + 5)}' fill='#04060a' opacity='0.30' filter='url(#sh)'/>`;

  // --- 3D walls (drawn first, top face covers their inner edges)
  s += rr(x0 - Ds, y0, Ds, L, 9, c.side, '', 0);        // left (side) wall — darkest
  s += rr(x0, y0 - D, W, D, 10, c.front, '', 0);        // front (hood) wall — lightest

  // --- top face (base body) + a top-lit gloss sheen
  s += rr(x0, y0, W, L, Rr, c.body, c.bodyEdge, 1.3);
  s += rr(x0, y0, W, L, Rr, 'url(#glossV)');

  // --- wheels (4), straddling the side edges, front near top / rear near bottom
  const ww = 20, wh = 38, wy0 = 36, wy1 = L - 36, off = 5;
  s += wheel(x0 - off, y0 + wy0, ww, wh, 'FL');
  s += wheel(x0 + W + off, y0 + wy0, ww, wh, 'FR');
  s += wheel(x0 - off, y0 + wy1, ww, wh, 'RL');
  s += wheel(x0 + W + off, y0 + wy1, ww, wh, 'RR');

  // --- front wall details: hood + grille + headlights
  const hoodTop = y0 - D;
  if (kind === 'jeep') {
    // flat hood + black 7-slot grille + round headlights (the Jeep face)
    s += rr(x0 + 8, hoodTop + D - 10, W - 16, 10, 2, '#17191d', '', 0);
    s += rr(x0 + 7, hoodTop + 4, W - 14, 15, 3, '#0c0e11', '', 0);
    for (let i = 0; i < 7; i++) s += ln(x0 + 14 + i * (W - 28) / 6, hoodTop + 6, x0 + 14 + i * (W - 28) / 6, hoodTop + 17, '#33383f', 2.4);
    s += dot(x0 + 13, hoodTop + 11, 4.8, '#ffe9a8', '#17191d', 1.5);
    s += dot(x0 + W - 13, hoodTop + 11, 4.8, '#ffe9a8', '#17191d', 1.5);
  } else {
    // long pickup hood: black grille + slim headlights
    s += rr(x0 + 9, hoodTop + 4, W - 18, 12, 3, '#0c0e11', '', 0);
    s += ln(x0 + 16, hoodTop + 10, x0 + W - 16, hoodTop + 10, '#2f353d', 2.6);
    s += rr(x0 + 11, hoodTop + D - 8, 16, 5, 1.6, '#eaf1ff', '', 0);
    s += rr(x0 + W - 27, hoodTop + D - 8, 16, 5, 1.6, '#eaf1ff', '', 0);
  }

  // --- top-face features
  if (kind === 'jeep') {
    // red hood deck, then windshield, then red hardtop roof + black roof rack
    const hoodH = 26;
    s += rr(x0 + 10, y0 + 5, W - 20, hoodH, 5, c.hood, c.bodyEdge, 0.8);
    const wsY = y0 + 5 + hoodH + 3, wsH = 20;
    s += pa(`M${R2(x0 + 13)} ${R2(wsY)} L${R2(x0 + W - 13)} ${R2(wsY)} L${R2(x0 + W - 19)} ${R2(wsY + wsH)} L${R2(x0 + 19)} ${R2(wsY + wsH)} Z`, '#15202b');
    const roofY = wsY + wsH + 4, roofH = L - (roofY - y0) - 12;
    s += rr(x0 + 9, roofY, W - 18, roofH, 8, c.roof, c.bodyEdge, 1.2); // red hardtop
    // side windows (greenhouse) along both edges
    s += rr(x0 + 2, roofY - 2, 6, roofH + 4, 2, '#10161f');
    s += rr(x0 + W - 8, roofY - 2, 6, roofH + 4, 2, '#10161f');
    // roof rack: rails + 3 crossbars (the JKU tell)
    const rx0 = x0 + 13, rx1 = x0 + W - 13, rw = rx1 - rx0;
    s += rr(rx0 - 2, roofY + 5, rw + 4, 4, 2, '#2a2e35');
    s += rr(rx0 - 2, roofY + roofH - 9, rw + 4, 4, 2, '#2a2e35');
    for (let i = 0; i < 3; i++) { const ry = roofY + 10 + i * (roofH - 22) / 2; s += rr(rx0, ry, rw, 4, 2, '#2a2e35'); }
    // door seams on the roof (4-door) + rear window
    s += ln(x0 + 13, roofY + roofH * 0.42, x0 + W - 13, roofY + roofH * 0.42, '#a12824', 1.4);
    s += ln(x0 + 13, roofY + roofH * 0.72, x0 + W - 13, roofY + roofH * 0.72, '#a12824', 1.4);
    s += rr(x0 + 13, roofY + roofH - 6, W - 26, 5, 2, '#15202b'); // rear window
    // flared fenders (near side)
    s += pa(`M${R2(x0 - 1)} ${R2(y0 + wy0 - 16)} q-10 16 0 32`, c.side, '', 5);
    s += pa(`M${R2(x0 - 1)} ${R2(y0 + wy1 - 16)} q-10 16 0 32`, c.side, '', 5);
    // side mirror (front-left)
    s += rr(x0 - 7, wsY + 1, 8, 7, 2, c.body, c.bodyEdge, 1);
  } else {
    // Tacoma: long hood deck, cab (windshield + roof), then a clean OPEN BED
    const hoodH = L * 0.30;
    s += rr(x0 + 10, y0 + 5, W - 20, hoodH, 5, c.hood, c.bodyEdge, 0.8);
    const wsY = y0 + 5 + hoodH + 3, wsH = 18;
    s += pa(`M${R2(x0 + 13)} ${R2(wsY)} L${R2(x0 + W - 13)} ${R2(wsY)} L${R2(x0 + W - 17)} ${R2(wsY + wsH)} L${R2(x0 + 17)} ${R2(wsY + wsH)} Z`, '#15202b');
    const cabY = wsY + wsH + 4, cabH = L * 0.26;
    s += rr(x0 + 9, cabY, W - 18, cabH, 7, c.body, c.bodyEdge, 1); // cab roof
    s += rr(x0 + 2, cabY, 6, cabH + 2, 2, '#10161f');              // side windows
    s += rr(x0 + W - 8, cabY, 6, cabH + 2, 2, '#10161f');
    s += ln(x0 + W / 2, cabY + 2, x0 + W / 2, cabY + cabH - 2, '#1a3f9e', 1.4); // B-pillar
    // OPEN PICKUP BED — a clean dark rectangle (the pickup tell)
    const bedY = cabY + cabH + 4, bedH = y0 + L - 8 - bedY;
    s += rr(x0 + 8, bedY, W - 16, bedH, 5, '#11151c', '#0a0d12', 1);
    s += ln(x0 + 13, bedY + bedH / 2, x0 + W - 13, bedY + bedH / 2, '#262e39', 2); // interior seam
    s += rr(x0 + 12, bedY + 3, W - 24, 3, 1.5, '#1c2430');          // inner lip
    // rear wheel arches: subtle dark notches at the outer bed edges (not big circles)
    s += rr(x0 + 6, y0 + wy1 - 12, 9, 26, 4, '#0c0f15');
    s += rr(x0 + W - 15, y0 + wy1 - 12, 9, 26, 4, '#0c0f15');
    // tailgate (very rear)
    s += rr(x0 + 8, y0 + L - 8, W - 16, 5, 2, c.body, c.bodyEdge, 0.8);
    s += dot(x0 + W / 2, y0 + L - 5.5, 1.8, '#8ba0b5');
  }

  // local bbox (incl. walls + wheels) for layout
  const bbox = { x: ox - Ds - off - 2, y: oy - D - 2, w: W + Ds + 2 * off + 4, h: D + L + 4 };
  return { svg: s, bbox };
}

// ---- palettes (light from upper-left: front wall lightest, side wall darkest) ----
const JE = { body: '#d23a34', bodyEdge: '#8f1f1c', front: '#ec5c52', side: '#93211d', hood: '#c9352f', roof: '#b8302a' };
const TA = { body: '#2f63d8', bodyEdge: '#16387f', front: '#5583e8', side: '#1a3a86', hood: '#3f72e0', roof: '#2f63d8' };

// ---- lay the convoy out (jeep on top/front, taco behind), inscribed in the square ----
function buildConvoy() {
  // jeep
  const j = vehicle('jeep', 0, 0, JE);
  const jH = j.bbox.h, jW = j.bbox.w;
  // taco sits behind jeep with a tow gap
  const gap = 46;
  const ty = (j.bbox.y + j.bbox.h) + gap;
  const t = vehicle('taco', 0, ty, TA);

  // tow strap between jeep rear and taco front (centered)
  const strapY0 = j.bbox.y + j.bbox.h - 4;
  const strapY1 = ty + t.bbox.y - t.bbox.y + 2; // taco front wall top
  const strap = `<path d='M -6 ${R2(strapY0)} C -10 ${R2(strapY0 + gap * 0.4)} 10 ${R2(strapY1 - gap * 0.4)} 6 ${R2(strapY1)}' fill='none' stroke='#0c0e11' stroke-width='6' stroke-linecap='round'/>` +
    `<path d='M -6 ${R2(strapY0)} C -10 ${R2(strapY0 + gap * 0.4)} 10 ${R2(strapY1 - gap * 0.4)} 6 ${R2(strapY1)}' fill='none' stroke='#3a3f47' stroke-width='2' stroke-dasharray='5 6'/>`;

  // overall bbox
  const minX = Math.min(j.bbox.x, t.bbox.x);
  const maxX = Math.max(j.bbox.x + j.bbox.w, t.bbox.x + t.bbox.w);
  const minY = Math.min(j.bbox.y, t.bbox.y);
  const maxY = Math.max(j.bbox.y + j.bbox.h, t.bbox.y + t.bbox.h);
  const bw = maxX - minX, bh = maxY - minY;

  // scale so the bbox diagonal == FIT * SIZE (inscribed -> no clip at any heading)
  const diag = Math.hypot(bw, bh);
  const sc = (FIT * SIZE) / diag;
  // translate so the bbox center lands at the canvas center
  const tcx = SIZE / 2, tcy = SIZE / 2;
  const bx = minX + bw / 2, by = minY + bh / 2;

  const defs = `<defs>
    <filter id='sh' x='-30%' y='-30%' width='160%' height='160%'>
      <feGaussianBlur stdDeviation='7'/>
    </filter>
    <linearGradient id='glossV' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#ffffff' stop-opacity='0.30'/>
      <stop offset='0.42' stop-color='#ffffff' stop-opacity='0.05'/>
      <stop offset='0.75' stop-color='#000000' stop-opacity='0.04'/>
      <stop offset='1' stop-color='#000000' stop-opacity='0.16'/>
    </linearGradient>
  </defs>`;

  return `<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}' viewBox='0 0 ${SIZE} ${SIZE}'>
    ${defs}
    <g transform='translate(${R2(tcx)},${R2(tcy)}) scale(${R2(sc)}) translate(${R2(-bx)},${R2(-by)})'>
      ${j.svg}
      ${strap}
      ${t.svg}
    </g>
  </svg>`;
}

const svg = buildConvoy();

const here = path.dirname(new URL(import.meta.url).pathname);
const outPng = path.resolve(here, '..', 'web', 'vehicle-convoy.png');
const svgPath = path.resolve(here, 'vehicle-convoy.svg');
fs.writeFileSync(svgPath, svg);

async function render() {
  const html = `<!doctype html><html><head><meta charset=utf-8><style>
    html,body{margin:0;padding:0;background:transparent;}
    svg{display:block;width:${SIZE}px;height:${SIZE}px;}
  </style></head><body>${svg}</body></html>`;
  const htmlPath = path.resolve(here, 'vehicle-convoy-preview.html');
  fs.writeFileSync(htmlPath, html);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
  await page.goto('file://' + htmlPath);
  await page.waitForTimeout(250);
  await page.screenshot({ path: outPng, omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
  // also a checkerboard preview for quick inspection
  await page.setContent(html.replace('background:transparent', 'background:repeating-conic-gradient(#dfe3ea 0% 25%, #ffffff 0% 50%) 50% / 40px 40px'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: outPng.replace('.png', '-preview.png'), clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
  await browser.close();
  console.log('wrote', outPng);
  console.log('wrote', outPng.replace('.png', '-preview.png'));
}
render().catch((e) => { console.error(e); process.exit(1); });
