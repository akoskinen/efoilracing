////////////////////////////////////////////////////////////
// inflatableBuoy.js — white three-sided race buoy for the chase camera.
// 1.5 m tall. Each panel bows out between the seams, like inflated vinyl.
// The SFT mark is a transparent navy plate; the vinyl shows through the
// letters. Overhead views keep the flat disc.
////////////////////////////////////////////////////////////

import { depthAt, projectClipped, projectHeight } from './chaseCam.js';

export const INFLATABLE_HEIGHT_M = 1.5;
export const INFLATABLE_SIDE_M = 2;
/** How far the middle of a panel leaves the flat triangle, in meters. */
export const INFLATABLE_BULGE_M = 0.34;
const PANEL_DIVS = 16;

const LIGHT = normalize({ x: 0.35, y: 0.5, z: 0.79 });

let sftLogo = null;
const tintCache = new Map();

export function sftLogoImage() {
  if (!sftLogo && typeof Image !== 'undefined') {
    sftLogo = new Image();
    sftLogo.decoding = 'async';
    sftLogo.src = new URL('./assets/buoy/sft.png', import.meta.url).href;
  }
  return sftLogo;
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalize(v) {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

function addScaled(p, dir, s) {
  return { x: p.x + dir.x * s, y: p.y + dir.y * s, z: p.z + dir.z * s };
}

/** Three-sided buoy. `facing` is the direction one face looks, in world radians. */
export function inflatableFrame(x, y, facing, ppm) {
  const height = INFLATABLE_HEIGHT_M * ppm;
  const side = INFLATABLE_SIDE_M * ppm;
  const radius = side / Math.sqrt(3);
  const corners = [];
  for (let k = 0; k < 3; k++) {
    const a = facing - Math.PI / 3 + k * (2 * Math.PI / 3);
    corners.push({
      x: x + Math.cos(a) * radius,
      y: y + Math.sin(a) * radius,
      z: 0
    });
  }
  return {
    apex: { x, y, z: height },
    corners,
    side,
    height,
    radius,
    bulge: INFLATABLE_BULGE_M * ppm
  };
}

function outward(apex, b, c) {
  return {
    x: (b.x + c.x) / 2 - apex.x,
    y: (b.y + c.y) / 2 - apex.y,
    z: 0
  };
}

export function faceNormal(apex, b, c) {
  let n = cross(sub(b, apex), sub(c, apex));
  if (dot(n, outward(apex, b, c)) < 0) n = { x: -n.x, y: -n.y, z: -n.z };
  return normalize(n);
}

/**
 * A point on a bowed panel. Barycentric weights aw/bw/cw sum to 1
 * (apex, base left, base right). The bow is zero on every seam.
 */
export function curvedFacePoint(apex, b, c, aw, bw, cw, amp, normal) {
  const flat = {
    x: aw * apex.x + bw * b.x + cw * c.x,
    y: aw * apex.y + bw * b.y + cw * c.y,
    z: aw * apex.z + bw * b.z + cw * c.z
  };
  const pillow = Math.pow(Math.max(0, 27 * aw * bw * cw), 0.42);
  return addScaled(flat, normal, pillow * amp);
}

/**
 * Logo rectangle on one face, largest size that stays inside the triangle.
 * Returns TL, TR, BR, BL in world pixels, or null.
 */
export function logoQuadOnFace(apex, baseL, baseR, aspect) {
  const mid = {
    x: (baseL.x + baseR.x) / 2,
    y: (baseL.y + baseR.y) / 2,
    z: (baseL.z + baseR.z) / 2
  };
  const edge = sub(baseR, baseL);
  const side = Math.hypot(edge.x, edge.y, edge.z);
  const toApex = sub(apex, mid);
  const slant = Math.hypot(toApex.x, toApex.y, toApex.z);
  if (!(side > 0) || !(slant > 0) || !(aspect > 0)) return null;
  const up = { x: toApex.x / slant, y: toApex.y / slant, z: toApex.z / slant };
  // Outside the face, left-to-right follows the viewer's right so the mark is not mirrored.
  const out = outward(apex, baseL, baseR);
  let right = cross(out, up);
  const rm = Math.hypot(right.x, right.y, right.z);
  if (!(rm > 1e-6)) right = { x: edge.x / side, y: edge.y / side, z: edge.z / side };
  else right = { x: right.x / rm, y: right.y / rm, z: right.z / rm };

  const pad = 0.1;
  let chosen = null;
  for (let i = 92; i >= 30; i--) {
    const w = side * (i / 100);
    const h = w / aspect;
    const bottom = slant * 0.9;
    const top = bottom - h;
    if (top < slant * 0.2) continue;
    const halfTop = (top / slant) * (side / 2) * (1 - pad);
    const halfBot = (bottom / slant) * (side / 2) * (1 - pad);
    if (w / 2 > halfTop || w / 2 > halfBot) continue;
    chosen = { w, h, top, bottom };
    break;
  }
  if (!chosen) return null;

  const centerS = (chosen.top + chosen.bottom) / 2;
  const center = addScaled(apex, { x: -up.x, y: -up.y, z: -up.z }, centerS);
  const hw = chosen.w / 2;
  const hh = chosen.h / 2;
  const tl = {
    x: center.x - right.x * hw + up.x * hh,
    y: center.y - right.y * hw + up.y * hh,
    z: center.z - right.z * hw + up.z * hh
  };
  const tr = {
    x: center.x + right.x * hw + up.x * hh,
    y: center.y + right.y * hw + up.y * hh,
    z: center.z + right.z * hw + up.z * hh
  };
  const br = {
    x: center.x + right.x * hw - up.x * hh,
    y: center.y + right.y * hw - up.y * hh,
    z: center.z + right.z * hw - up.z * hh
  };
  const bl = {
    x: center.x - right.x * hw - up.x * hh,
    y: center.y - right.y * hw - up.y * hh,
    z: center.z - right.z * hw - up.z * hh
  };
  return [tl, tr, br, bl];
}

function triangleAt(x, y, facing, radius) {
  const pts = [];
  for (let k = 0; k < 3; k++) {
    const a = facing - Math.PI / 3 + k * (2 * Math.PI / 3);
    pts.push({ x: x + Math.cos(a) * radius, y: y + Math.sin(a) * radius, z: 0 });
  }
  return pts;
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

function vinyl(shade) {
  const v = Math.round(255 * Math.max(0, Math.min(1, shade)));
  return `rgb(${v},${v},${v})`;
}

function drawTriangleImage(ctx, img, s0, s1, s2, d0, d1, d2) {
  const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denom) < 1e-4) return;
  const map = (dx0, dx1, dx2) => (
    dx0 * (s1.y - s2.y) + dx1 * (s2.y - s0.y) + dx2 * (s0.y - s1.y)
  ) / denom;
  const mapE = (dx0, dx1, dx2) => (
    dx0 * (s1.x * s2.y - s2.x * s1.y) +
    dx1 * (s2.x * s0.y - s0.x * s2.y) +
    dx2 * (s0.x * s1.y - s1.x * s0.y)
  ) / denom;
  const a = map(d0.x, d1.x, d2.x);
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
  const e = mapE(d0.x, d1.x, d2.x);
  const b = map(d0.y, d1.y, d2.y);
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
  const f = mapE(d0.y, d1.y, d2.y);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function bilinear(quad, u, v) {
  const tl = quad[0];
  const tr = quad[1];
  const br = quad[2];
  const bl = quad[3];
  const x = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
  const y = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
  const z = (1 - u) * (1 - v) * tl.z + u * (1 - v) * tr.z + u * v * br.z + (1 - u) * v * bl.z;
  return { x, y, z };
}

function tintedLogo(img, shade) {
  const key = Math.round(Math.max(0, Math.min(1, shade)) * 24);
  const hit = tintCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, c.width, c.height);
  const s = key / 24;
  const data = im.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] *= s;
    data[i + 1] *= s;
    data[i + 2] *= s;
  }
  g.putImageData(im, 0, 0);
  tintCache.set(key, c);
  return c;
}

function drawLogo(ctx, cam, img, shade, quad, place) {
  if (!img || !img.complete || !img.naturalWidth) return;
  const cols = 6;
  const rows = 3;
  const grid = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const flat = bilinear(quad, i / cols, j / rows);
      const p = place ? place(flat) : flat;
      const s = projectHeight(cam, p.x, p.y, p.z);
      if (!s) return;
      grid.push(s);
    }
  }
  const paint = tintedLogo(img, shade);
  const w = img.width;
  const h = img.height;
  const at = (i, j) => grid[j * (cols + 1) + i];
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u0 = (i / cols) * w;
      const u1 = ((i + 1) / cols) * w;
      const v0 = (j / rows) * h;
      const v1 = ((j + 1) / rows) * h;
      const d00 = at(i, j);
      const d10 = at(i + 1, j);
      const d11 = at(i + 1, j + 1);
      const d01 = at(i, j + 1);
      drawTriangleImage(ctx, paint, { x: u0, y: v0 }, { x: u1, y: v0 }, { x: u1, y: v1 }, d00, d10, d11);
      drawTriangleImage(ctx, paint, { x: u0, y: v0 }, { x: u1, y: v1 }, { x: u0, y: v1 }, d00, d11, d01);
    }
  }
  ctx.restore();
}

function smoothNormal(apex, b, c, faceN, amp, aw, bw, cw) {
  const eps = 0.04;
  const at = (aa, bb, cc) => {
    const sum = Math.max(1e-6, aa + bb + cc);
    return curvedFacePoint(
      apex, b, c,
      Math.max(0, aa) / sum,
      Math.max(0, bb) / sum,
      Math.max(0, cc) / sum,
      amp, faceN
    );
  };
  const p = at(aw, bw, cw);
  const du = sub(at(aw, bw + eps, cw), p);
  const dv = sub(at(aw, bw, cw + eps), p);
  let n = cross(du, dv);
  if (dot(n, faceN) < 0) n = { x: -n.x, y: -n.y, z: -n.z };
  const m = Math.hypot(n.x, n.y, n.z);
  if (!(m > 1e-5)) return faceN;
  return { x: n.x / m, y: n.y / m, z: n.z / m };
}

function shadeAmount(n) {
  const nd = Math.max(0, dot(n, LIGHT));
  return Math.min(1, 0.76 + 0.2 * nd + Math.pow(nd, 16) * 0.14);
}

function circlePoints(x, y, radius) {
  const pts = [];
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: x + Math.cos(a) * radius, y: y + Math.sin(a) * radius, z: 0 });
  }
  return pts;
}

/**
 * Draw one chase-view buoy. `paint` is the pass-side color used as the
 * waterline ring. `facing` aims one face toward the course.
 */
export function drawInflatableBuoy(ctx, cam, { x, y, ppm, paint, facing, logo }) {
  const frame = inflatableFrame(x, y, facing || 0, ppm);
  const shadow = projectClipped(cam, circlePoints(x, y, frame.radius * 0.72));
  fillPoly(ctx, shadow, 'rgba(0,0,0,0.28)');
  const aim = facing || 0;
  fillPoly(ctx, projectClipped(cam, triangleAt(x, y, aim, frame.radius + 0.26 * ppm)), paint.stroke);
  fillPoly(ctx, projectClipped(cam, triangleAt(x, y, aim, frame.radius + 0.1 * ppm)), paint.fill);

  const faces = frame.corners.map((corner, k) => {
    const b = corner;
    const c = frame.corners[(k + 1) % 3];
    const normal = faceNormal(frame.apex, b, c);
    const centroid = curvedFacePoint(frame.apex, b, c, 1 / 3, 1 / 3, 1 / 3, frame.bulge, normal);
    return { b, c, normal, centroid, depth: depthAt(cam, centroid.x, centroid.y, centroid.z) };
  });
  faces.sort((a, b) => b.depth - a.depth);

  const logoReady = logo && logo.complete && logo.naturalWidth > 0;
  const aspect = logoReady ? logo.naturalWidth / logo.naturalHeight : 0;
  const panels = [];

  for (const face of faces) {
    const toEye = {
      x: cam.eyeX - face.centroid.x,
      y: cam.eyeY - face.centroid.y,
      z: cam.eyeZ - face.centroid.z
    };
    if (dot(face.normal, toEye) <= 0.02) continue;
    const grid = [];
    for (let r = 0; r <= PANEL_DIVS; r++) {
      const row = [];
      for (let c = 0; c <= r; c++) {
        const t = r / PANEL_DIVS;
        const s = r === 0 ? 0 : c / r;
        const aw = 1 - t;
        const bw = t * (1 - s);
        const cw = t * s;
        const p = curvedFacePoint(frame.apex, face.b, face.c, aw, bw, cw, frame.bulge, face.normal);
        const shade = shadeAmount(smoothNormal(
          frame.apex, face.b, face.c, face.normal, frame.bulge, aw, bw, cw
        ));
        row.push({ p, aw, bw, cw, shade });
      }
      grid.push(row);
    }
    const tris = [];
    for (let r = 0; r < PANEL_DIVS; r++) {
      for (let c = 0; c <= r; c++) {
        const p0 = grid[r][c];
        const p1 = grid[r + 1][c];
        const p2 = grid[r + 1][c + 1];
        tris.push([p0, p1, p2]);
        if (c < r) tris.push([p0, p2, grid[r][c + 1]]);
      }
    }
    panels.push({ face, toEye, grid, tris });
  }

  const pieces = [];
  for (const panel of panels) {
    for (const tri of panel.tris) {
      const cx = (tri[0].p.x + tri[1].p.x + tri[2].p.x) / 3;
      const cy = (tri[0].p.y + tri[1].p.y + tri[2].p.y) / 3;
      const cz = (tri[0].p.z + tri[1].p.z + tri[2].p.z) / 3;
      pieces.push({ tri, depth: depthAt(cam, cx, cy, cz) });
    }
  }
  pieces.sort((a, b) => b.depth - a.depth);
  for (const piece of pieces) {
    const screen = [];
    let hidden = false;
    for (const v of piece.tri) {
      const s = projectHeight(cam, v.p.x, v.p.y, v.p.z);
      if (!s) { hidden = true; break; }
      screen.push(s);
    }
    if (hidden) continue;
    const shade = (piece.tri[0].shade + piece.tri[1].shade + piece.tri[2].shade) / 3;
    const color = vinyl(shade);
    fillPoly(ctx, screen, color);
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  for (const panel of panels) {
    const facingCam = dot(panel.face.normal, normalize(panel.toEye));
    if (!(logoReady && facingCam > 0.42)) continue;
    const quad = logoQuadOnFace(frame.apex, panel.face.b, panel.face.c, aspect);
    if (!quad) continue;
    const nd = Math.max(0, dot(panel.face.normal, LIGHT));
    const shade = Math.min(1, 0.78 + 0.22 * nd);
    drawLogo(ctx, cam, logo, shade, quad, (flat) => {
      const v0 = sub(panel.face.b, frame.apex);
      const v1 = sub(panel.face.c, frame.apex);
      const v2 = sub(flat, frame.apex);
      const d00 = dot(v0, v0);
      const d01 = dot(v0, v1);
      const d11 = dot(v1, v1);
      const d02 = dot(v0, v2);
      const d12 = dot(v1, v2);
      const inv = 1 / (d00 * d11 - d01 * d01);
      let bw = (d11 * d02 - d01 * d12) * inv;
      let cw = (d00 * d12 - d01 * d02) * inv;
      let aw = 1 - bw - cw;
      aw = Math.max(0, aw);
      bw = Math.max(0, bw);
      cw = Math.max(0, cw);
      const sum = aw + bw + cw || 1;
      return curvedFacePoint(
        frame.apex, panel.face.b, panel.face.c,
        aw / sum, bw / sum, cw / sum,
        frame.bulge, panel.face.normal
      );
    });
  }

  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(40, 52, 64, 0.55)';
  ctx.lineJoin = 'round';
  for (const panel of panels) {
    const edge = (from, to) => {
      const steps = 1;
      const poly = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          z: from.z + (to.z - from.z) * t
        };
        const s = projectHeight(cam, p.x, p.y, p.z);
        if (s) poly.push(s);
      }
      if (poly.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.stroke();
    };
    edge(frame.apex, panel.face.b);
    edge(frame.apex, panel.face.c);
    edge(panel.face.b, panel.face.c);
  }
  ctx.restore();
}
