#!/usr/bin/env node
/**
 * gpx2route.js — convert a GPX track into the route_data.json that trail-pilot's
 * index.html consumes.
 *
 * Usage: node gpx2route.js <input.gpx> [output.json] [--tz=Area/Location]
 *
 * Timezone: the IANA timezone of the start point is auto-detected from a
 * precomputed boundary grid (build/tz-grid.json, see gen-tz-grid.js) and
 * written to the output as "timezone". Override with --tz=Area/Location.
 */
const fs = require('fs');
const path = require('path');

// Break detection: a "break" is a stretch where the runner is nearly stationary
// — total GPS drift over a 10-minute window stays under BREAK_DRIFT_M. Tune the
// constants below if a given GPX has a different point density.

// ---- tunables ----
const WINDOW_SEC    = 600;  // sliding window length (10 min)
const BREAK_DRIFT_M = 200;  // max meters of movement in the window to count as a break
const MIN_BREAK_SEC = 600;  // minimum break duration (10 min) to keep
// ------------------

// ---- timezone detection (offline grid; regenerate with gen-tz-grid.js) ----
let TZ_GRID = null;
try { TZ_GRID = JSON.parse(fs.readFileSync(path.join(__dirname, 'tz-grid.json'), 'utf8')); } catch (e) { /* no grid — detection disabled */ }
function tzAt(lat, lon) {
  if (!TZ_GRID) return null;
  const res = TZ_GRID.res, cols = Math.round(360 / res), rows = Math.round(180 / res);
  const r = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / res)));
  const c = Math.min(cols - 1, Math.max(0, Math.floor((lon + 180) / res)));
  for (const run of TZ_GRID.rows[r]) if (c >= run[0] && c < run[0] + run[2]) return run[1] < 0 ? null : TZ_GRID.zones[run[1]];
  return null;
}
function validTz(tz) { try { new Date().toLocaleTimeString('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
// -----------------------------------------------------------------------------

const R = 6371008.8, toR = Math.PI / 180;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*toR)*Math.cos(b.lat*toR)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Permissive: lat/lon in either order, extra attributes allowed, self-closing
// tags allowed. Tries <trkpt> then <rtept> then <wpt> (planned-route and
// waypoint-only exports, e.g. Apple Health).
function parsePoints(xml, el) {
  const re = new RegExp('<' + el + '\\b([^>]*?)(?:>([\\s\\S]*?)</' + el + '>|/>)', 'g');
  const latRe = /lat="(-?[\d.]+)"/, lonRe = /lon="(-?[\d.]+)"/;
  const pts = [];
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1].replace(/\/$/, '');
    const la = attrs.match(latRe), lo = attrs.match(lonRe);
    if (!la || !lo) continue;
    const body = m[2] || '';
    const eleM = body.match(/<ele>([\d.]+)<\/ele>/);
    const timeM = body.match(/<time>([^<]*)<\/time>/);
    pts.push({ lon: parseFloat(lo[1]), lat: parseFloat(la[1]), ele: eleM ? parseFloat(eleM[1]) : 0, t: timeM ? Date.parse(timeM[1]) : NaN });
  }
  return pts;
}
function cdataText(t) {
  t = (t || '').trim();
  if (t.startsWith('<![CDATA[')) {
    const i = t.lastIndexOf(']]>');
    return i >= 0 ? t.slice('<![CDATA['.length, i) : t.slice('<![CDATA['.length);
  }
  return t;
}
// Title chain: <name>/<title> inside <trk>/<rte> (any child order, CDATA-aware),
// then anywhere in the file, then the caller's filename hint, then a generic label.
function extractName(xml) {
  const nameRe = /<name>([^<]*(?:<!\[CDATA\[[^]]*\]\]>[^<]*)*)<\/name>/;
  const titleRe = /<title>([^<]*(?:<!\[CDATA\[[^]]*\]\]>[^<]*)*)<\/title>/;
  const open = xml.match(/<(?:trk|rte)\b[^>]*>/);
  if (open) {
    const start = open.index + open[0].length;
    const e1 = xml.indexOf('</trk>', start), e2 = xml.indexOf('</rte>', start);
    let end = Math.min(e1 < 0 ? Infinity : e1, e2 < 0 ? Infinity : e2);
    if (!isFinite(end)) end = xml.length;
    const inner = xml.slice(start, end);
    let m = inner.match(nameRe); if (m && cdataText(m[1])) return cdataText(m[1]);
    m = inner.match(titleRe); if (m && cdataText(m[1])) return cdataText(m[1]);
  }
  let m = xml.match(nameRe); if (m && cdataText(m[1])) return cdataText(m[1]);
  m = xml.match(titleRe); if (m && cdataText(m[1])) return cdataText(m[1]);
  return '';
}
function parseGpx(xml) {
  let name = extractName(xml);
  for (const el of ['trkpt', 'rtept', 'wpt']) {
    const pts = parsePoints(xml, el);
    if (pts.length) return { name, pts };
  }
  throw new Error('No track points found (<trkpt>/<rtept>/<wpt> all empty) — check the file is a GPX track export (KML/TCX/JSON renamed to .gpx will not work)');
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
function utcStr(ms) { return Number.isNaN(ms) ? 'NaN' : new Date(ms).toISOString().replace('T',' ').replace('.000Z',' UTC'); }

function main() {
  const args = process.argv.slice(2);
  const tzFlag = args.find(a => a.startsWith('--tz='));
  const positional = args.filter(a => !a.startsWith('--'));
  const input = positional[0];
  if (!input) { console.error('Usage: node gpx2route.js <input.gpx> [output.json] [--tz=Area/Location]'); process.exit(1); }
  const xml = fs.readFileSync(input, 'utf8');
  let { name, pts } = parseGpx(xml);
  if (!(name || '').trim()) {
    const base = require('path').basename(input, '.gpx').trim();
    if (base) name = base;
  }
  if (!(name || '').trim()) name = 'Untitled Route';
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
  const override = tzFlag ? tzFlag.slice(5) : null;
  const detected = tzAt(pts[0].lat, pts[0].lon);
  let timezone = override || detected;
  if (timezone && !validTz(timezone)) {
    console.log('  warning: invalid timezone "' + timezone + '"' + (override ? ' (from --tz)' : '') + ' — using ' + (override ? 'detection' : 'none'));
    timezone = override ? detected : null;
  }
  const out = {
    name,
    timezone: timezone || null,
    totalDistanceMiles: +totalMiles.toFixed(1),
    totalDistanceKm: +(totalM / 1000).toFixed(1),
    totalDurationSec: totalSec,
    totalDurationStr: fmtDur(totalSec),
    startUTC: utcStr(t0),
    centerLat: pts[mid].lat, centerLon: pts[mid].lon,
    breaks: breakObjs,
    route,
  };
  const output = positional[1] || 'route_data.json';
  fs.writeFileSync(output, JSON.stringify(out));
  console.log('Wrote', output);
  console.log('  name:', name);
  console.log('  points:', pts.length);
  console.log('  distance:', out.totalDistanceMiles, 'mi');
  console.log('  duration:', out.totalDurationStr);
  console.log('  breaks:', breakObjs.length, breakObjs.map(b => b.durStr + '@' + b.mile + 'mi').join(', '));
  console.log('  timezone:', timezone ? timezone + (detected && timezone !== detected ? ' (--tz override; detected ' + (detected || 'none') + ')' : '') : '(not detected — app falls back to its built-in default)');
}
main();
