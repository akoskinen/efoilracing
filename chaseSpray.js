////////////////////////////////////////////////////////////
// chaseSpray.js — the sheet of spray the mast throws up at speed.
//
// Droplets leave the mast at the waterline in two thin fans, one off each
// side, and fly ballistic arcs while the board runs away from them. Only
// the forward speed is true to the world; height and sideways throw use the
// craft's draw scale so the spray sits in proportion to the 2× board.
// Positions are world pixels for x/y and draw-scale metres for z.
////////////////////////////////////////////////////////////

export const SPRAY_MAX = 3200;
const GRAVITY = 9.81;
const DRAG = 1.1;

export const spray = {
  count: 0,
  x: new Float32Array(SPRAY_MAX),
  y: new Float32Array(SPRAY_MAX),
  z: new Float32Array(SPRAY_MAX),
  vx: new Float32Array(SPRAY_MAX),   // world px per second
  vy: new Float32Array(SPRAY_MAX),
  vz: new Float32Array(SPRAY_MAX),   // metres per second, draw scale
  age: new Float32Array(SPRAY_MAX),
  life: new Float32Array(SPRAY_MAX),
  size: new Float32Array(SPRAY_MAX), // metres, draw scale
  mist: new Uint8Array(SPRAY_MAX),
  // Board velocity in world px per second, for the streaks.
  boardVx: 0,
  boardVy: 0,
  ppm: 1,
  bounds: null
};

let carry = 0;

function kill(i) {
  const last = --spray.count;
  if (i === last) return;
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 'size', 'mist']) {
    spray[key][i] = spray[key][last];
  }
}

/**
 * Advance the spray by `dt` seconds. `src` is where the mast cuts the water:
 * `{ x, y }` in world pixels, `heading` (radians, world), `speedMs`,
 * `foil` (0 on the water, 1 flying), `rollRad`, `ppm` and `scale` (the
 * craft's draw scale). The mast chord runs `chordM` either side of `src`.
 */
export function stepSpray(dt, src) {
  const ppm = src.ppm;
  const k = src.scale;
  const fx = Math.cos(src.heading);
  const fy = Math.sin(src.heading);
  const rx = -fy;
  const ry = fx;
  const v = Math.max(0, src.speedMs);
  spray.ppm = ppm;
  spray.boardVx = fx * v * ppm;
  spray.boardVy = fy * v * ppm;

  const drag = Math.exp(-DRAG * dt);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = spray.count - 1; i >= 0; i--) {
    spray.age[i] += dt;
    spray.vz[i] -= GRAVITY * k * dt;
    spray.vx[i] *= drag;
    spray.vy[i] *= drag;
    spray.x[i] += spray.vx[i] * dt;
    spray.y[i] += spray.vy[i] * dt;
    spray.z[i] += spray.vz[i] * dt;
    if (spray.z[i] < 0 || spray.age[i] > spray.life[i]) kill(i);
  }

  // Spray starts once the board is flying and fills in towards top speed.
  const kmh = v * 3.6;
  const strength = Math.max(0, Math.min(1, (kmh - 14) / 30)) * Math.max(0, src.foil);
  carry += strength * 2600 * dt;
  const lean = src.rollRad || 0;
  while (carry >= 1 && spray.count < SPRAY_MAX) {
    carry -= 1;
    const i = spray.count++;
    const mist = Math.random() < 0.14;
    // Mostly off the trailing half of the chord.
    const along = -src.chordM + Math.random() * src.chordM * 1.4;
    const side = Math.random() < 0.5 + Math.sin(lean) * 0.35 ? -1 : 1;
    // Squaring biases towards a thin, low sheet with a few high flyers.
    const r = Math.random();
    const fwd = v * (0.08 + Math.random() * 0.3);
    const out = v * (0.03 + r * r * 0.17) * k * 0.4 * side;
    const up = Math.min(3.6, v * (0.1 + Math.random() * 0.22)) * k;
    spray.x[i] = src.x + fx * along * ppm + rx * side * 0.02 * ppm;
    spray.y[i] = src.y + fy * along * ppm + ry * side * 0.02 * ppm;
    spray.z[i] = 0.01;
    spray.vx[i] = (fx * fwd + rx * out) * ppm;
    spray.vy[i] = (fy * fwd + ry * out) * ppm;
    spray.vz[i] = mist ? up * 0.55 : up;
    spray.age[i] = 0;
    spray.life[i] = mist ? 0.35 + Math.random() * 0.35 : 0.7 + Math.random() * 0.7;
    spray.size[i] = mist ? 0.08 + Math.random() * 0.12 : 0.014 + Math.random() * 0.03;
    spray.mist[i] = mist ? 1 : 0;
  }
  if (carry > 1) carry = 1;

  for (let i = 0; i < spray.count; i++) {
    const z = spray.z[i] * ppm;
    if (spray.x[i] < minX) minX = spray.x[i];
    if (spray.x[i] > maxX) maxX = spray.x[i];
    if (spray.y[i] < minY) minY = spray.y[i];
    if (spray.y[i] > maxY) maxY = spray.y[i];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  spray.bounds = spray.count
    ? { minX, minY, minZ: Math.max(0, minZ), maxX, maxY, maxZ: maxZ + 0.2 * ppm }
    : null;
}

export function clearSpray() {
  spray.count = 0;
  spray.bounds = null;
  carry = 0;
}
