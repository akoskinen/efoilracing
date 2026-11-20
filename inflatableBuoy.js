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
  // 0 is empty. A larger 1/depth is closer to the camera.
  scratch.z.fill(0, 0, n);
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
  const logoCenterV = 0.34;
  const aspect = 396 / 166;
  // 0.40 is about 40% narrower than the previous 0.68 plate, which ran
  // past the slanted seams. The clamp keeps the rectangle inside the
  // triangle even if the aspect changes.
  const k = 1 / (2 * aspect * slantOverEdge);
  const margin = 0.05;
  const logoWidth = Math.min(0.40, (1 - logoCenterV - margin * 2) / (1 + k));
  const vHalf = logoWidth * k;
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
  // Planted on the water. Rocking and heave made the plate crawl and the
  // silhouette pop as the camera swung around the mark.
  return {
    x, y,
    scale: m.scale,
    draft: m.draft,
    pivot: m.geom.height * 0.28,
    yaw: facing - m.faceAz,
    rx: 0,
    rz: 0,
    heave: 0
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

// Fixed sun. A light that followed the camera made each facet flash as the
// rider turned around the buoy.
const SUN = normalize({ x: 0.28, y: -0.18, z: LIGHT_UP });

function shadeOf(nrm, world, cam) {
  const eye = normalize({
    x: cam.eyeX - world.x,
    y: cam.eyeY - world.y,
    z: cam.eyeZ - world.z
  });
  const nd = Math.max(0, dot(nrm, SUN));
  const facing = Math.max(0, dot(nrm, eye));
  const sky = Math.max(0, nrm.z);
  const base = 0.76 + 0.18 * nd + 0.06 * sky;
  const spec = Math.pow(nd, 6) * 0.07;
  return { base: Math.min(1.02, base), spec, facing };
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

// A vertex just in front of the camera projects to a huge screen coordinate
// and the triangle becomes a spike across the view. One just behind is
// dropped with the whole triangle, so a chunk of the buoy vanishes. Cut
// the edge on the near plane instead, same as the flat buoy discs.
const NEAR_PLANE = 1.25;

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

function clipToNear(cam, verts) {
  const depthOf = (v) => depthAt(cam, v.world.x, v.world.y, v.world.z);
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const da = depthOf(a);
    const db = depthOf(b);
    const aIn = da >= NEAR_PLANE;
    const bIn = db >= NEAR_PLANE;
    const mid = () => {
      const t = (NEAR_PLANE - da) / (db - da);
      const mix = (p, q) => p + (q - p) * t;
      const world = {
        x: mix(a.world.x, b.world.x),
        y: mix(a.world.y, b.world.y),
        z: mix(a.world.z, b.world.z)
      };
      return {
        world,
        screen: projectHeight(cam, world.x, world.y, world.z),
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

// Local Y-up maps onto world Z-up with a reflection, so a panel that faces
// the eye has a negative right-handed cross product. Vertex normals lean
// around the puff and used to let a sliver of the back plate poke through
// the seam as the camera came around.
function frontFacing(tri, cam) {
  const a = tri[0].world;
  const b = tri[1].world;
  const c = tri[2].world;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const ex = cam.eyeX - a.x;
  const ey = cam.eyeY - a.y;
  const ez = cam.eyeZ - a.z;
  const facing = nx * ex + ny * ey + nz * ez;
  const scale = (Math.hypot(nx, ny, nz) * Math.hypot(ex, ey, ez)) || 1;
  // Negative means the face points at the eye. A small positive margin keeps
  // the panel until it has turned a few degrees past edge-on, so the plate
  // does not open a hole along the seam as the camera swings past.
  return { facing: facing / scale };
}

function panelFacesCamera(panel, pose, cam, ppm) {
  const n = SEGMENTS;
  const corners = [panel.rows[0][0], panel.rows[n][0], panel.rows[0][n]];
  const tri = corners.map(v => ({ world: worldPoint(v.p, pose, ppm) }));
  return frontFacing(tri, cam).facing < 0.04;
}

// Bilinear, premultiplied, so the plate edge doesn't sparkle as texels
// cross a pixel while the camera moves.
function sampleLogo(src, lw, lh, iu, iv) {
  const fx = Math.min(lw - 1.001, Math.max(0, iu * (lw - 1)));
  const fy = Math.min(lh - 1.001, Math.max(0, (1 - iv) * (lh - 1)));
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < lw ? x0 + 1 : x0;
  const y1 = y0 + 1 < lh ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x, y) => {
    const oi = (y * lw + x) * 4;
    const a = src[oi + 3] * (1 / 255);
    return [src[oi] * a, src[oi + 1] * a, src[oi + 2] * a, a];
  };
  const c00 = at(x0, y0);
  const c10 = at(x1, y0);
  const c01 = at(x0, y1);
  const c11 = at(x1, y1);
  const mix = (p, q, t) => p + (q - p) * t;
  const top = [
    mix(c00[0], c10[0], tx), mix(c00[1], c10[1], tx),
    mix(c00[2], c10[2], tx), mix(c00[3], c10[3], tx)
  ];
  const bot = [
    mix(c01[0], c11[0], tx), mix(c01[1], c11[1], tx),
    mix(c01[2], c11[2], tx), mix(c01[3], c11[3], tx)
  ];
  return [
    mix(top[0], bot[0], ty), mix(top[1], bot[1], ty),
    mix(top[2], bot[2], ty), mix(top[3], bot[3], ty)
  ];
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
    const absDen = Math.abs(denom);
    if (absDen < 0.05) continue;
    // Half a pixel past each edge, so shared edges don't leave a crack
    // that flashes the background or the plate's cutouts as the view moves.
    const pxBias = 0.65;
    const eps0 = pxBias * Math.hypot(cx - bx, cy - by) / absDen;
    const eps1 = pxBias * Math.hypot(ax - cx, ay - cy) / absDen;
    const eps2 = pxBias * Math.hypot(bx - ax, by - ay) / absDen;
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
    const bias = tri.depthBias || 1;
    const d0 = s0.depth * bias;
    const d1 = s1.depth * bias;
    const d2 = s2.depth * bias;
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
        if (w0 < -eps0 || w1 < -eps1 || w2 < -eps2) continue;
        // 1/depth interpolated in screen space is the real camera depth.
        // A linear mix let the far panel poke through the near one.
        const iw0 = w0 / Math.max(d0, 1e-3);
        const iw1 = w1 / Math.max(d1, 1e-3);
        const iw2 = w2 / Math.max(d2, 1e-3);
        const inv = iw0 + iw1 + iw2;
        const pi = y * w + x;
        if (inv <= zbuf[pi]) continue;
        zbuf[pi] = inv;
        const iw = inv || 1;
        const base = (iw0 * b0 + iw1 * b1 + iw2 * b2) / iw;
        const spec = (iw0 * p0 + iw1 * p1 + iw2 * p2) / iw;
        let r = base * 246 + spec * 170;
        let g = base * 248 + spec * 170;
        let b = base * 255 + spec * 155;
        if (src && tri.applyLogo && uv0 && logoBox) {
          const u = (iw0 * uv0.u + iw1 * uv1.u + iw2 * uv2.u) / iw;
          const v = (iw0 * uv0.v + iw1 * uv1.v + iw2 * uv2.v) / iw;
          const iu = (u - logoBox.u0) / (logoBox.u1 - logoBox.u0);
          const iv = (v - logoBox.v0) / (logoBox.v1 - logoBox.v0);
          if (iu >= 0 && iv >= 0 && iu <= 1 && iv <= 1) {
            const tex = sampleLogo(src, lw, lh, iu, iv);
            const a = tex[3];
            if (a > 0.02) {
              const lr = (tex[0] / a) * base + spec * 80;
              const lg = (tex[1] / a) * base + spec * 80;
              const lb = (tex[2] / a) * base + spec * 70;
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

function drawWaterline(ctx, cam, pose, ppm) {
  const m = buildMesh();
  const shadow = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const rad = 0.34 * m.geom.edge * m.scale * ppm;
    shadow.push({ x: pose.x + Math.cos(a) * rad, y: pose.y + Math.sin(a) * rad, z: 0 });
  }
  fillPoly(ctx, projectClipped(cam, shadow), 'rgba(0,0,0,0.22)');
}

function finishScreen(vert, cam) {
  if (vert.screen || vert.world.z < 0) return vert;
  const s = projectHeight(cam, vert.world.x, vert.world.y, vert.world.z);
  if (s) vert.screen = s;
  return vert;
}

/**
 * Draw one chase-view buoy. `facing` aims one panel toward the course.
 * Pass-side rings are drawn by the engine, and only while the camera is flat.
 */
export function drawInflatableBuoy(ctx, cam, { x, y, ppm, facing, logo }) {
  const m = buildMesh();
  const pose = poseAt(x, y, facing || 0);
  drawWaterline(ctx, cam, pose, ppm);
  const tipZ = (m.geom.height * m.scale - pose.draft + pose.heave) * ppm;
  const apex = projectHeight(cam, pose.x, pose.y, tipZ);
  const foot = projectHeight(cam, pose.x, pose.y, 0);
  const pxH = apex && foot ? Math.abs(foot.y - apex.y) : 0;
  // A buoy you can still pick out on the course is about 10px tall. The plate
  // stays on the mesh down to a speck, so it does not pop in only up close.
  if (!apex || pxH < 8) {
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
  const plate = ensureLogoPixels(logo);
  const tris = [];

  const pushTri = (a, b, c, logoOn, cull, depthBias) => {
    const verts = [a, b, c].map((item) => {
      const local = item.p || item;
      const nrm = item.nrm;
      const world = worldPoint(local, pose, ppm);
      const normal = nrm ? worldNormal(nrm, pose) : { x: 0, y: 0, z: 1 };
      const sh = shadeOf(normal, world, cam);
      const screen = world.z >= 0 ? projectHeight(cam, world.x, world.y, world.z) : null;
      return {
        world,
        screen,
        shade: sh,
        uv: item.u == null ? null : { u: item.u, v: item.v }
      };
    });
    let poly = verts;
    if (verts.some(v => v.world.z < 0)) {
      poly = clipAboveWater(verts);
      if (poly.length < 3) return;
    }
    // Drop the part that has crossed the camera, and keep the rest.
    poly = clipToNear(cam, poly);
    if (poly.length < 3) return;
    for (const v of poly) finishScreen(v, cam);
    const emit = (t) => {
      if (!t.every(v => v.screen)) return;
      // Per-triangle culling punched holes through the plate: the crown
      // normals point away while the face is still the one in view, and the
      // background showed through the letters. A whole panel is kept or
      // dropped together. Seam tubes still cull their back half.
      const face = frontFacing(t, cam).facing;
      // Tubes drop their back half. A panel that still faces the camera keeps
      // triangles a little past edge-on, so the plate is not punched out, and
      // drops the ones that have wrapped onto the back of the puff.
      if (cull ? face > 0 : face > 0.45) return;
      t.applyLogo = logoOn;
      if (depthBias) t.depthBias = depthBias;
      tris.push(t);
    };
    for (let k = 1; k < poly.length - 1; k++) emit([poly[0], poly[k], poly[k + 1]]);
  };

  for (const panel of m.panels) {
    if (!panelFacesCamera(panel, pose, cam, ppm)) continue;
    const rows = panel.rows;
    const logoOn = panel.kind === 'side';
    for (let i = 0; i < SEGMENTS; i++) {
      for (let j = 0; j < SEGMENTS - i; j++) {
        const v00 = rows[i][j];
        const v10 = rows[i + 1][j];
        const v01 = rows[i][j + 1];
        pushTri(v00, v10, v01, logoOn, false);
        if (i + j < SEGMENTS - 1) pushTri(v10, rows[i + 1][j + 1], v01, logoOn, false);
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
          false,
          true,
          0.97
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
