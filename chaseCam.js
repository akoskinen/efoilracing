////////////////////////////////////////////////////////////
// chaseCam.js — pitched follow camera over the flat water plane.
// Pitch 0 and bearing -π/2 match the existing top-down camera.
////////////////////////////////////////////////////////////

/** Top-down bearing: canvas +x is screen right, canvas +y is screen down. */
export const FLAT_BEARING = -Math.PI / 2;

/** Tilt at a walking pace, down from straight overhead (~56°). */
export const CHASE_PITCH = 56 * Math.PI / 180;

/** Tilt once up to speed: lower and more forward, a third-person view. */
export const CHASE_PITCH_FAST = 73 * Math.PI / 180;

/** Where the rider sits down the screen (0 top, 1 bottom). */
export const CHASE_RIDER_SCREEN = 0.62;
const CHASE_RIDER_SCREEN_FAST = 0.72;

const CHASE_SLOW_KMH = 10;
const CHASE_FAST_KMH = 45;
const CHASE_FAST_BEHIND_M = 15;

export function focalLength(viewH) {
  return 0.9 * Math.max(viewH, 1);
}

export function angleDelta(from, to) {
  let d = to - from;
  const pi2 = Math.PI * 2;
  while (d > Math.PI) d -= pi2;
  while (d < -Math.PI) d += pi2;
  return d;
}

export function easeAngle(current, target, dt, tau) {
  const a = 1 - Math.exp(-dt / Math.max(tau, 1e-4));
  return current + angleDelta(current, target) * a;
}

export function isFlatView(pitch, bearing) {
  return Math.abs(pitch) < 0.004 && Math.abs(angleDelta(bearing, FLAT_BEARING)) < 0.004;
}

/** 0 at or below 10 km/h, 1 at or above 45 km/h. */
export function chaseSpeedBlend(kmh) {
  if (!(kmh > CHASE_SLOW_KMH)) return 0;
  if (kmh >= CHASE_FAST_KMH) return 1;
  return (kmh - CHASE_SLOW_KMH) / (CHASE_FAST_KMH - CHASE_SLOW_KMH);
}

/**
 * World pixels to put the look-at point ahead of the rider so the rider
 * lands near `riderScreen` for this pitch and camera distance.
 */
export function chaseLookahead(viewH, scale, pitch, distance, riderScreen = CHASE_RIDER_SCREEN) {
  if (!(pitch > 0.01) || !(viewH > 0)) return 0;
  const f = focalLength(viewH);
  const D = distance > 0 ? distance : f / Math.max(scale, 1e-4);
  const off = (riderScreen - 0.5) * viewH;
  const s = Math.sin(pitch);
  const c = Math.cos(pitch);
  const denom = off * s + f * c;
  if (Math.abs(denom) < 1e-4) return 0;
  return off * D / denom;
}

/**
 * Ray distance that puts the camera `behindPx` world pixels behind the rider
 * at this pitch, with the rider at `riderScreen`.
 */
export function distanceForBehind(viewH, pitch, behindPx, riderScreen) {
  const f = focalLength(viewH);
  const off = (riderScreen - 0.5) * viewH;
  const s = Math.sin(pitch);
  const c = Math.cos(pitch);
  const denom = off * s + f * c;
  const numer = c * (f * s - off * c);
  if (!(numer > 1) || !(denom > 1)) return f / Math.max(c, 0.2);
  return behindPx * denom / numer;
}

/**
 * Slow (≤10 km/h) keeps the wide 56° chase. By 45 km/h the camera is 15 m
 * behind the board and tilted further forward.
 */
/**
 * Grow a tile index rectangle so a pitched view can see past the flat
 * viewport. The original indices always stay, and the zoom level is never
 * changed here — a wider view must not swap in a coarser tile set.
 */
export function expandTileIndexRange(range, extras, { pad = 2, cap = 150 } = {}) {
  const baseCount = (range.tx1 - range.tx0 + 1) * (range.ty1 - range.ty0 + 1);
  let tx0 = range.tx0 - pad;
  let tx1 = range.tx1 + pad;
  let ty0 = range.ty0 - pad;
  let ty1 = range.ty1 + pad;
  for (const e of extras || []) {
    if (!Number.isFinite(e.tx) || !Number.isFinite(e.ty)) continue;
    const tx = Math.floor(e.tx);
    const ty = Math.floor(e.ty);
    if (tx < tx0) tx0 = tx;
    if (tx > tx1) tx1 = tx;
    if (ty < ty0) ty0 = ty;
    if (ty > ty1) ty1 = ty;
  }
  const limit = Math.max(baseCount, cap);
  while ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > limit) {
    const growL = range.tx0 - tx0;
    const growR = tx1 - range.tx1;
    const growT = range.ty0 - ty0;
    const growB = ty1 - range.ty1;
    const m = Math.max(growL, growR, growT, growB);
    if (m <= 0) break;
    if (m === growL) tx0 += 1;
    else if (m === growR) tx1 -= 1;
    else if (m === growT) ty0 += 1;
    else ty1 -= 1;
  }
  return { z: range.z, tx0, tx1, ty0, ty1 };
}

export function chaseFraming(kmh, viewH, scale, ppm) {
  const t = chaseSpeedBlend(kmh);
  const pitch = CHASE_PITCH + (CHASE_PITCH_FAST - CHASE_PITCH) * t;
  const f = focalLength(viewH);
  const slowD = f / Math.max(scale, 1e-4);
  const fastD = distanceForBehind(
    viewH, CHASE_PITCH_FAST, CHASE_FAST_BEHIND_M * Math.max(ppm, 0.25), CHASE_RIDER_SCREEN_FAST
  );
  const distance = slowD + (fastD - slowD) * t;
  const riderScreen = CHASE_RIDER_SCREEN + (CHASE_RIDER_SCREEN_FAST - CHASE_RIDER_SCREEN) * t;
  return {
    pitch,
    distance,
    ahead: chaseLookahead(viewH, scale, pitch, distance, riderScreen),
    blend: t,
    riderScreen
  };
}

export function makeCamera({ lx, ly, scale, pitch, bearing, viewW, viewH, distance }) {
  const f = focalLength(viewH);
  const D = distance > 0 ? distance : f / Math.max(scale, 1e-4);
  const fx = Math.cos(bearing);
  const fy = Math.sin(bearing);
  const rx = -fy;
  const ry = fx;
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  return {
    lx, ly, scale, pitch, bearing, f, D,
    viewW, viewH,
    cx: viewW / 2,
    cy: viewH / 2,
    fx, fy, rx, ry, sp, cp,
    eyeX: lx - fx * (D * sp),
    eyeY: ly - fy * (D * sp),
    eyeZ: D * cp
  };
}

function viewRay(cam, x, y, z) {
  const dx = x - cam.eyeX;
  const dy = y - cam.eyeY;
  const dz = z - cam.eyeZ;
  const along = dx * cam.fx + dy * cam.fy;
  return {
    vx: dx * cam.rx + dy * cam.ry,
    vu: along * cam.cp + dz * cam.sp,
    vd: along * cam.sp - dz * cam.cp
  };
}

export function viewDepth(cam, x, y) {
  return viewRay(cam, x, y, 0).vd;
}

/** Distance in front of the camera for a point at height z (world pixels, up). */
export function depthAt(cam, x, y, z) {
  return viewRay(cam, x, y, z).vd;
}

function screenPoint(cam, ray) {
  if (ray.vd < 1) return null;
  return {
    x: cam.cx + cam.f * ray.vx / ray.vd,
    y: cam.cy - cam.f * ray.vu / ray.vd,
    depth: ray.vd
  };
}

/** Screen point for a ground point, or null when it is behind the camera. */
export function project(cam, x, y) {
  return screenPoint(cam, viewRay(cam, x, y, 0));
}

/** Screen point for a point at height z (world pixels above the water). */
export function projectHeight(cam, x, y, z) {
  return screenPoint(cam, viewRay(cam, x, y, z));
}

/**
 * Project a polygon that may cross the near plane. Points are
 * `{ x, y, z }` in world pixels. Returns screen points, or null.
 */
export function projectClipped(cam, points, near = 1.25) {
  const rays = points.map(p => viewRay(cam, p.x, p.y, p.z || 0));
  const clipped = [];
  for (let i = 0; i < rays.length; i++) {
    const a = rays[i];
    const b = rays[(i + 1) % rays.length];
    const aIn = a.vd >= near;
    const bIn = b.vd >= near;
    const hit = () => {
      const t = (near - a.vd) / (b.vd - a.vd);
      return {
        vx: a.vx + (b.vx - a.vx) * t,
        vu: a.vu + (b.vu - a.vu) * t,
        vd: near
      };
    };
    if (aIn && bIn) clipped.push(b);
    else if (aIn && !bIn) clipped.push(hit());
    else if (!aIn && bIn) {
      clipped.push(hit());
      clipped.push(b);
    }
  }
  if (clipped.length < 3) return null;
  return clipped.map(r => ({
    x: cam.cx + cam.f * r.vx / r.vd,
    y: cam.cy - cam.f * r.vu / r.vd,
    depth: r.vd
  }));
}

/**
 * Ground point under a screen pixel. Rays that miss the water (above the
 * horizon) are clamped to maxDist world pixels from the look-at point.
 */
export function unproject(cam, sx, sy, maxDist) {
  const vx = sx - cam.cx;
  const vy = sy - cam.cy;
  const upScale = -vy;
  const fwdScale = cam.f;
  const dirX = cam.rx * vx + cam.fx * (cam.cp * upScale + cam.sp * fwdScale);
  const dirY = cam.ry * vx + cam.fy * (cam.cp * upScale + cam.sp * fwdScale);
  const dirZ = cam.sp * upScale - cam.cp * fwdScale;
  const reach = maxDist > 0 ? maxDist : cam.D * 30;
  let x;
  let y;
  if (Math.abs(dirZ) > 1e-8) {
    const t = -cam.eyeZ / dirZ;
    if (t > 0) {
      x = cam.eyeX + t * dirX;
      y = cam.eyeY + t * dirY;
    }
  }
  if (x == null) {
    const hl = Math.hypot(dirX, dirY);
    if (hl < 1e-8) return { x: cam.lx, y: cam.ly };
    x = cam.eyeX + dirX / hl * reach;
    y = cam.eyeY + dirY / hl * reach;
  }
  const dx = x - cam.lx;
  const dy = y - cam.ly;
  const dist = Math.hypot(dx, dy);
  if (dist > reach) {
    x = cam.lx + dx / dist * reach;
    y = cam.ly + dy / dist * reach;
  }
  return { x, y };
}
