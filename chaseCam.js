////////////////////////////////////////////////////////////
// chaseCam.js — pitched follow camera over the flat water plane.
// Pitch 0 and bearing -π/2 match the existing top-down camera.
////////////////////////////////////////////////////////////

/** Top-down bearing: canvas +x is screen right, canvas +y is screen down. */
export const FLAT_BEARING = -Math.PI / 2;

/** Tilt at a walking pace, down from straight overhead (~56°). */
export const CHASE_PITCH = 56 * Math.PI / 180;

/**
 * Chase camera at the two speed thresholds, blended linearly between them.
 * Height is the eye above the board (which itself lifts at speed), behind
 * is measured from the middle of the board along its heading, and look-down
 * is the tilt below the horizon. The defaults are the framing the chase
 * view always had: a high wide look when slow, 15 m back when fast.
 */
export const CHASE_DEFAULTS = Object.freeze({
  slowKmh: 10,
  fastKmh: 45,
  slowHeightM: 80,
  slowBehindM: 90,
  slowLookDownDeg: 34,
  fastHeightM: 8.4,
  fastBehindM: 15,
  fastLookDownDeg: 17
});

/** Eye on the middle of the board, crouched at 1.5 m. */
export const CHASE_FIRST_PERSON = Object.freeze({
  fastHeightM: 1.5,
  fastBehindM: 0,
  fastLookDownDeg: 14
});

export const CHASE_LIMITS = Object.freeze({
  kmh: [0, 80],
  heightM: [0.3, 150],
  behindM: [0, 150],
  lookDownDeg: [2, 89]
});

const clampTo = (v, [lo, hi], fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function clampChaseSettings(raw) {
  const d = CHASE_DEFAULTS;
  const L = CHASE_LIMITS;
  const s = raw || {};
  const out = {
    slowKmh: clampTo(s.slowKmh, L.kmh, d.slowKmh),
    fastKmh: clampTo(s.fastKmh, L.kmh, d.fastKmh),
    slowHeightM: clampTo(s.slowHeightM, L.heightM, d.slowHeightM),
    slowBehindM: clampTo(s.slowBehindM, L.behindM, d.slowBehindM),
    slowLookDownDeg: clampTo(s.slowLookDownDeg, L.lookDownDeg, d.slowLookDownDeg),
    fastHeightM: clampTo(s.fastHeightM, L.heightM, d.fastHeightM),
    fastBehindM: clampTo(s.fastBehindM, L.behindM, d.fastBehindM),
    fastLookDownDeg: clampTo(s.fastLookDownDeg, L.lookDownDeg, d.fastLookDownDeg)
  };
  if (out.fastKmh < out.slowKmh + 1) out.fastKmh = Math.min(L.kmh[1], out.slowKmh + 1);
  if (out.fastKmh < out.slowKmh + 1) out.slowKmh = out.fastKmh - 1;
  return out;
}

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

/** 0 at or below the slow threshold, 1 at or above the fast one. */
export function chaseSpeedBlend(kmh, settings = CHASE_DEFAULTS) {
  const lo = settings.slowKmh;
  const hi = settings.fastKmh;
  if (!(kmh > lo)) return 0;
  if (kmh >= hi) return 1;
  return (kmh - lo) / (hi - lo);
}

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

/**
 * Pitch, ray distance and look-ahead (world pixels) that put the eye
 * `behind` meters back from the board's middle and `height` meters above
 * it. `liftM` is how high the board rides above the water.
 */
export function chaseFraming(kmh, ppm, settings = CHASE_DEFAULTS, liftM = 0) {
  const t = chaseSpeedBlend(kmh, settings);
  const mix = (a, b) => a + (b - a) * t;
  const heightM = mix(settings.slowHeightM, settings.fastHeightM);
  const behindM = mix(settings.slowBehindM, settings.fastBehindM);
  const lookDown = mix(settings.slowLookDownDeg, settings.fastLookDownDeg);
  const k = Math.max(ppm, 0.25);
  const pitch = (90 - lookDown) * Math.PI / 180;
  const eyeZ = (heightM + Math.max(0, liftM)) * k;
  const distance = eyeZ / Math.cos(pitch);
  return {
    pitch,
    distance,
    ahead: distance * Math.sin(pitch) - behindM * k,
    blend: t,
    behindM
  };
}

/**
 * `roll` tilts the eye about its view axis in radians. Positive drops the
 * right ear, so the horizon rises on the right of the screen.
 */
export function makeCamera({ lx, ly, scale, pitch, bearing, viewW, viewH, distance, roll = 0 }) {
  const f = focalLength(viewH);
  const D = distance > 0 ? distance : f / Math.max(scale, 1e-4);
  const fx = Math.cos(bearing);
  const fy = Math.sin(bearing);
  const rx = -fy;
  const ry = fx;
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ux = fx * cp;
  const uy = fy * cp;
  const uz = sp;
  return {
    lx, ly, scale, pitch, bearing, roll, f, D,
    viewW, viewH,
    cx: viewW / 2,
    cy: viewH / 2,
    fx, fy, rx, ry, sp, cp,
    // Screen right and screen up in world space, after the roll.
    r3: [rx * cr - ux * sr, ry * cr - uy * sr, -uz * sr],
    u3: [ux * cr + rx * sr, uy * cr + ry * sr, uz * cr],
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
  const r = cam.r3;
  const u = cam.u3;
  return {
    vx: dx * r[0] + dy * r[1] + dz * r[2],
    vu: dx * u[0] + dy * u[1] + dz * u[2],
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
  const vu = cam.cy - sy;
  const r = cam.r3;
  const u = cam.u3;
  const f = cam.f;
  const dirX = r[0] * vx + u[0] * vu + cam.fx * cam.sp * f;
  const dirY = r[1] * vx + u[1] * vu + cam.fy * cam.sp * f;
  const dirZ = r[2] * vx + u[2] * vu - cam.cp * f;
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
