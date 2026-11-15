////////////////////////////////////////////////////////////
// chaseCam.js — pitched follow camera over the flat water plane.
// Pitch 0 and bearing -π/2 match the existing top-down camera.
////////////////////////////////////////////////////////////

/** Top-down bearing: canvas +x is screen right, canvas +y is screen down. */
export const FLAT_BEARING = -Math.PI / 2;

/** Tilt down from straight overhead, in radians (~56°). */
export const CHASE_PITCH = 56 * Math.PI / 180;

/** Where the rider sits down the screen in chase view (0 top, 1 bottom). */
export const CHASE_RIDER_SCREEN = 0.62;

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

/**
 * World pixels to put the look-at point ahead of the rider so the rider
 * lands near CHASE_RIDER_SCREEN once the pitch has arrived.
 */
export function chaseLookahead(viewH, scale, pitch) {
  if (!(pitch > 0.01) || !(viewH > 0)) return 0;
  const f = focalLength(viewH);
  const D = f / Math.max(scale, 1e-4);
  const off = (CHASE_RIDER_SCREEN - 0.5) * viewH;
  const s = Math.sin(pitch);
  const c = Math.cos(pitch);
  const denom = off * s + f * c;
  if (Math.abs(denom) < 1e-4) return 0;
  return off * D / denom;
}

export function makeCamera({ lx, ly, scale, pitch, bearing, viewW, viewH }) {
  const f = focalLength(viewH);
  const D = f / Math.max(scale, 1e-4);
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

export function viewDepth(cam, x, y) {
  const dx = x - cam.eyeX;
  const dy = y - cam.eyeY;
  const dz = -cam.eyeZ;
  return (dx * cam.fx + dy * cam.fy) * cam.sp - dz * cam.cp;
}

/** Screen point for a ground point, or null when it is behind the camera. */
export function project(cam, x, y) {
  const dx = x - cam.eyeX;
  const dy = y - cam.eyeY;
  const dz = -cam.eyeZ;
  const vx = dx * cam.rx + dy * cam.ry;
  const vu = (dx * cam.fx + dy * cam.fy) * cam.cp + dz * cam.sp;
  const vd = (dx * cam.fx + dy * cam.fy) * cam.sp - dz * cam.cp;
  if (vd < 1) return null;
  return {
    x: cam.cx + cam.f * vx / vd,
    y: cam.cy - cam.f * vu / vd,
    depth: vd
  };
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
