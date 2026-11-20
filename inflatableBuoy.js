////////////////////////////////////////////////////////////
// inflatableBuoy.js — chase-view adapter for the inflated tetrahedron.
// Geometry lives in inflatedTetraBuoy.js (panels, puff, seams, normals).
// This draws it on the flat canvas: smooth shading, a tight vinyl
// highlight, welded seams, and the SFT plate. Overhead views stay discs.
////////////////////////////////////////////////////////////

import { depthAt, projectClipped, projectHeight } from './chaseCam.js';
import { buildInflatedTetra } from './inflatedTetraBuoy.js';

/** Tip height above the water, in meters. */
export const INFLATABLE_HEIGHT_M = 1.5;

const SEGMENTS = 16;
const TUBE_SIDES = 4;
const LIGHT_UP = 0.94;

let sftLogo = null;
let logoPixels = null;
let mesh = null;
let scratch = null;

function rasterBuffer(w, h) {
  const n = w * h;
  if (!scratch) scratch = { canvas: document.createElement('canvas'), ctx: null, w: 0, h: 0, z: null, pix: null };
  if (!scratch.ctx) scratch.ctx = scratch.canvas.getContext('2d');
  if (scratch.w < w || scratch.h < h) {
    scratch.w = Math.max(scratch.w, w, 32);
    scratch.h = Math.max(scratch.h, h, 32);
    scratch.canvas.width = scratch.w;
    scratch.canvas.height = scratch.h;
    scratch.ctx = scratch.canvas.getContext('2d');
  }
  if (!scratch.z || scratch.z.length < scratch.w * scratch.h) {
    scratch.z = new Float32Array(scratch.w * scratch.h);
    scratch.pix = new Uint8ClampedArray(scratch.z.length * 4);
  }
  scratch.z.fill(1e9, 0, n);
  scratch.pix.fill(0, 0, n * 4);
  return scratch;
}

export function sftLogoImage() {
  if (!sftLogo && typeof Image !== 'undefined') {
    sftLogo = new Image();
    sftLogo.decoding = 'async';
    sftLogo.src = new URL('./assets/buoy/sft.png', import.meta.url).href;
  }
  return sftLogo;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function phaseOf(x, y) {
  const s = Math.sin(x * 0.017 + y * 0.013) * 43758.5453;
  return (s - Math.floor(s)) * Math.PI * 2;
}

function buildMesh() {
  if (mesh) return mesh;
  const geom = buildInflatedTetra({ segments: SEGMENTS });
  const n = SEGMENTS;
  const vertsPer = ((n + 1) * (n + 2)) / 2;
  const visible = geom.height - geom.suggestedDraft;
  const scale = INFLATABLE_HEIGHT_M / visible;
  const panels = geom.groups.map((gr, pIdx) => {
    const base = pIdx * vertsPer;
    const rows = [];
    let k = 0;
    for (let i = 0; i <= n; i++) {
      const row = [];
      for (let j = 0; j <= n - i; j++) {
        const vi = base + k;
        row.push({
          p: [geom.positions[vi * 3], geom.positions[vi * 3 + 1], geom.positions[vi * 3 + 2]],
          nrm: [geom.normals[vi * 3], geom.normals[vi * 3 + 1], geom.normals[vi * 3 + 2]],
          u: geom.uvs[vi * 2],
          v: geom.uvs[vi * 2 + 1]
        });
        k++;
      }
      rows.push(row);
    }
    return { kind: gr.kind, rows };
  });
  let nx = 0;
  let nz = 0;
  const side0 = panels[0];
  for (const row of side0.rows) {
    for (const v of row) {
      nx += v.nrm[0];
      nz += v.nrm[2];
    }
  }
  const tubes = geom.seams.map(pts => tubeStrip(pts, 0.008 * geom.edge, TUBE_SIDES));
  const corners = panels.filter(p => p.kind === 'side').map(p => p.rows[n][0].p);
  mesh = {
    geom, panels, tubes, corners, scale,
    draft: geom.suggestedDraft * scale,
    faceAz: Math.atan2(nz, nx),
    logo: logoRect(geom)
  };
  return mesh;
}

function logoRect(geom) {
  const slantOverEdge = geom.slant / geom.edge;
  const logoWidth = 0.68;
  const logoCenterV = 0.38;
  const aspect = 396 / 166;
  const vHalf = ((logoWidth / aspect) / slantOverEdge) / 2;
  return {
    u0: 0.5 - logoWidth / 2,
    u1: 0.5 + logoWidth / 2,
    v0: logoCenterV - vHalf,
    v1: logoCenterV + vHalf
  };
}

function tubeStrip(pts, radius, sides) {
  const step = 2;
  const used = [];
  for (let i = 0; i < pts.length; i += step) used.push(pts[i]);
  const last = pts[pts.length - 1];
  const tail = used[used.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1] || tail[2] !== last[2]) used.push(last);
  const rings = used.map((p, i) => {
    const a = used[Math.max(0, i - 1)];
    const b = used[Math.min(used.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    let tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    let hx = 0;
    let hy = 1;
    let hz = 0;
    if (Math.abs(ty) > 0.85) { hx = 1; hy = 0; }
    let ux = ty * hz - tz * hy;
    let uy = tz * hx - tx * hz;
    let uz = tx * hy - ty * hx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ty * uz - tz * uy;
    const vy = tz * ux - tx * uz;
    const vz = tx * uy - ty * ux;
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const nrm = [ux * c + vx * sn, uy * c + vy * sn, uz * c + vz * sn];
      ring.push({
        p: [
          p[0] + nrm[0] * radius,
          p[1] + nrm[1] * radius,
          p[2] + nrm[2] * radius
        ],
        nrm
      });
    }
    return ring;
  });
  const tris = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      tris.push([rings[i][s], rings[i + 1][s], rings[i + 1][s2]]);
      tris.push([rings[i][s], rings[i + 1][s2], rings[i][s2]]);
    }
  }
  return tris;
}

function poseAt(x, y, facing) {
  const m = buildMesh();
  const t = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;
  const phase = phaseOf(x, y);
  return {
    x, y,
    scale: m.scale,
    draft: m.draft,
    pivot: m.geom.height * 0.28,
    yaw: facing - m.faceAz,
    rx: 0.045 * Math.sin(t * 1.7 + phase),
    rz: 0.045 * Math.sin(t * 1.3 + phase * 2.3),
    heave: 0.035 * Math.sin(t * 2.1 + phase) + 0.018 * Math.sin(t * 3.3 + phase * 1.7)
  };
}

function rotatePoint(px, py, pz, pose) {
  let x = px;
  let y = py - pose.pivot;
  let z = pz;
  const cx = Math.cos(pose.rx);
  const sx = Math.sin(pose.rx);
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  const cz = Math.cos(pose.rz);
  const sz = Math.sin(pose.rz);
  const x2 = x * cz - y1 * sz;
  const y2 = x * sz + y1 * cz;
  y = y2 + pose.pivot;
  z = z1;
  x = x2;
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  return {
    x: x * cy - z * sy,
    y: x * sy + z * cy,
    z: y
  };
}

function worldPoint(local, pose, ppm) {
  const r = rotatePoint(local[0], local[1], local[2], pose);
  return {
    x: pose.x + r.x * pose.scale * ppm,
    y: pose.y + r.y * pose.scale * ppm,
    z: (r.z * pose.scale - pose.draft + pose.heave) * ppm
  };
}

function worldNormal(nrm, pose) {
  const r = rotatePoint(nrm[0], nrm[1], nrm[2], { ...pose, pivot: 0 });
  return normalize(r);
}

function lightToward(cam) {
  const dx = cam.eyeX - cam.lx;
  const dy = cam.eyeY - cam.ly;
  const h = Math.hypot(dx, dy) || 1;
  return normalize({ x: dx / h * 0.38, y: dy / h * 0.38, z: LIGHT_UP });
}

function shadeOf(nrm, world, cam, light) {
  const eye = normalize({
    x: cam.eyeX - world.x,
    y: cam.eyeY - world.y,
    z: cam.eyeZ - world.z
  });
  const nd = Math.max(0, dot(nrm, light));
  const half = normalize({
    x: light.x + eye.x,
    y: light.y + eye.y,
    z: light.z + eye.z
  });
  const hd = Math.max(0, dot(nrm, half));
  const facing = Math.max(0, dot(nrm, eye));
  const spec = Math.pow(hd, 36) * 0.95 + Math.pow(hd, 7) * 0.28;
  const sky = Math.max(0, nrm.z);
  const base = 0.74 + 0.2 * nd + 0.06 * sky + Math.pow(1 - facing, 3) * 0.05;
  return { base: Math.min(1.05, base), spec, facing };
}

function logoReady(logo) {
  return !!(logo && logo.complete && logo.naturalWidth > 0);
}

function ensureLogoPixels(logo) {
  if (!logoReady(logo) || typeof document === 'undefined') return null;
  if (logoPixels && logoPixels._src === logo) return logoPixels;
  const c = document.createElement('canvas');
  c.width = logo.naturalWidth;
  c.height = logo.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(logo, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  logoPixels = { data: data.data, width: c.width, height: c.height, _src: logo };
  return logoPixels;
}

function clipAboveWater(verts) {
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const aIn = a.world.z >= 0;
    const bIn = b.world.z >= 0;
    const mid = () => {
      const t = a.world.z / (a.world.z - b.world.z);
      const mix = (p, q) => p + (q - p) * t;
      return {
        world: {
          x: mix(a.world.x, b.world.x),
          y: mix(a.world.y, b.world.y),
          z: 0
        },
        screen: null,
        shade: {
          base: mix(a.shade.base, b.shade.base),
          spec: mix(a.shade.spec, b.shade.spec)
        },
        uv: a.uv && b.uv ? { u: mix(a.uv.u, b.uv.u), v: mix(a.uv.v, b.uv.v) } : null
      };
    };
    if (aIn && bIn) out.push(b);
    else if (aIn && !bIn) out.push(mid());
    else if (!aIn && bIn) {
      out.push(mid());
      out.push(b);
    }
  }
  return out;
}

function rasterTriangles(ctx, cam, tris, logo, logoBox) {
  if (!tris.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tris) {
    for (const v of t) {
      if (!v.screen) continue;
      minX = Math.min(minX, v.screen.x);
      minY = Math.min(minY, v.screen.y);
      maxX = Math.max(maxX, v.screen.x);
      maxY = Math.max(maxY, v.screen.y);
    }
  }
  if (!Number.isFinite(minX)) return;
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(cam.viewW - 1, Math.ceil(maxX));
  const y1 = Math.min(cam.viewH - 1, Math.ceil(maxY));
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 2 || h < 2 || w * h > cam.viewW * cam.viewH) return;
  const buf = rasterBuffer(w, h);
  const pixels = buf.pix;
  const zbuf = buf.z;
  const lw = logo ? logo.width : 0;
  const lh = logo ? logo.height : 0;
  const src = logo ? logo.data : null;

  for (const tri of tris) {
    const s0 = tri[0].screen;
    const s1 = tri[1].screen;
    const s2 = tri[2].screen;
    if (!s0 || !s1 || !s2) continue;
    const ax = s0.x - x0;
    const ay = s0.y - y0;
    const bx = s1.x - x0;
    const by = s1.y - y0;
    const cx = s2.x - x0;
    const cy = s2.y - y0;
    const denom = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(denom) < 0.05) continue;
    const minSX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxSX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minSY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxSY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    const b0 = tri[0].shade.base;
    const b1 = tri[1].shade.base;
    const b2 = tri[2].shade.base;
    const p0 = tri[0].shade.spec;
    const p1 = tri[1].shade.spec;
    const p2 = tri[2].shade.spec;
    const d0 = s0.depth;
    const d1 = s1.depth;
    const d2 = s2.depth;
    const uv0 = tri[0].uv;
    const uv1 = tri[1].uv;
    const uv2 = tri[2].uv;
    for (let y = minSY; y <= maxSY; y++) {
      const py = y + 0.5;
      for (let x = minSX; x <= maxSX; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / denom;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / denom;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
        const depth = w0 * d0 + w1 * d1 + w2 * d2;
        const pi = y * w + x;
        if (depth >= zbuf[pi]) continue;
        zbuf[pi] = depth;
        const base = w0 * b0 + w1 * b1 + w2 * b2;
        const spec = w0 * p0 + w1 * p1 + w2 * p2;
        let r = base * 246 + spec * 170;
        let g = base * 248 + spec * 170;
        let b = base * 255 + spec * 155;
        if (src && tri.applyLogo && uv0 && logoBox) {
          const u = w0 * uv0.u + w1 * uv1.u + w2 * uv2.u;
          const v = w0 * uv0.v + w1 * uv1.v + w2 * uv2.v;
          const iu = (u - logoBox.u0) / (logoBox.u1 - logoBox.u0);
          const iv = (v - logoBox.v0) / (logoBox.v1 - logoBox.v0);
          if (iu >= 0 && iv >= 0 && iu <= 1 && iv <= 1) {
            const sx = Math.min(lw - 1, Math.max(0, (iu * (lw - 1)) | 0));
            const sy = Math.min(lh - 1, Math.max(0, ((1 - iv) * (lh - 1)) | 0));
            const oi = (sy * lw + sx) * 4;
            const a = src[oi + 3] / 255;
            if (a > 0.02) {
              const lr = src[oi] * base + spec * 210;
              const lg = src[oi + 1] * base + spec * 210;
              const lb = src[oi + 2] * base + spec * 200;
              r = r * (1 - a) + lr * a;
              g = g * (1 - a) + lg * a;
              b = b * (1 - a) + lb * a;
            }
          }
        }
        const o = pi * 4;
        pixels[o] = r;
        pixels[o + 1] = g;
        pixels[o + 2] = b;
        pixels[o + 3] = 255;
      }
    }
  }

  buf.ctx.putImageData(new ImageData(pixels.subarray(0, w * h * 4), w, h), 0, 0);
  ctx.drawImage(buf.canvas, 0, 0, w, h, x0, y0, w, h);
}

function fillPoly(ctx, poly, color) {
  if (!poly || poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function waterlineCorners(pose, ppm) {
  const m = buildMesh();
  const frac = 1 - m.geom.suggestedDraft / m.geom.height;
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  return m.corners.map(c => {
    const lx = c[0] * frac * m.scale;
    const lz = c[2] * frac * m.scale;
    return {
      x: pose.x + (lx * cy - lz * sy) * ppm,
      y: pose.y + (lx * sy + lz * cy) * ppm,
      z: 0
    };
  });
}

function drawWaterline(ctx, cam, pose, ppm, paint) {
  const m = buildMesh();
  const pts = waterlineCorners(pose, ppm);
  const grow = (pad) => pts.map(p => {
    const dx = p.x - pose.x;
    const dy = p.y - pose.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / len * pad, y: p.y + dy / len * pad, z: 0 };
  });
  const shadow = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const rad = 0.34 * m.geom.edge * m.scale * ppm;
    shadow.push({ x: pose.x + Math.cos(a) * rad, y: pose.y + Math.sin(a) * rad, z: 0 });
  }
  fillPoly(ctx, projectClipped(cam, shadow), 'rgba(0,0,0,0.22)');
  fillPoly(ctx, projectClipped(cam, grow(0.22 * ppm)), paint.stroke);
  fillPoly(ctx, projectClipped(cam, grow(0.07 * ppm)), paint.fill);
}

function finishScreen(vert, cam) {
  if (vert.screen || vert.world.z < 0) return vert;
  const s = projectHeight(cam, vert.world.x, vert.world.y, vert.world.z);
  if (s) vert.screen = s;
  return vert;
}

/**
 * Draw one chase-view buoy. `paint` is the pass-side waterline color.
 * `facing` aims one panel toward the course.
 */
export function drawInflatableBuoy(ctx, cam, { x, y, ppm, paint, facing, logo }) {
  const m = buildMesh();
  const pose = poseAt(x, y, facing || 0);
  drawWaterline(ctx, cam, pose, ppm, paint);
  const tipZ = (m.geom.height * m.scale - pose.draft + pose.heave) * ppm;
  const apex = projectHeight(cam, pose.x, pose.y, tipZ);
  const foot = projectHeight(cam, pose.x, pose.y, 0);
  const pxH = apex && foot ? Math.abs(foot.y - apex.y) : 0;
  // The mesh is only worth it up close. Far marks stay a white triangle.
  if (!apex || pxH < 40) {
    const corners = waterlineCorners(pose, ppm)
      .map(p => projectHeight(cam, p.x, p.y, 0))
      .filter(Boolean);
    if (apex && corners.length === 3) {
      const faces = [0, 1, 2].map(i => {
        const a = corners[i];
        const b = corners[(i + 1) % 3];
        return { poly: [apex, a, b], depth: (apex.depth + a.depth + b.depth) / 3 };
      });
      faces.sort((p, q) => q.depth - p.depth);
      for (const face of faces) fillPoly(ctx, face.poly, '#f3f6f8');
    }
    return;
  }
  const light = lightToward(cam);
  const plate = ensureLogoPixels(logo);
  const tris = [];

  const pushTri = (a, b, c, logoOn) => {
    const verts = [a, b, c].map((item) => {
      const local = item.p || item;
      const nrm = item.nrm;
      const world = worldPoint(local, pose, ppm);
      const normal = nrm ? worldNormal(nrm, pose) : { x: 0, y: 0, z: 1 };
      const sh = shadeOf(normal, world, cam, light);
      const screen = world.z >= 0 ? projectHeight(cam, world.x, world.y, world.z) : null;
      return {
        world,
        screen,
        shade: sh,
        uv: item.u == null ? null : { u: item.u, v: item.v },
        facing: sh.facing
      };
    });
    if (verts[0].facing + verts[1].facing + verts[2].facing < 0.12) return;
    let poly = verts;
    if (verts.some(v => v.world.z < 0)) {
      poly = clipAboveWater(verts);
      for (const v of poly) finishScreen(v, cam);
    }
    if (poly.length < 3) return;
    const emit = (t) => {
      if (!t.every(v => v.screen)) return;
      t.applyLogo = logoOn;
      tris.push(t);
    };
    emit([poly[0], poly[1], poly[2]]);
    if (poly.length === 4) emit([poly[0], poly[2], poly[3]]);
  };

  for (const panel of m.panels) {
    const rows = panel.rows;
    const logoOn = panel.kind === 'side';
    for (let i = 0; i < SEGMENTS; i++) {
      for (let j = 0; j < SEGMENTS - i; j++) {
        const v00 = rows[i][j];
        const v10 = rows[i + 1][j];
        const v01 = rows[i][j + 1];
        pushTri(v00, v10, v01, logoOn);
        if (i + j < SEGMENTS - 1) pushTri(v10, rows[i + 1][j + 1], v01, logoOn);
      }
    }
  }

  if (pxH >= 88) {
    for (const strip of m.tubes) {
      for (const tri of strip) {
        pushTri(
          { p: tri[0].p, nrm: tri[0].nrm, u: null, v: null },
          { p: tri[1].p, nrm: tri[1].nrm, u: null, v: null },
          { p: tri[2].p, nrm: tri[2].nrm, u: null, v: null },
          false
        );
      }
    }
  }

  for (const tri of tris) {
    if (tri.applyLogo !== false || tri.some(v => v.uv)) continue;
    for (const v of tri) {
      v.shade = { base: v.shade.base * 0.62, spec: v.shade.spec * 0.22, facing: v.shade.facing };
    }
  }

  rasterTriangles(ctx, cam, tris, plate, plate ? m.logo : null);
}
