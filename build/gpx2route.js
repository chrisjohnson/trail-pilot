#!/usr/bin/env node
/**
 * gpx2route.js — convert a GPX track into the route_data.json that trail-pilot's
 * index.html consumes.
 *
 * Usage: node gpx2route.js <input.gpx> [output.json]
 *
 * Break detection: a "break" is a stretch where the runner is nearly stationary
 * — total GPS drift over a 10-minute window stays under BREAK_DRIFT_M. Tune the
 * constants below if a given GPX has a different point density.
 */
const fs = require('fs');

// ---- tunables ----
const WINDOW_SEC    = 600;  // sliding window length (10 min)
const BREAK_DRIFT_M = 200;  // max meters of movement in the window to count as a break
const MIN_BREAK_SEC = 600;  // minimum break duration (10 min) to keep
// ------------------

const R = 6371008.8, toR = Math.PI / 180;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*toR)*Math.cos(b.lat*toR)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function parseGpx(xml) {
  const name = (xml.match(/<trk>\s*<name>([^<]*)<\/name>/) || xml.match(/<name>([^<]*)<\/name>/) || [])[1] || 'Route';
  const pts = [];
  const re = /<trkpt\s+lat="(-?[\d.]+)"\s+lon="(-?[\d.]+)">(?:\s*<ele>([\d.]+)<\/ele>)?(?:\s*<time>([^<]*)<\/time>)?<\/trkpt>/g;
  let m;
  while ((m = re.exec(xml))) {
    pts.push({ lon: parseFloat(m[2]), lat: parseFloat(m[1]), ele: m[3] !== undefined ? parseFloat(m[3]) : 0, t: m[4] ? Date.parse(m[4]) : NaN });
  }
  if (!pts.length) throw new Error('No <trkpt> elements found in GPX');
  return { name, pts };
}

function detectBreaks(pts) {
  const N = pts.length;
  const segD = new Float64Array(N - 1), segT = new Float64Array(N - 1);
  let totalM = 0;
  for (let i = 0; i < N - 1; i++) { segD[i] = hav(pts[i], pts[i+1]); segT[i] = (pts[i+1].t - pts[i].t) / 1000; totalM += segD[i]; }
  const pD = new Float64Array(N), pT = new Float64Array(N);
  for (let i = 0; i < N - 1; i++) { pD[i+1] = pD[i] + segD[i]; pT[i+1] = pT[i] + segT[i]; }
  const stationary = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let lo = i, hi = N - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pT[mid] - pT[i] <= WINDOW_SEC) lo = mid; else hi = mid - 1; }
    const j = lo;
    if ((pD[j] - pD[i]) < BREAK_DRIFT_M) stationary[i] = 1;
  }
  const breaks = [];
  let i = 0;
  while (i < N) {
    if (stationary[i]) {
      let end = i; while (end + 1 < N && stationary[end+1]) end++;
      const dur = pT[end] - pT[i];
      if (dur >= MIN_BREAK_SEC) breaks.push({ start: i, end, durSec: Math.round(dur) });
      i = end + 1;
    } else i++;
  }
  return { breaks, totalM, pD };
}

function fmtDur(s) { s = Math.round(s); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  if (h > 0) return h + 'h ' + m + 'm'; if (m > 0) return m + 'm'; return s + 's'; }
function utcStr(ms) { return new Date(ms).toISOString().replace('T',' ').replace('.000Z',' UTC'); }

function main() {
  const input = process.argv[2];
  if (!input) { console.error('Usage: node gpx2route.js <input.gpx> [output.json]'); process.exit(1); }
  const xml = fs.readFileSync(input, 'utf8');
  const { name, pts } = parseGpx(xml);
  const t0 = pts[0].t;
  const { breaks, totalM, pD } = detectBreaks(pts);
  const totalSec = Math.round((pts[pts.length-1].t - t0) / 1000);
  const totalMiles = totalM / 1609.34;
  const mid = Math.floor(pts.length / 2);
  const route = pts.map(p => [p.lon, p.lat, p.ele, Math.round((p.t - t0) / 1000)]);
  const breakObjs = breaks.map(b => ({
    type: 'break',
    lon: pts[b.start].lon, lat: pts[b.start].lat,
    mile: (pD[b.start] / 1609.34).toFixed(2),
    durSec: b.durSec, durStr: fmtDur(b.durSec),
    startUTC: utcStr(t0 + b.start * 1000),
  }));
  const out = {
    name,
    totalDistanceMiles: +totalMiles.toFixed(1),
    totalDistanceKm: +(totalM / 1000).toFixed(1),
    totalDurationSec: totalSec,
    totalDurationStr: fmtDur(totalSec),
    startUTC: utcStr(t0),
    centerLat: pts[mid].lat, centerLon: pts[mid].lon,
    breaks: breakObjs,
    route,
  };
  const output = process.argv[3] || 'route_data.json';
  fs.writeFileSync(output, JSON.stringify(out));
  console.log('Wrote', output);
  console.log('  name:', name);
  console.log('  points:', pts.length);
  console.log('  distance:', out.totalDistanceMiles, 'mi');
  console.log('  duration:', out.totalDurationStr);
  console.log('  breaks:', breakObjs.length, breakObjs.map(b => b.durStr + '@' + b.mile + 'mi').join(', '));
}
main();
