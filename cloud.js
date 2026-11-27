////////////////////////////////////////////////////////////
// cloud.js — the leaderboard and track board on Cloudflare.
//
// Reads are public. Writes send the token from localStorage
// `efoil_cloud_token` when `efoil_cloud_url` (or CLOUD_URL) is set.
// With no URL the sim keeps its own laps on this device.
////////////////////////////////////////////////////////////

export const CLOUD_URL = '';
export const SIM_BRAND = 'Lift Foils';
export const SIM_BOARD = 'Lift X';

export function cloudBase() {
  let over = '';
  try { over = localStorage.getItem('efoil_cloud_url') || ''; } catch {}
  return (over || CLOUD_URL || '').replace(/\/$/, '');
}

function authHeaders() {
  let token = '';
  try { token = localStorage.getItem('efoil_cloud_token') || ''; } catch {}
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function cloudFetch(path, options) {
  const base = cloudBase();
  if (!base) return null;
  const res = await fetch(base + path, {
    ...options,
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const err = new Error('cloud ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Monday 00:00 local, 1 January local, or local midnight. All time has no start. */
export function periodStart(period, now = new Date()) {
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }
  if (period === 'season') return new Date(now.getFullYear(), 0, 1);
  return null;
}

export function normalizeLap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const time = Number(raw.time ?? raw.time_s);
  if (!Number.isFinite(time) || time <= 0) return null;
  const dateValue = raw.date || raw.riddenAt || raw.ridden_at || '';
  const date = dateValue instanceof Date ? dateValue.toISOString() : String(dateValue || '');
  const ghost = Array.isArray(raw.ghostData) ? raw.ghostData : null;
  const nickname = String(raw.nickname || 'RIDER').trim().slice(0, 24) || 'RIDER';
  const id = String(raw.id || `local:${date}:${time}:${nickname}`);
  return {
    id,
    nickname,
    time,
    distance: Number(raw.distance ?? raw.distance_m) || 0,
    date,
    kind: raw.kind === 'real' ? 'real' : 'sim',
    brand: String(raw.brand || SIM_BRAND).slice(0, 40),
    board: String(raw.board || SIM_BOARD).slice(0, 40),
    riderName: String(raw.riderName || raw.rider_name || ''),
    ghostData: ghost,
    hasGhost: !!(raw.hasGhost || raw.has_ghost || (ghost && ghost.length > 1))
  };
}

export function lapMatches(lap, filters, now = new Date()) {
  if (filters.kind && filters.kind !== 'all' && lap.kind !== filters.kind) return false;
  if (filters.brand && filters.brand !== 'all' && lap.brand !== filters.brand) return false;
  const start = periodStart(filters.period, now);
  if (!start) return true;
  const ridden = new Date(lap.date);
  return !Number.isNaN(ridden.getTime()) && ridden >= start;
}

export async function fetchLaps(trackKey, filters = {}) {
  const q = new URLSearchParams({ track: trackKey });
  if (filters.kind && filters.kind !== 'all') q.set('kind', filters.kind);
  if (filters.brand && filters.brand !== 'all') q.set('brand', filters.brand);
  const start = periodStart(filters.period);
  if (start) q.set('from', start.toISOString());
  const data = await cloudFetch('/laps?' + q.toString());
  if (!data) return { laps: [], brands: [] };
  return {
    laps: (data.laps || []).map(normalizeLap).filter(Boolean),
    brands: Array.isArray(data.brands) ? data.brands.map(b => String(b)) : []
  };
}

export async function fetchLap(id) {
  const data = await cloudFetch('/laps/' + encodeURIComponent(id));
  return data ? normalizeLap(data.lap || data) : null;
}

export async function postLap(lap) {
  const base = cloudBase();
  if (!base) return { ok: false, skipped: true };
  const res = await fetch(base + '/laps', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(lap),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true };
}

export async function fetchTracks() {
  const data = await cloudFetch('/tracks');
  return data ? data.tracks || [] : [];
}

export async function fetchTrack(key) {
  const data = await cloudFetch('/tracks/' + encodeURIComponent(key));
  return data ? data.track || null : null;
}

export async function putTrack(key, track) {
  const base = cloudBase();
  if (!base) return { ok: false, skipped: true };
  const res = await fetch(base + '/tracks/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(track),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true };
}
