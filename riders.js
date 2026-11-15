////////////////////////////////////////////////////////////
// riders.js — rider presets, saved fine-tuning, and the
// mapping from those numbers onto the physics in engine.js
////////////////////////////////////////////////////////////

export const SPEED_CONVERSION = 0.6;
export const BANK_ANGLE_MAX = 55;
/** Internal units per second. × 0.6 ≈ 7.4 km/h/s, shared by every rider. */
export const DECEL_RATE = 12.333;

/** Full-lean arc at 60 km/h on the stock table (80 m at 30° × 0.90). */
const BASE_ARC_60 = 72;

const BASELINE_30 = [
  { speed: 10, radius: 10 },
  { speed: 15, radius: 15 },
  { speed: 30, radius: 30 },
  { speed: 40, radius: 65 },
  { speed: 60, radius: 80 }
];

const REDUCE = [
  { speed: 10, factor: 0.85 },
  { speed: 15, factor: 0.82 },
  { speed: 30, factor: 0.83 },
  { speed: 40, factor: 0.85 },
  { speed: 60, factor: 0.90 }
];

export const RIDER_LIMITS = {
  topKmh: { min: 45, max: 80, step: 0.5 },
  accelKmhS: { min: 2, max: 8, step: 0.1 },
  lean0: { min: 15, max: 90, step: 1 },
  lean30: { min: 5, max: 60, step: 1 },
  arc60: { min: 30, max: 140, step: 1 }
};

const TUNE_KEYS = Object.keys(RIDER_LIMITS);

/**
 * Piet stays on the slower lean. Manel, Carmine and Antti all
 * get the quick lean (60 °/s up to 30°, then 28 °/s).
 */
export const RIDERS = [
  { id: 'piet', name: 'Piet', color: '#d4a017', gloss: 'gold', topKmh: 66, accelKmhS: 5.1, lean0: 40, lean30: 10, arc60: 100 },
  { id: 'manel', name: 'Manel', color: '#e53935', gloss: 'solid', topKmh: 66, accelKmhS: 5.1, lean0: 60, lean30: 28, arc60: 50 },
  { id: 'carmine', name: 'Carmine', color: '#d5d8de', gloss: 'silver', topKmh: 66, accelKmhS: 3.3, lean0: 60, lean30: 28, arc60: 92 },
  { id: 'antti', name: 'Antti', color: '#141414', gloss: 'solid', topKmh: 60, accelKmhS: 3.3, lean0: 60, lean30: 28, arc60: 62 }
];

const STORAGE_KEY = 'efoil_rider_v1';

export function presetTune(rider) {
  const tune = {};
  for (const key of TUNE_KEYS) tune[key] = rider[key];
  return tune;
}

export function clampTune(tune) {
  const out = {};
  for (const key of TUNE_KEYS) {
    const lim = RIDER_LIMITS[key];
    let v = Number(tune && tune[key]);
    if (!Number.isFinite(v)) v = lim.min;
    v = Math.max(lim.min, Math.min(lim.max, v));
    const steps = Math.round((v - lim.min) / lim.step);
    out[key] = Math.round((lim.min + steps * lim.step) * 1000) / 1000;
  }
  return out;
}

export function riderById(id) {
  return RIDERS.find(r => r.id === id) || RIDERS[RIDERS.length - 1];
}

/** Scale only the 40 and 60 km/h rows so full lean at 60 km/h equals arc60. */
export function radiusTables(arc60) {
  const scale = arc60 / BASE_ARC_60;
  return {
    baseline: BASELINE_30.map((row, i) => (
      i >= 3 ? { speed: row.speed, radius: row.radius * scale } : { speed: row.speed, radius: row.radius }
    )),
    reduce: REDUCE.map(row => ({ speed: row.speed, factor: row.factor }))
  };
}

export function riderDynamics(tune) {
  const stats = clampTune(tune);
  const tables = radiusTables(stats.arc60);
  return {
    stats,
    maxSpeed: stats.topKmh / SPEED_CONVERSION,
    accelRate: stats.accelKmhS / SPEED_CONVERSION,
    decelRate: DECEL_RATE,
    lean0: stats.lean0,
    lean30: stats.lean30,
    baseline: tables.baseline,
    reduce: tables.reduce
  };
}

export function loadRiderState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
  const tunes = {};
  for (const rider of RIDERS) {
    tunes[rider.id] = clampTune({ ...presetTune(rider), ...(saved && saved.tunes && saved.tunes[rider.id]) });
  }
  const id = RIDERS.some(r => r.id === (saved && saved.id)) ? saved.id : 'antti';
  return { id, showLabel: !(saved && saved.showLabel === false), tunes };
}

export function saveRiderState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      id: state.id,
      showLabel: state.showLabel !== false,
      tunes: state.tunes
    }));
  } catch { /* private mode */ }
}
