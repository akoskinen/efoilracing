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
let tipCarry = 0;

// Launch `budget` droplets (keeping the fraction for next frame) from a
// cut in the water at `at`, spread along the heading over `span` metres
// from `from`. `leftOdds` is the chance a droplet goes off the left side.
function emit(budget, f, at) {
  while (budget >= 1 && spray.count < SPRAY_MAX) {
    budget -= 1;
    const i = spray.count++;
    const mist = Math.random() < 0.14;
    const along = at.from + Math.random() * at.span;
    const side = Math.random() < at.leftOdds ? -1 : 1;
    // Squaring biases towards a thin, low sheet with a few high flyers.
    const r = Math.random();
    const fwd = f.v * (0.08 + Math.random() * 0.3);
    const out = f.v * (0.03 + r * r * 0.17) * f.k * at.throwOut * side;
    const up = Math.min(3.6, f.v * (0.1 + Math.random() * 0.22)) * f.k * at.throwUp;
    spray.x[i] = at.x + (f.fx * along + f.rx * side * 0.02) * f.ppm;
    spray.y[i] = at.y + (f.fy * along + f.ry * side * 0.02) * f.ppm;
    spray.z[i] = 0.01;
    spray.vx[i] = (f.fx * fwd + f.rx * out) * f.ppm;
    spray.vy[i] = (f.fy * fwd + f.ry * out) * f.ppm;
    spray.vz[i] = mist ? up * 0.55 : up;
    spray.age[i] = 0;
    spray.life[i] = mist ? 0.35 + Math.random() * 0.35 : 0.7 + Math.random() * 0.7;
    spray.size[i] = mist ? 0.08 + Math.random() * 0.12 : 0.014 + Math.random() * 0.03;
    spray.mist[i] = mist ? 1 : 0;
  }
  return Math.min(budget, 1);
}

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
 * `tip`, when set, is a wing tip out of the water: `{ x, y, side, strength }`
 * with `side` -1 for the left tip and `strength` 0–1 for how far it is out.
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
  const speedUp = Math.max(0, Math.min(1, (kmh - 14) / 30));
  const frame = { fx, fy, rx, ry, v, k, ppm };
  const lean = src.rollRad || 0;
  carry = emit(carry + speedUp * Math.max(0, src.foil) * 2600 * dt, frame, {
    x: src.x, y: src.y,
    from: -src.chordM, span: src.chordM * 1.4,
    leftOdds: 0.5 + Math.sin(lean) * 0.35,
    throwOut: 0.4, throwUp: 1
  });
  // A wing tip out of the water cuts a smaller sheet, thrown mostly away
  // from the board.
  const tip = src.tip;
  if (tip && tip.strength > 0) {
    tipCarry = emit(tipCarry + speedUp * Math.min(1, tip.strength) * 1400 * dt, frame, {
      x: tip.x, y: tip.y,
      from: -0.05, span: 0.08,
      leftOdds: tip.side < 0 ? 0.88 : 0.12,
      throwOut: 0.55, throwUp: 0.8
    });
  } else {
    tipCarry = 0;
  }

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
  tipCarry = 0;
}
