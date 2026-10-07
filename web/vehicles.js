/* =============================================================================
   trail-pilot — the convoy, as real 3D vehicles.

   Emits glTF 2.0 (a tiny writer + parametric body work) and hands back a blob:
   URL per vehicle kind, so the app still ships zero binary assets and the whole
   model is reviewable text.

   Authoring frame (glTF's own):  +Y up, −Z forward (the nose points at −Z),
   +X to the vehicle's right. Cesium maps that onto the local ENU frame
   unchanged, so with identity heading the nose faces north and y = 0 is the
   ground plane — every vehicle is authored with its wheels resting exactly on
   y = 0, and Cesium.Transforms.headingPitchRollQuaternion(pos,
   HeadingPitchRoll(heading, 0, 0)) then aims it down the trail.

   Geometry comes from three solids only — box, cylinder and tube (a swept
   circle along a segment), plus flat ground shadow — with one glTF primitive
   per material. Two rules keep these readable from 20 m or 2 km away: nothing is
   see-through (glazing is inset into a painted shell, so there are no gaps to
   look through), and the silhouette does the work — tube flares, roof rack,
   snorkel, sports bar, spare tyre.
   ========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------- mat helpers
  // glTF baseColorFactor is LINEAR; the palette below is authored in sRGB hex
  // like the rest of the app, so convert on the way in. `ambient` adds a
  // fraction of the base colour back as emissive: the viewer lights these with
  // a single directional source, and without it the side facing away from the
  // light goes pure black and the vehicle loses its shape.
  function srgb(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function hex(h) {
    const n = parseInt(h.replace('#', ''), 16);
    return [srgb(((n >> 16) & 255) / 255), srgb(((n >> 8) & 255) / 255), srgb((n & 255) / 255), 1];
  }

  const MAT = {
    tire:     { base: '#101215', rough: 0.72, metal: 0.0, ambient: 0.35 },
    rubber:   { base: '#1a1d22', rough: 0.85, metal: 0.0, ambient: 0.45 },
    black:    { base: '#15181d', rough: 0.55, metal: 0.1, ambient: 0.4 },
    charcoal: { base: '#2b3038', rough: 0.6,  metal: 0.1, ambient: 0.4 },
    steel:    { base: '#9aa3ad', rough: 0.35, metal: 0.85, ambient: 0.18 }, // tube flares, rack, bar
    chrome:   { base: '#cfd6de', rough: 0.18, metal: 0.95, ambient: 0.16 }, // grille bars
    glass:    { base: '#22414f', rough: 0.34, metal: 0.0, ambient: 0.55 },  // dark, glossy, not a void
    head:     { base: '#fff3cf', rough: 0.2,  metal: 0.0, emissive: '#ffca54' },
    tail:     { base: '#ff5140', rough: 0.35, metal: 0.0, emissive: '#d41b00' },
    bedliner: { base: '#1c2027', rough: 0.95, metal: 0.0, ambient: 0.5 },
    shadow:   { base: '#000000', rough: 1.0,  metal: 0.0, alpha: 0.16 },
    shadow2:  { base: '#000000', rough: 1.0,  metal: 0.0, alpha: 0.2 },
    // per-vehicle paint:
    paint:    { base: '#d0312d', rough: 0.3,  metal: 0.0, ambient: 0.1 },
    paintHi:  { base: '#e8473f', rough: 0.28, metal: 0.0, ambient: 0.1 },
    paintLo:  { base: '#8f201d', rough: 0.45, metal: 0.0, ambient: 0.1 },
  };

  // ------------------------------------------------------------------- vec math
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
  const rad = (d) => d * Math.PI / 180;
  function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }
  function rot(r) {
    if (!r) return null;
    const cx = Math.cos(r.x || 0), sx = Math.sin(r.x || 0);
    const cy = Math.cos(r.y || 0), sy = Math.sin(r.y || 0);
    const cz = Math.cos(r.z || 0), sz = Math.sin(r.z || 0);
    return [ // Rx · Ry · Rz
      [cy*cz, -cy*sz, sy],
      [sx*sy*cz + cx*sz, -sx*sy*sz + cx*cz, -sx*cy],
      [-cx*sy*cz + sx*sz, cx*sy*sz + sx*cz, cx*cy],
    ];
  }
  const mul = (M, v) => M ? [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
  ] : v;

  // ------------------------------------------------------------------- geometry
  function Geo() { this.pris = new Map(); }
  function grp(g, mat) {
    let p = g.pris.get(mat);
    if (!p) { p = { pos: [], nrm: [], idx: [] }; g.pris.set(mat, p); }
    return p;
  }
  function quad(g, mat, a, b, c, d, n) {
    const p = grp(g, mat), k = p.pos.length / 3;
    p.pos.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2], a[0],a[1],a[2], c[0],c[1],c[2], d[0],d[1],d[2]);
    for (let i = 0; i < 6; i++) p.nrm.push(n[0], n[1], n[2]);
    p.idx.push(k,k+1,k+2, k,k+2,k+3);
  }
  // Oriented box at centre c, half-extents h, optional rotation in radians.
  function box(g, mat, c, h, r) {
    const M = rot(r);
    const P = (sx, sy, sz) => mul(M, [sx*h[0], sy*h[1], sz*h[2]]).map((v, i) => v + c[i]);
    const N = (a) => mul(M, a);
    // six faces; normals are authored, and every material is doubleSided, so a
    // winding slip can never open a hole in the silhouette
    quad(g, mat, P( 1, 1, 1), P( 1,-1, 1), P( 1,-1,-1), P( 1, 1,-1), N([ 1, 0, 0]));
    quad(g, mat, P(-1, 1,-1), P(-1,-1,-1), P(-1,-1, 1), P(-1, 1, 1), N([-1, 0, 0]));
    quad(g, mat, P(-1, 1, 1), P(-1,-1, 1), P( 1,-1, 1), P( 1, 1, 1), N([ 0, 1, 0]));
    quad(g, mat, P(-1,-1,-1), P(-1, 1,-1), P( 1, 1,-1), P( 1,-1,-1), N([ 0,-1, 0]));
    quad(g, mat, P(-1, 1,-1), P(-1, 1, 1), P( 1, 1, 1), P( 1, 1,-1), N([ 0, 0, 1]));
    quad(g, mat, P( 1,-1,-1), P( 1,-1, 1), P(-1,-1, 1), P(-1,-1,-1), N([ 0, 0,-1]));
  }
  // Cylinder with caps, centred at c, along a unit axis.
  function cyl(g, mat, c, a, r, len, seg) {
    seg = seg || 20;
    const a1 = norm(a), ref = Math.abs(a1[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(a1, ref)), v = cross(a1, u), h = len / 2, P = [], ringN = [];
    for (let i = 0; i < seg; i++) {
      const t = i / seg * Math.PI * 2, cs = Math.cos(t), sn = Math.sin(t);
      const n = [u[0]*cs + v[0]*sn, u[1]*cs + v[1]*sn, u[2]*cs + v[2]*sn];
      ringN.push(n);
      P.push([c[0] + a1[0]*h + n[0]*r, c[1] + a1[1]*h + n[1]*r, c[2] + a1[2]*h + n[2]*r],
             [c[0] - a1[0]*h + n[0]*r, c[1] - a1[1]*h + n[1]*r, c[2] - a1[2]*h + n[2]*r]);
    }
    const hi = [c[0] + a1[0]*h, c[1] + a1[1]*h, c[2] + a1[2]*h];
    const lo = [c[0] - a1[0]*h, c[1] - a1[1]*h, c[2] - a1[2]*h];
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg, n = ringN[i];
      quad(g, mat, P[i*2], P[j*2], P[j*2+1], P[i*2+1], n);
      quad(g, mat, hi, P[j*2], P[i*2], P[i*2], a1);
      quad(g, mat, lo, P[i*2+1], P[j*2+1], P[j*2+1], [-a1[0], -a1[1], -a1[2]]);
    }
  }
  // Swept circle along a segment (chain these for arcs).
  function tube(g, mat, p0, p1, r, seg) {
    const d = sub(p1, p0);
    cyl(g, mat, [(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2], d, r,
        Math.hypot(d[0], d[1], d[2]) + r * 0.7, seg || 6);
  }
  function tubePath(g, mat, pts, r, seg) {
    for (let i = 0; i + 1 < pts.length; i++) tube(g, mat, pts[i], pts[i + 1], r, seg);
  }
  // Wheel: tyre, a proud rim disc, a dark hub. Axis runs along X.
  function wheel(g, x, z, r, w, opts) {
    opts = opts || {};
    cyl(g, 'tire', [x, r, z], [1, 0, 0], r, w, 22);
    const out = x + Math.sign(x || 1) * (w / 2 + 0.01);
    cyl(g, opts.rim || 'steel', [out, r, z], [1, 0, 0], r * (opts.rimR || 0.5), 0.028, 18);
    cyl(g, 'charcoal', [out + Math.sign(x || 1) * 0.016, r, z], [1, 0, 0], r * 0.18, 0.03, 12);
  }
  // Metal tube flare over a wheel: an arc in the wheel plane (the axle is X, so
  // the wheel circle lives in Y–Z). The signature off-roader tell.
  function flare(g, x, z, r, opts) {
    opts = opts || {};
    const rr = r + (opts.gap || 0.09);
    const r0 = rad(opts.a0 !== undefined ? opts.a0 : 122), r1 = rad(opts.a1 !== undefined ? opts.a1 : -32);
    const n = 15, pts = [];
    for (let i = 0; i < n; i++) {
      const a = r0 + (r1 - r0) * i / (n - 1);
      pts.push([x, r + rr * Math.cos(a), z + rr * Math.sin(a)]);
    }
    tubePath(g, opts.mat || 'steel', pts, opts.r || 0.028, 8);
  }
  // Glazed panel in a frame: one slab of frame material, one slightly smaller
  // slab of glass proud of it. Shared centre + rotation, so they cannot drift.
  function panel(g, mat, frameMat, c, h, r, inset) {
    box(g, frameMat, c, [h[0], h[1], h[2] + 0.004], r);
    box(g, mat, c, [h[0] - (inset || 0.05), h[1] - (inset || 0.05), h[2] + 0.012], r);
  }
  // A run of side glass set into a painted shell: `panels` are [zc, len], and
  // the shell showing through between them reads as B/C pillars.
  function sideGlass(g, shellHalf, yMid, yHalf, panels) {
    panels.forEach(([zc, len]) => [-1, 1].forEach((s) =>
      box(g, 'glass', [s * (shellHalf + 0.008), yMid, zc], [0.012, yHalf, len / 2 - 0.015])));
  }
  // Contact shadow: two nested ellipses just above y=0, baked into the model so
  // they turn with the vehicle — sells "tires on the ground" from any angle.
  // The key light travels with the camera, so the shadow gets
  // no offset of its own — it is an ambient-occlusion pool under the vehicle.
  // Nested ellipses, not a quad: a rectangle seen edge-on from a low camera
  // projects past the body silhouette and reads as a sheet of plywood, while a
  // soft-edged ellipse just reads as shading.
  function shadowAt(g, zc, halfLen, halfWid) {
    const N = 18;
    const ring = (y, hl, hw, mat) => {
      const p = grp(g, mat), c = p.pos.length / 3;
      p.pos.push(0, y, zc); p.nrm.push(0, 1, 0);
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        p.pos.push(Math.sin(a) * hw, y, zc + Math.cos(a) * hl);
        p.nrm.push(0, 1, 0);
        if (i) p.idx.push(c, c + i, c + i + 1);
      }
    };
    ring(0.008, halfLen * 1.02, halfWid * 0.95, 'shadow');
    ring(0.016, halfLen * 0.68, halfWid * 0.7, 'shadow2');
  }

  // ===================================================================== JEEP
  // Red JK-spec 4-door on 37s: slotted flat grille, round headlights, windscreen
  // in an external frame, body-colour top with a rack, tube flares, snorkel up
  // the passenger A-pillar, spare on the tailgate.
  function buildJeep(g) {
    const R = 0.5, W = 0.34, X = 0.86, ZF = -1.32, ZR = 1.52; // 2.84 m wheelbase
    const NOSE = -2.12, TAIL = 2.14, HW = 0.84;
    const BELT = 1.28, TOP = 1.78, GH = 0.79;                 // beltline, roof, greenhouse half-width
    [[X, ZF], [-X, ZF], [X, ZR], [-X, ZR]].forEach(([x, z]) => wheel(g, x, z, R, W));
    [[X, ZF], [-X, ZF], [X, ZR], [-X, ZR]].forEach(([x, z]) => flare(g, x + Math.sign(x) * 0.05, z, R));
    // chassis, tub, hood
    box(g, 'black',   [0, 0.5, 0.05], [0.62, 0.1, 1.62]);               // frame + skid
    box(g, 'paint',   [0, 0.92, 0.55], [HW, 0.36, 1.5]);                // passenger cell tub
    box(g, 'paintLo', [0, 0.66, 0.4], [HW + 0.014, 0.08, 1.62]);        // rockers, proud
    // front clip: bonnet line below the beltline, fenders over the wheels
    box(g, 'paint', [0, 1.12, -1.5], [0.72, 0.09, 0.56]);               // hood
    box(g, 'black', [0, 1.2, -1.4], [0.23, 0.04, 0.26]);                // hood scoop
    [-1, 1].forEach((s) => box(g, 'paint', [s * 0.79, 0.85, -1.36], [0.11, 0.24, 0.66]));
    // nose: slotted grille, round lights, bumper. Each detail sits a couple of
    // centimetres clear of the plate behind it — coplanar faces z-fight at
    // viewing range and read as noise.
    box(g, 'paint',  [0, 1.0, NOSE + 0.04], [0.79, 0.3, 0.05]);         // grille surround
    box(g, 'black',  [0, 1.02, NOSE + 0.005], [0.74, 0.28, 0.04]);
    for (let i = -3; i <= 3; i++) box(g, 'chrome', [i * 0.19, 1.02, NOSE - 0.035], [0.022, 0.19, 0.012]);
    cyl(g, 'head', [-0.62, 1.06, NOSE - 0.02], [0, 0, -1], 0.12, 0.05, 16);
    cyl(g, 'head', [0.62, 1.06, NOSE - 0.02], [0, 0, -1], 0.12, 0.05, 16);
    box(g, 'charcoal', [0, 0.6, NOSE - 0.05], [0.86, 0.13, 0.09]);
    box(g, 'steel', [0, 0.6, NOSE - 0.12], [0.5, 0.09, 0.03]);
    // greenhouse: painted shell (never see-through) + glazed sides + roof
    box(g, 'paint', [0, (BELT + TOP) / 2, 0.44], [GH, (TOP - BELT) / 2, 1.6]);
    sideGlass(g, GH, 1.5, 0.19, [[-0.62, 0.62], [0.14, 0.66], [0.88, 0.52]]);
    box(g, 'paint', [0, TOP + 0.03, 0.44], [GH + 0.01, 0.035, 1.6]);
    // windscreen and tail glass, framed
    panel(g, 'glass', 'black', [0, 1.53, -1.21], [0.73, 0.3, 0.03], { x: rad(22) }, 0.06);
    panel(g, 'glass', 'paint', [0, 1.5, 2.07], [0.6, 0.21, 0.03], { x: rad(4) }, 0.06);
    // rack
    [-1, 1].forEach((s) => box(g, 'steel', [s * 0.62, TOP + 0.1, 0.44], [0.026, 0.022, 1.32]));
    [-0.4, 0.44, 1.28].forEach((z) => box(g, 'steel', [0, TOP + 0.1, z], [0.62, 0.02, 0.035]));
    // snorkel up the passenger A-pillar
    tubePath(g, 'rubber', [[0.8, 1.0, -1.3], [0.83, 1.5, -1.14], [0.82, 1.74, -1.3], [0.82, 1.76, -1.56]], 0.048, 8);
    // mirrors, doors
    [-1, 1].forEach((s) => {
      box(g, 'black', [s * 0.97, 1.32, -0.98], [0.05, 0.09, 0.12]);
      tube(g, 'black', [s * 0.86, 1.3, -0.94], [s * 0.95, 1.31, -0.98], 0.02, 6);
    });
    [-0.2, 0.62].forEach((z) => [-1, 1].forEach((s) => box(g, 'paintLo', [s * (HW + 0.016), 0.95, z], [0.008, 0.28, 0.012])));
    [-0.36, 0.46].forEach((z) => [-1, 1].forEach((s) => box(g, 'chrome', [s * (HW + 0.02), 1.2, z], [0.013, 0.026, 0.07])));
    // tail: tailgate, spare, lights, bumper
    box(g, 'paint', [0, 1.0, TAIL], [HW, 0.24, 0.05]);
    cyl(g, 'tire', [0, 1.06, TAIL + 0.15], [0, 0, 1], 0.46, 0.2, 22);
    cyl(g, 'chrome', [0, 1.06, TAIL + 0.26], [0, 0, 1], 0.24, 0.03, 18);
    [-0.66, 0.66].forEach((x) => box(g, 'tail', [x, 0.96, TAIL + 0.01], [0.09, 0.07, 0.02]));
    box(g, 'charcoal', [0, 0.6, TAIL + 0.04], [0.86, 0.12, 0.08]);
    cyl(g, 'steel', [-0.54, 0.5, TAIL + 0.1], [0, 0, 1], 0.035, 0.14, 8);
    shadowAt(g, 0.02, 2.26, 1.02);
    return { front: -NOSE, back: TAIL, halfW: X + W / 2 + 0.1, height: TOP + 0.14 };
  }

  // ==================================================================== TACOMA
  // Blue pickup: long nose, crew cab, and an OPEN bed with a dark tub floor and
  // a sports bar — the pickup tell from every angle.
  function buildTaco(g) {
    const R = 0.44, W = 0.3, X = 0.82, ZF = -1.42, ZR = 1.5;
    const NOSE = -2.36, TAIL = 2.56, HW = 0.86;
    const BELT = 1.3, TOP = 1.84, GH = 0.8;
    [[X, ZF], [-X, ZF], [X, ZR], [-X, ZR]].forEach(([x, z]) => wheel(g, x, z, R, W, { rimR: 0.54 }));
    // frame, front body, rockers, hood
    box(g, 'black',   [0, 0.52, 0.05], [0.6, 0.1, 1.9]);
    box(g, 'paint',   [0, 0.95, -1.05], [HW, 0.35, 1.31]);
    box(g, 'paintLo', [0, 0.68, -0.15], [HW + 0.014, 0.08, 1.8]);   // rockers, proud
    box(g, 'paint',   [0, 1.25, -1.75], [0.8, 0.07, 0.66]);
    // nose
    box(g, 'charcoal', [0, 1.06, NOSE + 0.02], [0.79, 0.26, 0.04]);
    box(g, 'chrome', [0, 1.16, NOSE - 0.03], [0.6, 0.09, 0.02]);
    [-1, 1].forEach((s) => box(g, 'head', [s * 0.64, 1.1, NOSE - 0.03], [0.15, 0.1, 0.02]));
    box(g, 'charcoal', [0, 0.66, NOSE - 0.05], [0.88, 0.14, 0.09]);
    box(g, 'steel', [0, 0.66, NOSE - 0.11], [0.36, 0.07, 0.03]);
    // crew cab: painted shell, glazed sides, roof, windscreen, rear glass
    box(g, 'paint', [0, (BELT + TOP) / 2, -0.86], [GH, (TOP - BELT) / 2, 0.62]);
    sideGlass(g, GH, 1.56, 0.19, [[-1.14, 0.52], [-0.5, 0.5]]);
    box(g, 'paint', [0, TOP + 0.03, -0.86], [GH + 0.01, 0.035, 0.62]);
    panel(g, 'glass', 'paint', [0, 1.56, -1.53], [0.7, 0.28, 0.03], { x: rad(20) }, 0.06);
    panel(g, 'glass', 'paint', [0, 1.56, -0.19], [0.62, 0.24, 0.03], { x: rad(-6) }, 0.06);
    // doors, mirrors
    [-1.4, -0.72].forEach((z) => [-1, 1].forEach((s) => box(g, 'paintLo', [s * (HW + 0.006), 1.02, z], [0.008, 0.28, 0.012])));
    [-1.16, -0.5].forEach((z) => [-1, 1].forEach((s) => box(g, 'steel', [s * (HW + 0.016), 1.22, z], [0.013, 0.026, 0.07])));
    [-1, 1].forEach((s) => {
      box(g, 'black', [s * 0.98, 1.36, -1.06], [0.05, 0.1, 0.13]);
      tube(g, 'black', [s * 0.86, 1.34, -1.0], [s * 0.95, 1.35, -1.04], 0.02, 6);
    });
    // the open bed: walls, tailgate, dark tub, sports bar
    const BED_Z = 1.3, BED_LEN = 2.3, BED_BOT = 0.86, BED_TOP = 1.26;
    [-1, 1].forEach((s) => box(g, 'paint', [s * (HW - 0.03), (BED_BOT + BED_TOP) / 2, BED_Z], [0.055, (BED_TOP - BED_BOT) / 2, BED_LEN / 2]));
    box(g, 'paint', [0, (BED_BOT + BED_TOP) / 2, TAIL - 0.03], [HW - 0.04, (BED_TOP - BED_BOT) / 2, 0.045]);
    box(g, 'bedliner', [0, BED_BOT + 0.02, BED_Z], [HW - 0.08, 0.03, BED_LEN / 2 - 0.05]);
    box(g, 'bedliner', [0, BED_BOT + 0.18, BED_Z - BED_LEN / 2 + 0.02], [HW - 0.08, 0.18, 0.02]);
    [-1, 1].forEach((s) => box(g, 'tail', [s * (HW - 0.08), 1.16, TAIL], [0.08, 0.14, 0.02]));
    box(g, 'charcoal', [0, 0.64, TAIL + 0.05], [0.88, 0.12, 0.08]);
    tubePath(g, 'steel', [[-0.7, 0.92, 0.36], [-0.7, 1.5, 0.36], [0.7, 1.5, 0.36], [0.7, 0.92, 0.36]], 0.038, 8);
    // tow hitch under the tailgate
    box(g, 'black', [0, 0.5, TAIL - 0.02], [0.09, 0.06, 0.12]);
    cyl(g, 'steel', [0, 0.52, TAIL + 0.08], [0, 1, 0], 0.035, 0.08, 8);
    shadowAt(g, 0.1, 2.6, 1.0);
    return { front: -NOSE, back: TAIL, halfW: X + W / 2 + 0.1, height: TOP + 0.1 };
  }

  // ================================================================== FORESTER
  // Teal early-2000s wagon: short nose, tall glasshouse, black cladding, roof
  // rails, hood scoop, wipers, hatch lights at the corners.
  function buildForester(g) {
    const R = 0.37, W = 0.26, X = 0.76, ZF = -1.18, ZR = 1.14;
    const NOSE = -2.02, TAIL = 2.06, HW = 0.82;
    const BELT = 1.14, TOP = 1.6, GH = 0.76;
    [[X, ZF], [-X, ZF], [X, ZR], [-X, ZR]].forEach(([x, z]) => wheel(g, x, z, R, W, { rimR: 0.58 }));
    // body: paint over black cladding
    box(g, 'black', [0, 0.5, 0.02], [HW + 0.012, 0.13, 1.84]);   // cladding, proud of the body
    box(g, 'paint', [0, 0.85, 0.3], [HW, 0.28, 1.66]);                  // cabin + rear
    box(g, 'paint', [0, 0.98, -1.62], [0.74, 0.09, 0.44]);              // bonnet deck
    [-1, 1].forEach((s) => box(g, 'paint', [s * 0.75, 0.8, -1.6], [0.1, 0.2, 0.46]));
    box(g, 'black', [0, 1.13, -1.3], [0.17, 0.04, 0.2]);    // hood scoop
    // nose
    box(g, 'black', [0, 0.9, NOSE + 0.02], [0.44, 0.14, 0.03]);
    box(g, 'chrome', [0, 0.9, NOSE - 0.025], [0.3, 0.05, 0.02]);
    [-1, 1].forEach((s) => box(g, 'head', [s * 0.6, 0.96, NOSE - 0.025], [0.17, 0.08, 0.02]));
    [-1, 1].forEach((s) => box(g, 'head', [s * 0.62, 0.66, NOSE - 0.025], [0.07, 0.05, 0.02]));
    box(g, 'charcoal', [0, 0.56, NOSE - 0.04], [0.82, 0.11, 0.07]);
    // glasshouse: shell, glazed sides, windscreen, hatch glass
    box(g, 'paint', [0, (BELT + TOP) / 2, 0.4], [GH, (TOP - BELT) / 2, 1.46]);
    sideGlass(g, GH, 1.35, 0.17, [[-0.6, 0.52], [0.02, 0.6], [0.68, 0.5]]);
    box(g, 'paint', [0, TOP + 0.03, 0.4], [GH + 0.01, 0.03, 1.46]);
    panel(g, 'glass', 'paint', [0, 1.38, -1.09], [0.68, 0.27, 0.03], { x: rad(28) }, 0.055);
    panel(g, 'glass', 'paint', [0, 1.36, 1.9], [0.6, 0.26, 0.03], { x: rad(-16) }, 0.055);
    // wipers
    [-1, 1].forEach((s) => box(g, 'black', [s * 0.26, 1.2, -1.2], [0.018, 0.018, 0.34], { x: rad(-18), z: rad(12) }));
    // roof rails + crossbars
    [-1, 1].forEach((s) => tube(g, 'steel', [s * 0.58, 1.65, -0.7], [s * 0.58, 1.65, 1.35], 0.022, 6));
    [-0.42, 1.0].forEach((z) => [-1, 1].forEach((s) => tube(g, 'steel', [s * 0.58, 1.63, z], [s * 0.5, 1.68, z], 0.02, 6)));
    // doors, mirrors
    [-0.24, 0.6].forEach((z) => [-1, 1].forEach((s) => box(g, 'paintLo', [s * (HW + 0.005), 0.9, z], [0.008, 0.24, 0.012])));
    [-0.4, 0.44].forEach((z) => [-1, 1].forEach((s) => box(g, 'steel', [s * (HW + 0.014), 1.06, z], [0.012, 0.024, 0.07])));
    [-1, 1].forEach((s) => {
      box(g, 'black', [s * 0.92, 1.2, -0.86], [0.04, 0.08, 0.11]);
      tube(g, 'black', [s * 0.82, 1.18, -0.8], [s * 0.9, 1.19, -0.84], 0.018, 6);
    });
    // tail
    box(g, 'paint', [0, 1.0, TAIL - 0.02], [HW - 0.02, 0.28, 0.05]);
    [-1, 1].forEach((s) => box(g, 'tail', [s * 0.64, 1.14, TAIL], [0.1, 0.16, 0.02]));
    box(g, 'charcoal', [0, 0.54, TAIL + 0.03], [0.82, 0.1, 0.07]);
    cyl(g, 'steel', [0.5, 0.46, TAIL + 0.05], [0, 0, 1], 0.03, 0.1, 8);
    shadowAt(g, 0.02, 2.1, 0.94);
    return { front: -NOSE, back: TAIL, halfW: X + W / 2 + 0.08, height: TOP + 0.12 };
  }

  // ============================================================ glTF assembly
  const PAINT = {
    jeep:     { paint: '#d0312d', paintHi: '#e8473f', paintLo: '#8f201d' },
    taco:     { paint: '#2456d6', paintHi: '#3f74f0', paintLo: '#17399b' },
    forester: { paint: '#1f8f85', paintHi: '#2ba396', paintLo: '#0d4f49' },
  };
  const BUILDERS = { jeep: buildJeep, taco: buildTaco, forester: buildForester };
  const DIMS = {};
  const cache = new Map();

  // Cesium reads a Y-up glTF into its own Z-up scene frame with the axis
  // permutation (x,y,z) -> (z,x,y). Authored here with the nose at -Z, that
  // leaves the vehicle pointing 90 deg counter-clockwise from its heading —
  // measured, not guessed: the nose marker landed at 228 deg for a heading of
  // 322 deg. Pre-rotating the geometry by the inverse (x,y,z) -> (-z,y,x)
  // puts the nose on the frame Cesium treats as "along the heading", so
  // headingPitchRollQuaternion(pos, HeadingPitchRoll(h,0,0)) aims it down the
  // trail for real. Up is untouched, and the ground plane is still y = 0.
  function reorient(g) {
    g.pris.forEach((prim) => {
      for (const arr of [prim.pos, prim.nrm]) {
        for (let i = 0; i < arr.length; i += 3) {
          const x = arr[i], z = arr[i + 2];
          arr[i] = -z; arr[i + 2] = x;
        }
      }
    });
  }

  function maxOf(a) { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
  function gltfJson(g, kind) {
    const chunks = [], views = [], accessors = [], primitives = [];
    let byteLength = 0;
    const pad = () => { const r = byteLength % 4; if (r) { chunks.push(new Uint8Array(4 - r)); byteLength += 4 - r; } };
    function view(typedArray, target) {
      pad();
      const buf = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
      chunks.push(buf);
      views.push({ buffer: 0, byteOffset: byteLength, byteLength: buf.byteLength, target });
      byteLength += buf.byteLength;
      return views.length - 1;
    }
    function f32(arr, comps) {
      const f = new Float32Array(arr), min = [], max = [];
      for (let c = 0; c < comps; c++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = c; i < f.length; i += comps) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
        min.push(lo); max.push(hi);
      }
      accessors.push({ bufferView: view(f, 34962), componentType: 5126, count: f.length / comps, type: 'VEC3', min, max });
      return accessors.length - 1;
    }
    const names = Object.keys(MAT);
    const materials = names.map((name) => {
      const m = MAT[name], paint = PAINT[kind] || {};
      const base = paint[name] ? hex(paint[name]) : hex(m.base);
      const out = { name, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: base } };
      out.pbrMetallicRoughness.metallicFactor = m.metal || 0;
      out.pbrMetallicRoughness.roughnessFactor = m.rough === undefined ? 1 : m.rough;
      const em = [0, 0, 0];
      if (m.ambient) { em[0] += base[0] * m.ambient; em[1] += base[1] * m.ambient; em[2] += base[2] * m.ambient; }
      if (m.emissive) { const e = hex(m.emissive); em[0] += e[0]; em[1] += e[1]; em[2] += e[2]; }
      if (em[0] || em[1] || em[2]) out.emissiveFactor = em.map((v) => Math.min(1, v));
      if (m.alpha !== undefined) { out.pbrMetallicRoughness.baseColorFactor = [0, 0, 0, m.alpha]; out.alphaMode = 'BLEND'; }
      return out;
    });
    g.pris.forEach((prim, name) => {
      if (!prim.pos.length) return;
      // NB: capture the index accessor now. Written as `indices: accessors.length - 1`
      // inside the literal below, it would evaluate AFTER the two attribute
      // accessors were pushed and silently point at the normals instead.
      pad();
      const u = new Uint32Array(prim.idx), vIdx = view(u, 34963);
      accessors.push({ bufferView: vIdx, componentType: 5125, count: u.length, type: 'SCALAR',
                       min: 0, max: prim.idx.length ? maxOf(prim.idx) : 0 });
      const indices = accessors.length - 1;
      primitives.push({
        attributes: { POSITION: f32(prim.pos, 3), NORMAL: f32(prim.nrm, 3) },
        material: names.indexOf(name), mode: 4, indices: indices,
      });
    });
    const all = new Uint8Array(byteLength);
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < all.length; i += CH) bin += String.fromCharCode.apply(null, all.subarray(i, i + CH));
    return JSON.stringify({
      asset: { version: '2.0', generator: 'trail-pilot vehicles.js' },
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: kind, mesh: 0 }],
      meshes: [{ name: kind, primitives }], materials, accessors,
      bufferViews: views,
      buffers: [{ byteLength, uri: 'data:application/octet-stream;base64,' + btoa(bin) }],
    });
  }

  function uri(kind) {
    if (!BUILDERS[kind]) kind = 'jeep';
    if (cache.has(kind)) return cache.get(kind);
    const g = new Geo();
    DIMS[kind] = BUILDERS[kind](g);
    reorient(g);
    const json = gltfJson(g, kind);
    // A blob: URL keeps a real content-type on the response, which is how
    // Cesium decides the payload is glTF-json rather than a binary glb.
    const url = URL.createObjectURL(new Blob([json], { type: 'model/gltf+json' }));
    cache.set(kind, url);
    return url;
  }

  window.TrailPilotVehicles = {
    uri,
    dims: (kind) => DIMS[kind] || { front: 2.3, back: 2.3, halfW: 1.0, height: 1.9 },
    kinds: Object.keys(BUILDERS),
  };
})();
