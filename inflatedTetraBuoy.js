/**
 * Inflated tetrahedral race buoy: geometry only, no renderer dependency.
 *
 * Shape model (what makes it read as an inflated PVC buoy rather than a block):
 *   1. Four triangular panels (3 sides + base), each its OWN vertex grid, so the
 *      welded seams stay crisp while every panel shades smoothly.
 *   2. Each panel puffs outward along its own flat-face normal. The puff is 0 on
 *      the seams and maximal at the panel centre:  g = 27·a·b·c  (barycentric
 *      bubble, 1 at centroid, 0 on every edge), shaped by  f = 1 - (1-g)^fullness
 *      so the panel looks pumped hard (flat-ish crown, steep roll-off at seams).
 *   3. Seams bow slightly INWARD toward the body centre (panel tension pulls
 *      them in). Both panels sharing a seam use the same curve, so no cracks.
 *   4. Optional faint creases fanning out of each corner, where the vinyl bunches.
 *   5. Normals are analytic (finite differences of the surface function), not
 *      flat per-triangle normals.
 *
 * Coordinate system: Y up, base panel at y = 0, apex at (0, height, 0),
 * base centred on the origin. Triangles are wound counter-clockwise seen from
 * outside (three.js / WebGL front faces).
 */

export const BUOY_DEFAULTS = {
  edge: 1.5,        // m: base edge length
  height: null,     // m: apex height; null gives a regular tetrahedron (edge * 0.8165)
  bulge: 0.12,      // side-panel puff at its centre as a fraction of edge (0.09 to 0.14 looks real)
  fullness: 2.5,    // 1 = soft dome, 2 to 3 = pumped-hard panel
  seamSag: 0.02,    // seams bow inward at mid-length, fraction of edge
  baseBulge: 0.05,  // bottom panel puff (mostly underwater)
  wrinkles: 0.0025, // crease depth near corners, fraction of edge; 0 disables
  wrinkleCount: 7,  // creases per corner
  segments: 40,     // grid resolution per panel edge (24 is plenty on mobile)
  includeBase: true,
};

// ---- tiny vec3 helpers (arrays [x, y, z]) ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function buildInflatedTetra(options = {}) {
  const o = { ...BUOY_DEFAULTS, ...options };
  const E = o.edge;
  const H = o.height ?? E * Math.sqrt(2 / 3);
  const n = Math.max(4, Math.round(o.segments));

  // Corners: base triangle in the XZ plane, apex on +Y.
  const R = E / Math.sqrt(3); // circumradius of base triangle
  const B = [90, 210, 330].map((deg) => {
    const t = (deg * Math.PI) / 180;
    return [R * Math.cos(t), 0, R * Math.sin(t)];
  });
  const A = [0, H, 0];
  const C = [0, H / 4, 0]; // body centroid

  // Panels: [p0, p1, p2] with p0->p1 the "bottom" edge for side panels.
  const panels = [
    { kind: 'side', c: [B[0], B[1], A] },
    { kind: 'side', c: [B[1], B[2], A] },
    { kind: 'side', c: [B[2], B[0], A] },
  ];
  if (o.includeBase) panels.push({ kind: 'base', c: [B[0], B[2], B[1]] });

  // Fix winding so every panel faces outward.
  for (const p of panels) {
    const [p0, p1, p2] = p.c;
    let nrm = norm(cross(sub(p1, p0), sub(p2, p0)));
    const centre = scale(add(add(p0, p1), p2), 1 / 3);
    if (dot(nrm, sub(centre, C)) < 0) { p.c = [p0, p2, p1]; nrm = scale(nrm, -1); }
    p.n = nrm;
    // Rotate corners (keeps winding) so a side panel's apex is c[2]: then
    // c[0] -> c[1] is the bottom seam, left to right seen from outside.
    if (p.kind === 'side') while (p.c[2] !== A) p.c = [p.c[2], p.c[0], p.c[1]];
  }

  // Inward sag direction for a seam: from its midpoint toward the body centroid,
  // made perpendicular to the seam. Keyed by corner pair so both panels agree.
  const key = (p, q) => [p, q].map((v) => v.map((x) => x.toFixed(6)).join(',')).sort().join('|');
  const sagDir = new Map();
  const seamDir = (p, q) => {
    const k = key(p, q);
    if (!sagDir.has(k)) {
      const e = norm(sub(q, p));
      const mid = scale(add(p, q), 0.5);
      let d = sub(C, mid);
      d = norm(sub(d, scale(e, dot(d, e))));
      sagDir.set(k, d);
    }
    return sagDir.get(k);
  };

  const sag = o.seamSag * E;

  // Surface point of a panel at barycentric (a, b, c) for corners (p0, p1, p2).
  // Works slightly outside the triangle too, which the normal finite differences need.
  function surface(panel, a, b, c) {
    const [p0, p1, p2] = panel.c;
    // 1) flat point
    let x = add(add(scale(p0, a), scale(p1, b)), scale(p2, c));
    // 2) seam sag: weight 4·(product of the seam's two end barycentrics) is
    //    4s(1-s) along that seam, 0 on the other seams, and fades toward the opposite corner.
    x = add(x, scale(seamDir(p1, p2), sag * 4 * b * c));
    x = add(x, scale(seamDir(p2, p0), sag * 4 * c * a));
    x = add(x, scale(seamDir(p0, p1), sag * 4 * a * b));
    // 3) panel puff along the panel's own normal
    const puff = (panel.kind === 'base' ? o.baseBulge : o.bulge) * E;
    const g = 27 * a * b * c;
    const f = 1 - Math.pow(Math.max(0, 1 - g), o.fullness);
    // 4) corner creases: angular sine around each corner, zero on the seams and at the corner tip
    let w = 0;
    if (o.wrinkles > 0) {
      const lam = [a, b, c];
      for (let i = 0; i < 3; i++) {
        const li = lam[i], lj = lam[(i + 1) % 3], lk = lam[(i + 2) % 3];
        const den = lj + lk;
        if (Math.abs(den) < 1e-9) continue;
        const t = lj / den;
        const r = Math.min(1, Math.max(0, (li - 0.45) / 0.55));
        const env = Math.sin(Math.PI * r) ** 2;
        w += Math.sin(Math.PI * o.wrinkleCount * t) * env;
      }
      w *= o.wrinkles * E;
    }
    return add(x, scale(panel.n, puff * f + w));
  }

  const vertsPerPanel = ((n + 1) * (n + 2)) / 2;
  const trisPerPanel = n * n;
  const P = panels.length;
  const positions = new Float32Array(P * vertsPerPanel * 3);
  const normals = new Float32Array(P * vertsPerPanel * 3);
  const uvs = new Float32Array(P * vertsPerPanel * 2);
  const indices = new Uint32Array(P * trisPerPanel * 3);
  const groups = [];
  const eps = 1e-4;

  let vOff = 0, iOff = 0;
  panels.forEach((panel, pIdx) => {
    const [p0, p1, p2] = panel.c;
    // Planar UV frame on the FLAT panel, so a printed logo stretches with the
    // vinyl exactly like a real printed panel. u: 0..1 across the bottom edge,
    // v: 0 at bottom edge, 1 at the opposite corner.
    const ex = norm(sub(p1, p0));
    const ey = norm(cross(panel.n, ex));
    const mid = scale(add(p0, p1), 0.5);
    const edgeLen = len(sub(p1, p0));
    const slant = dot(sub(p2, mid), ey);

    const idx = (i, j) => vOff + (i * (2 * n + 3 - i)) / 2 + j; // row i has n+1-i verts
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const b = i / n, c = j / n, a = 1 - b - c;
        const pos = surface(panel, a, b, c);
        // analytic-ish normal from central differences in (b, c)
        const db = sub(surface(panel, a - eps, b + eps, c), surface(panel, a + eps, b - eps, c));
        const dc = sub(surface(panel, a - eps, b, c + eps), surface(panel, a + eps, b, c - eps));
        let nr = norm(cross(db, dc));
        if (dot(nr, panel.n) < 0) nr = scale(nr, -1);

        const k = idx(i, j);
        positions.set(pos, k * 3);
        normals.set(nr, k * 3);
        const flat = add(add(scale(p0, a), scale(p1, b)), scale(p2, c));
        const rel = sub(flat, mid);
        uvs[k * 2] = dot(rel, ex) / edgeLen + 0.5;
        uvs[k * 2 + 1] = dot(rel, ey) / slant;
      }
    }
    const start = iOff;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        indices.set([idx(i, j), idx(i + 1, j), idx(i, j + 1)], iOff); iOff += 3;
        if (i + j < n - 1) {
          indices.set([idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)], iOff); iOff += 3;
        }
      }
    }
    groups.push({ start, count: iOff - start, kind: panel.kind, panel: pIdx });
    vOff += vertsPerPanel;
  });

  // Seam polylines (6 edges) for welded-flange tubes.
  const edgePairs = [[B[0], B[1]], [B[1], B[2]], [B[2], B[0]], [B[0], A], [B[1], A], [B[2], A]];
  const seams = edgePairs.map(([p, q]) => {
    const d = seamDir(p, q);
    const pts = [];
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      const flat = add(scale(p, 1 - t), scale(q, t));
      pts.push(add(flat, scale(d, sag * 4 * t * (1 - t))));
    }
    return pts;
  });

  return {
    positions, normals, uvs, indices, groups, seams,
    height: H,
    edge: E,
    slant: Math.hypot(H, E / (2 * Math.sqrt(3))), // side panel: bottom seam to apex
    // Inflatables ride high: about 6 % of the edge under water, plus the base puff.
    suggestedDraft: 0.06 * E + (o.includeBase ? o.baseBulge * E * 0.5 : 0),
  };
}

// Outer radius of the hull at a geometry height and an angle around +Y.
// A point is inside the buoy when its horizontal distance from the axis is
// within this radius. Built from the same triangles that are drawn.
function buildRadiusField(geom) {
  const P = geom.positions;
  const I = geom.indices;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 1; i < P.length; i += 3) {
    yMin = Math.min(yMin, P[i]);
    yMax = Math.max(yMax, P[i]);
  }
  const heights = 64;
  const azimuths = 120;
  const span = yMax - yMin || 1;
  const table = Array.from({ length: heights }, () => new Float32Array(azimuths));
  const yAt = (row) => yMin + span * (row + 0.5) / heights;
  const edgePoint = (y, a, b) => {
    const d = b[1] - a[1];
    if (d === 0) return null;
    const t = (y - a[1]) / d;
    if (t < 0 || t > 1) return null;
    return [a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t];
  };
  const vert = (k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
  // Distance from the axis to where a ray at `az` crosses the segment.
  const rayRadius = (p, q, az) => {
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const rx = Math.cos(az);
    const rz = Math.sin(az);
    const det = rx * dz - rz * dx;
    if (Math.abs(det) < 1e-10) return 0;
    const t = (rz * p[0] - rx * p[1]) / det;
    if (t < -1e-4 || t > 1 + 1e-4) return 0;
    const s = (dz * p[0] - dx * p[1]) / det;
    return s > 0 ? s : 0;
  };
  for (let i = 0; i < P.length; i += 3) {
    const row = Math.max(0, Math.min(heights - 1, Math.round(((P[i + 1] - yMin) / span) * heights - 0.5)));
    const az = Math.atan2(P[i + 2], P[i]);
    const col = Math.round(((az + Math.PI) / (Math.PI * 2)) * azimuths) % azimuths;
    const r = Math.hypot(P[i], P[i + 2]);
    if (r > table[row][col]) table[row][col] = r;
  }
  for (let t = 0; t < I.length; t += 3) {
    const A = vert(I[t]);
    const B = vert(I[t + 1]);
    const C = vert(I[t + 2]);
    const lo = Math.min(A[1], B[1], C[1]);
    const hi = Math.max(A[1], B[1], C[1]);
    const row0 = Math.max(0, Math.floor((lo - yMin) / span * heights) - 1);
    const row1 = Math.min(heights - 1, Math.ceil((hi - yMin) / span * heights));
    for (let row = row0; row <= row1; row++) {
      const y = yAt(row);
      const pts = [edgePoint(y, A, B), edgePoint(y, B, C), edgePoint(y, C, A)].filter(Boolean);
      if (pts.length < 2) continue;
      let p = pts[0];
      let q = pts[1];
      if (pts.length === 3) {
        const d01 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        const d02 = Math.hypot(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1]);
        const d12 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
        if (d02 >= d01 && d02 >= d12) q = pts[2];
        else if (d12 >= d01) { p = pts[1]; q = pts[2]; }
      }
      const a0 = Math.atan2(p[1], p[0]);
      let sweep = Math.atan2(q[1], q[0]) - a0;
      while (sweep > Math.PI) sweep -= Math.PI * 2;
      while (sweep < -Math.PI) sweep += Math.PI * 2;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * azimuths));
      for (let s = 0; s <= steps; s++) {
        const az = a0 + sweep * (s / steps);
        const r = rayRadius(p, q, az);
        if (!(r > 0)) continue;
        const col = Math.round(((az + Math.PI) / (Math.PI * 2)) * azimuths) % azimuths;
        if (r > table[row][col]) table[row][col] = r;
      }
    }
  }
  for (const row of table) {
    for (let c = 0; c < azimuths; c++) {
      if (row[c] > 0) continue;
      let left = 0;
      let right = 0;
      let dl = 0;
      let dr = 0;
      for (let k = 1; k < azimuths; k++) {
        const lv = row[(c - k + azimuths) % azimuths];
        const rv = row[(c + k) % azimuths];
        if (!dl && lv > 0) { left = lv; dl = k; }
        if (!dr && rv > 0) { right = rv; dr = k; }
        if (dl && dr) break;
      }
      if (dl && dr) row[c] = (left * dr + right * dl) / (dl + dr);
    }
  }
  return {
    yMin,
    yMax,
    radius(y, az) {
      if (y < yMin || y > yMax) return 0;
      const fy = (y - yMin) / span * heights - 0.5;
      const row0 = Math.max(0, Math.min(heights - 1, Math.floor(fy)));
      const row1 = Math.max(0, Math.min(heights - 1, row0 + 1));
      const ty = Math.max(0, Math.min(1, fy - row0));
      let wrapped = az;
      while (wrapped < -Math.PI) wrapped += Math.PI * 2;
      while (wrapped >= Math.PI) wrapped -= Math.PI * 2;
      const fx = (wrapped + Math.PI) / (Math.PI * 2) * azimuths - 0.5;
      const base = Math.floor(fx);
      const tx = fx - base;
      const at = (row, col) => row[(col + azimuths) % azimuths];
      const a = at(table[row0], base) * (1 - tx) + at(table[row0], base + 1) * tx;
      const b = at(table[row1], base) * (1 - tx) + at(table[row1], base + 1) * tx;
      return a * (1 - ty) + b * ty;
    }
  };
}

// `scale` is the chase buoy's meters-per-geometry-unit. `faceAz` is the
// geometry angle the renderer yaws so a face points along the course.
export function makeBuoySolid(geom, scale, faceAz) {
  const field = buildRadiusField(geom);
  return {
    /** Horizontal radius of the widest part, in meters. */
    reachM: field.radius((field.yMin + field.yMax) / 2, 0) * scale,
    /**
     * True when the point (metres from the buoy centre, height above the
     * water) is inside the hull. `facing` is the course direction the buoy
     * is turned toward, the same angle the chase view renders with.
     */
    occupies(dxM, dyM, heightM, facing) {
      const draftM = geom.suggestedDraft * scale;
      // The base puff is a poor horizontal slice. Below the waterline the
      // hull is no wider than the waterline, and it ends at the draft.
      if (heightM < -draftM) return false;
      const yaw = (facing || 0) - faceAz;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const lx = c * dxM + sn * dyM;
      const lz = -sn * dxM + c * dyM;
      const gy = Math.max(heightM, 0) / scale + geom.suggestedDraft;
      const limit = field.radius(gy, Math.atan2(lz, lx)) * scale;
      return limit > 0 && Math.hypot(lx, lz) <= limit;
    }
  };
}
