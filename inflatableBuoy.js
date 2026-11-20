////////////////////////////////////////////////////////////
// inflatableBuoy.js — chase-view adapter for the inflated tetrahedron.
// Geometry lives in inflatedTetraBuoy.js (panels, puff, seams, normals).
// This draws it on the flat canvas: smooth shading, a tight vinyl
// highlight, and the SFT plate. Overhead views stay discs.
////////////////////////////////////////////////////////////

import { depthAt, projectClipped, projectHeight } from './chaseCam.js';
import { buildInflatedTetra } from './inflatedTetraBuoy.js';

/** Tip height above the water, in meters. */
export const INFLATABLE_HEIGHT_M = 1.5;

const SEGMENTS = 32;
const LIGHT_UP = 0.94;

let sftLogo = null;
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
  mesh = {
    geom, panels, scale,
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
// the eye has a negative right-handed cross product.
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
  return { facing: facing / scale };
}

// u = b + 0.5·c and v = c on the flat panel, so a logo corner can be
// picked back out of the puffed grid.
function samplePanel(panel, u, v) {
  const n = SEGMENTS;
  const c = Math.min(1, Math.max(0, v));
  const b = Math.min(1 - c, Math.max(0, u - 0.5 * c));
  let i = Math.min(n - 1e-4, Math.max(0, b * n));
  let j = Math.min(n - i - 1e-4, Math.max(0, c * n));
  const i0 = i | 0;
  const j0 = j | 0;
  const fi = i - i0;
  const fj = j - j0;
  const rows = panel.rows;
  const mix = (A, B, C, wa, wb, wc) => {
    const p = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      p[k] = A.p[k] * wa + B.p[k] * wb + C.p[k] * wc;
    }
    return p;
  };
  if (fi + fj <= 1) {
    return mix(rows[i0][j0], rows[i0 + 1][j0], rows[i0][j0 + 1], 1 - fi - fj, fi, fj);
  }
  return mix(
    rows[i0 + 1][j0], rows[i0 + 1][j0 + 1], rows[i0][j0 + 1],
    1 - fj, fi + fj - 1, 1 - fi
  );
}

function rasterTriangles(ctx, cam, tris, ss = 1) {
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
  const x0 = Math.max(0, Math.floor(minX) - 2);
  const y0 = Math.max(0, Math.floor(minY) - 2);
  const x1 = Math.min(cam.viewW - 1, Math.ceil(maxX) + 2);
  const y1 = Math.min(cam.viewH - 1, Math.ceil(maxY) + 2);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 2 || h < 2 || w * h > cam.viewW * cam.viewH) return;
  // Small buoys are drawn ss times finer and scaled down, so a buoy a few
  // dozen pixels tall averages many samples per pixel instead of snapping
  // its edges and plate from pixel to pixel as the camera drifts.
  const W = w * ss;
  const H = h * ss;
  const buf = rasterBuffer(W, H);
  const pixels = buf.pix;
  const zbuf = buf.z;

  for (const tri of tris) {
    const s0 = tri[0].screen;
    const s1 = tri[1].screen;
    const s2 = tri[2].screen;
    if (!s0 || !s1 || !s2) continue;
    const ax = (s0.x - x0) * ss;
    const ay = (s0.y - y0) * ss;
    const bx = (s1.x - x0) * ss;
    const by = (s1.y - y0) * ss;
    const cx = (s2.x - x0) * ss;
    const cy = (s2.y - y0) * ss;
    const denom = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    const absDen = Math.abs(denom);
    if (absDen < 1e-4) continue;
    const e12 = Math.hypot(cx - bx, cy - by) || 1;
    const e20 = Math.hypot(ax - cx, ay - cy) || 1;
    const e01 = Math.hypot(bx - ax, by - ay) || 1;
    const minSX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 2));
    const maxSX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx) + 2));
    const minSY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 2));
    const maxSY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy) + 2));
    const b0 = tri[0].shade.base;
    const b1 = tri[1].shade.base;
    const b2 = tri[2].shade.base;
    const p0 = tri[0].shade.spec;
    const p1 = tri[1].shade.spec;
    const p2 = tri[2].shade.spec;
    const d0 = s0.depth;
    const d1 = s1.depth;
    const d2 = s2.depth;
    for (let y = minSY; y <= maxSY; y++) {
      const py = y + 0.5;
      for (let x = minSX; x <= maxSX; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / denom;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / denom;
        const w2 = 1 - w0 - w1;
        // Distance outside the nearest edge, in pixels. Only pixels inside
        // the triangle take part in the depth test. Up to half a pixel outside
        // still fills a pixel nothing else covered, so an edge-on panel's
        // sliver does not leave a dotted crack along the seam. Past that the
        // edge fades out, because a hard fill crawled in stairs as the buoy
        // grew toward the camera.
        const dEdge = Math.min(w0 * absDen / e12, w1 * absDen / e20, w2 * absDen / e01);
        if (dEdge < -1.1) continue;
        const solid = dEdge >= -0.08;
        const cov = solid ? 1 : (dEdge >= -0.5 ? 1 : (dEdge + 1.1) / 0.6);
        // Clamp so a pixel just outside an edge still takes that edge's
        // colour, instead of extrapolating into a dark or bright fringe.
        const cw0 = w0 > 0 ? w0 : 0;
        const cw1 = w1 > 0 ? w1 : 0;
        const cw2 = w2 > 0 ? w2 : 0;
        const iw0 = cw0 / Math.max(d0, 1e-3);
        const iw1 = cw1 / Math.max(d1, 1e-3);
        const iw2 = cw2 / Math.max(d2, 1e-3);
        const inv = iw0 + iw1 + iw2;
        const pi = y * W + x;
        // An edge pixel must not replace vinyl that already covers it, or
        // every shared edge turns into a translucent crack.
        if (solid) {
          if (zbuf[pi] > 0 && inv <= zbuf[pi]) continue;
          zbuf[pi] = inv;
        } else if (zbuf[pi] > 0 || pixels[pi * 4 + 3] >= cov * 255) {
          continue;
        }
        const iw = inv || 1;
        const base = (iw0 * b0 + iw1 * b1 + iw2 * b2) / iw;
        const spec = (iw0 * p0 + iw1 * p1 + iw2 * p2) / iw;
        const r = base * 246 + spec * 170;
        const g = base * 248 + spec * 170;
        const b = base * 255 + spec * 155;
        const o = pi * 4;
        pixels[o] = r;
        pixels[o + 1] = g;
        pixels[o + 2] = b;
        pixels[o + 3] = cov * 255;
      }
    }
  }

  buf.ctx.putImageData(new ImageData(pixels.subarray(0, W * H * 4), W, H), 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(buf.canvas, 0, 0, W, H, x0, y0, w, h);
  ctx.restore();
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
  if (!apex && !foot) return;
  const pxH = apex && foot ? Math.abs(foot.y - apex.y) : 1e4;
  const tris = [];
  const cards = [];
  // Every panel is drawn at every size and angle and the depth buffer hides
  // the back. Swapping to a flat triangle when small, or dropping a panel
  // past a facing cutoff, made the shape jump as the buoy grew or turned.
  // A coarser grid when small is the same surface with fewer points, so
  // the outline does not change, only the cost.
  const ss = pxH < 48 ? 4 : (pxH < 140 ? 2 : 1);
  const fine = pxH * ss;
  const stride = fine < 36 ? 4 : (fine < 110 ? 2 : 1);

  const vertex = (item) => {
    if (item.cached) return item.cached;
    const world = worldPoint(item.p, pose, ppm);
    const normal = worldNormal(item.nrm, pose);
    const shade = shadeOf(normal, world, cam);
    const screen = world.z >= 0 ? projectHeight(cam, world.x, world.y, world.z) : null;
    const v = { world, screen, shade, uv: { u: item.u, v: item.v } };
    item.cached = v;
    return v;
  };

  const pushTri = (a, b, c) => {
    let poly = [vertex(a), vertex(b), vertex(c)];
    if (poly.some(v => v.world.z < 0)) {
      poly = clipAboveWater(poly);
      if (poly.length < 3) return;
    }
    poly = clipToNear(cam, poly);
    if (poly.length < 3) return;
    for (const v of poly) finishScreen(v, cam);
    for (let k = 1; k < poly.length - 1; k++) {
      const t = [poly[0], poly[k], poly[k + 1]];
      if (!t.every(v => v.screen)) continue;
      // The hull is closed above the water, so any triangle turned away from
      // the eye is hidden by one that faces it. Dropping those leaves no pair
      // of surfaces at nearly the same depth to fight over a pixel. A depth
      // nudge flipped on and off as the camera turned and made far buoys
      // flicker. Uses the drawn triangle, not the smooth vertex normals,
      // which lean around the puff and punched holes in the face.
      if (frontFacing(t, cam).facing > 0) continue;
      tris.push(t);
    }
  };

  for (const panel of m.panels) {
    const rows = panel.rows;
    for (const row of rows) for (const item of row) item.cached = null;
    const card = panel.kind === 'side' ? logoCard(panel) : null;
    if (card) cards.push(card);
    const n = SEGMENTS;
    for (let i = 0; i < n; i += stride) {
      for (let j = 0; j < n - i; j += stride) {
        const v00 = rows[i][j];
        const v10 = rows[i + stride][j];
        const v01 = rows[i][j + stride];
        pushTri(v00, v10, v01);
        if (i + j + stride < n) pushTri(v10, rows[i + stride][j + stride], v01);
      }
    }
  }

  rasterTriangles(ctx, cam, tris, ss);
  // The plate is the real PNG, scaled by the browser and painted over the
  // mesh. It fades out as its face turns edge-on instead of switching off,
  // and is never baked into the mesh, where a hidden face's letters would
  // speckle through at the seams.
  cards.sort((a, b) => b.depth - a.depth);
  for (const card of cards) paintLogoCard(ctx, card, logo);

  function logoCard(panel) {
    if (!logoReady(logo)) return null;
    const box = m.logo;
    const corner = (u, v) => {
      const world = worldPoint(samplePanel(panel, u, v), pose, ppm);
      if (world.z < 0) return null;
      const screen = projectHeight(cam, world.x, world.y, world.z);
      return screen ? { ...screen, world } : null;
    };
    // Image y grows downward, so the top of the file is the high-v edge.
    const topL = corner(box.u0, box.v1);
    const topR = corner(box.u1, box.v1);
    const botR = corner(box.u1, box.v0);
    const botL = corner(box.u0, box.v0);
    if (!topL || !topR || !botR || !botL) return null;
    const n = SEGMENTS;
    const flat = [panel.rows[0][0], panel.rows[n][0], panel.rows[0][n]]
      .map(v => ({ world: worldPoint(v.p, pose, ppm) }));
    const facing = frontFacing(flat, cam).facing;
    const alpha = smoothstep(0.02, 0.22, -facing);
    if (alpha <= 0.01) return null;
    return {
      topL, topR, botR, botL, alpha,
      depth: (topL.depth + topR.depth + botR.depth + botL.depth) / 4
    };
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function paintLogoCard(ctx, card, logo) {
  const { topL, topR, botR, botL } = card;
  const w = logo.naturalWidth;
  const h = logo.naturalHeight;
  if (!(w > 0) || !(h > 0)) return;
  ctx.save();
  ctx.globalAlpha *= card.alpha;
  ctx.beginPath();
  ctx.moveTo(topL.x, topL.y);
  ctx.lineTo(topR.x, topR.y);
  ctx.lineTo(botR.x, botR.y);
  ctx.lineTo(botL.x, botL.y);
  ctx.closePath();
  ctx.clip();
  const ex = topR.x - topL.x;
  const ey = topR.y - topL.y;
  const fx = botL.x - topL.x;
  const fy = botL.y - topL.y;
  ctx.transform(ex / w, ey / w, fx / h, fy / h, topL.x, topL.y);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(logo, 0, 0);
  ctx.restore();
}
