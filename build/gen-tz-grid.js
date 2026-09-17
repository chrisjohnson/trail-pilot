#!/usr/bin/env node
/**
 * gen-tz-grid.js — regenerate build/tz-grid.json (the offline coord->IANA-timezone
 * lookup used by gpx2route.js to stamp the start location's timezone).
 *
 * Rarely needed: the committed grid is generated from a released tz-boundary
 * dataset and only needs regenerating when you want newer boundaries.
 *
 * Usage: node build/gen-tz-grid.js            (0.25 deg cells, ~0.8 MB)
 *        TZ_GRID_RES=0.5 node build/gen-tz-grid.js   (coarser, ~0.3 MB)
 *
 * Requires Node 18+ (fetch), npm, and network access. Downloads the geo-tz npm
 * package (timezone-boundary-builder / Natural Earth tz polygons), samples a
 * uniform grid with it, and RLE-encodes the result.
 *
 * Cleanup: the boundary data labels some land cells as Etc/* (notably a blob
 * over the UK, which would lose DST). No real land region uses an IANA Etc/*
 * zone — countries use named zones even when the rules match — so an Etc cell
 * adopts the strictly-dominant named zone among its 8 neighbors, iterated to a
 * fixpoint. As a side effect some ocean cells near coasts absorb the coastal
 * zone; that is irrelevant for trail running (nobody starts a route in the sea)
 * and the pass cap bounds how far it goes.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GEO_TZ_VERSION = process.env.GEO_TZ_VERSION || '8.1.9';
const RES = parseFloat(process.env.TZ_GRID_RES || '0.25'); // degrees per cell

async function main() {
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tzgrid-'));
  try {
    console.log('downloading geo-tz@' + GEO_TZ_VERSION + ' ...');
    const reg = await (await fetch('https://registry.npmjs.org/geo-tz/-/geo-tz-' + GEO_TZ_VERSION + '.tgz')).arrayBuffer();
    const tgz = path.join(dir, 'geo-tz.tgz');
    fs.writeFileSync(tgz, Buffer.from(reg));
    execSync('tar xzf ' + JSON.stringify(tgz) + ' -C ' + JSON.stringify(dir));
    const pkg = path.join(dir, 'package');
    console.log('installing geo-tz runtime deps ...');
    const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).dependencies).join(' ');
    execSync('npm install --no-save --no-audit --no-fund --omit=dev --loglevel=error ' + deps,
      { cwd: pkg, stdio: 'ignore' });
    const { find, preCache } = require(path.join(pkg, 'dist', 'find-all.js'));
    preCache();

    const cols = Math.round(360 / RES), rows = Math.round(180 / RES);
    const zoneIdx = new Map(); // tzid -> code
    const grid = new Int32Array(rows * cols).fill(-1);
    const t1 = Date.now();
    for (let r = 0; r < rows; r++) {
      const lat = 90 - (r + 0.5) * RES;
      for (let c = 0; c < cols; c++) {
        const lon = -180 + (c + 0.5) * RES;
        const hits = find(lat, lon);
        if (hits.length > 0) {
          let code = zoneIdx.get(hits[0]);
          if (code === undefined) { code = zoneIdx.size; zoneIdx.set(hits[0], code); }
          grid[r * cols + c] = code;
        }
      }
    }
    console.log('sampled ' + (rows * cols).toLocaleString() + ' cells in ' + ((Date.now() - t1) / 1000).toFixed(1) + 's, ' + zoneIdx.size + ' zones');

    const zoneIdx2id = new Map();
    for (const [id, code] of zoneIdx) zoneIdx2id.set(code, id); // code -> id
    const isEtc = (code) => code >= 0 && (zoneIdx2id.get(code) || '').startsWith('Etc/');

    const cleaned = new Int32Array(grid);
    let passes = 0;
    for (; passes < 200; passes++) {
      let changed = false;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const code = cleaned[idx];
          if (code < 0 || !isEtc(code)) continue;
          const counts = new Map();
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            const ncode = cleaned[nr * cols + nc];
            if (ncode >= 0 && !isEtc(ncode)) counts.set(ncode, (counts.get(ncode) || 0) + 1);
          }
          if (counts.size === 0) continue;
          let best = null, bestN = 0, tie = false;
          for (const [z, n] of counts) {
            if (n > bestN) { best = z; bestN = n; tie = false; }
            else if (n === bestN) tie = true;
          }
          if (best !== null && !tie) { cleaned[idx] = best; changed = true; }
        }
      }
      if (!changed) break;
    }
    console.log('cleanup: ' + passes + ' pass(es)');

    const zones = [...zoneIdx.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    // RLE-encode each row: [startCol, code, len], code -1 = ocean
    const rowsOut = [];
    for (let r = 0; r < rows; r++) {
      const runs = [];
      let c = 0;
      while (c < cols) {
        const code = cleaned[r * cols + c];
        let len = 1;
        while (c + len < cols && cleaned[r * cols + c + len] === code) len++;
        runs.push([c, code, len]);
        c += len;
      }
      rowsOut.push(runs);
    }
    const out = {
      res: RES,
      source: 'geo-tz ' + GEO_TZ_VERSION + ' (timezone-boundary-builder); Etc/* cells resolved to dominant neighboring zone',
      generated: new Date().toISOString().slice(0, 10),
      zones,
      rows: rowsOut,
    };
    const outPath = path.join(__dirname, 'tz-grid.json');
    fs.writeFileSync(outPath, JSON.stringify(out));
    console.log('wrote ' + outPath + ' (' + (fs.statSync(outPath).size / 1024).toFixed(0) + ' KB)');

    const check = (lat, lon) => {
      const r = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / RES)));
      const c = Math.min(cols - 1, Math.max(0, Math.floor((lon + 180) / RES)));
      const code = cleaned[r * cols + c];
      return code < 0 ? null : zones[code];
    };
    const expect = [
      [37.283107, -83.515801, 'America/New_York'],
      [39.7392, -104.9903, 'America/Denver'],
      [51.5074, -0.1278, 'Europe/London'],
      [59.3293, -0.3276, 'Europe/London'],
      [53.3498, -6.2603, 'Europe/Dublin'],
      [40.4168, -3.7038, 'Europe/Madrid'],
      [52.52, 13.405, 'Europe/Berlin'],
      [35.6762, 139.6503, 'Asia/Tokyo'],
      [-33.8688, 151.2093, 'Australia/Sydney'],
      [47.22, -107.92, 'America/Denver'],
    ];
    let fail = 0;
    for (const [lat, lon, exp] of expect) {
      const got = check(lat, lon);
      const ok = got === exp;
      if (!ok) fail++;
      console.log((ok ? 'ok  ' : 'FAIL') + ' ' + lat + ',' + lon + ' -> ' + got);
    }
    if (fail) process.exitCode = 1;
    console.log('done in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
