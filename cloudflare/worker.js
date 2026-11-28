////////////////////////////////////////////////////////////
// eFoil Racing board: laps and tracks on Cloudflare D1.
//
// GET  /tracks
// GET  /tracks/:key
// PUT  /tracks/:key          Authorization: Bearer $WRITE_TOKEN
// GET  /laps?track=&kind=&brand=&from=
// GET  /laps/:id             includes the ghost, when one was stored
// POST /laps                 public. A repeat of the same id is ignored.
////////////////////////////////////////////////////////////

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });
}

function canWrite(request, env) {
  const token = env.WRITE_TOKEN || '';
  if (!token) return false;
  return request.headers.get('authorization') === `Bearer ${token}`;
}

function validKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(key);
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{8,80}$/.test(id);
}

function lapRow(row, withGhost) {
  const lap = {
    id: row.id,
    trackKey: row.track_key,
    nickname: row.nickname,
    time: row.time_s,
    distance: row.distance_m || 0,
    date: row.ridden_at,
    kind: row.kind,
    brand: row.brand,
    board: row.board,
    riderName: row.rider_name || '',
    hasGhost: !!(row.ghost_json || row.has_ghost)
  };
  if (withGhost && row.ghost_json) {
    try { lap.ghostData = JSON.parse(row.ghost_json); } catch { lap.ghostData = null; }
  }
  return lap;
}

function cleanLap(body) {
  const time = Number(body.time);
  const nickname = String(body.nickname || '').trim().slice(0, 24);
  const kind = body.kind === 'real' ? 'real' : body.kind === 'sim' ? 'sim' : '';
  const date = new Date(body.date || Date.now());
  if (!validId(body.id)) return { error: 'bad id' };
  if (!validKey(body.trackKey)) return { error: 'bad track' };
  if (!nickname) return { error: 'name required' };
  if (!kind) return { error: 'kind must be real or sim' };
  if (!Number.isFinite(time) || time <= 0 || time > 6 * 3600) return { error: 'bad time' };
  if (Number.isNaN(date.getTime())) return { error: 'bad date' };
  const brand = String(body.brand || '').trim().slice(0, 40);
  const board = String(body.board || '').trim().slice(0, 40);
  if (!brand || !board) return { error: 'brand and board required' };
  let ghost = null;
  if (Array.isArray(body.ghostData) && body.ghostData.length > 1) {
    const text = JSON.stringify(body.ghostData);
    if (text.length > 500000) return { error: 'ghost too large' };
    ghost = text;
  }
  return {
    lap: {
      id: body.id,
      trackKey: body.trackKey,
      nickname,
      time,
      distance: Number(body.distance) || 0,
      date: date.toISOString(),
      kind,
      brand,
      board,
      riderName: String(body.riderName || '').slice(0, 40),
      ghost
    }
  };
}

async function getLaps(url, env) {
  const track = url.searchParams.get('track') || '';
  if (!validKey(track)) return json({ error: 'bad track' }, 400);
  const kind = url.searchParams.get('kind') || '';
  const brand = url.searchParams.get('brand') || '';
  const from = url.searchParams.get('from') || '';
  if (kind && kind !== 'real' && kind !== 'sim') return json({ error: 'bad kind' }, 400);
  if (from && Number.isNaN(new Date(from).getTime())) return json({ error: 'bad from' }, 400);

  const rows = await env.DB.prepare(
    `SELECT id, track_key, nickname, time_s, distance_m, ridden_at, kind, brand, board, rider_name,
            (ghost_json IS NOT NULL AND ghost_json != '') AS has_ghost
     FROM laps
     WHERE track_key = ?
       AND (? = '' OR kind = ?)
       AND (? = '' OR brand = ?)
       AND (? = '' OR ridden_at >= ?)
     ORDER BY time_s ASC
     LIMIT 200`
  ).bind(track, kind, kind, brand, brand, from, from).all();

  const brands = await env.DB.prepare(
    `SELECT DISTINCT brand FROM laps WHERE track_key = ? ORDER BY brand`
  ).bind(track).all();

  return json({
    laps: (rows.results || []).map(row => lapRow(row, false)),
    brands: (brands.results || []).map(row => row.brand)
  });
}

async function getLap(id, env) {
  if (!validId(id)) return json({ error: 'bad id' }, 400);
  const row = await env.DB.prepare(
    `SELECT id, track_key, nickname, time_s, distance_m, ridden_at, kind, brand, board, rider_name, ghost_json
     FROM laps WHERE id = ?`
  ).bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  return json({ lap: lapRow(row, true) });
}

async function postLap(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const cleaned = cleanLap(body || {});
  if (cleaned.error) return json({ error: cleaned.error }, 400);
  const lap = cleaned.lap;
  await env.DB.prepare(
    `INSERT INTO laps (id, track_key, nickname, time_s, distance_m, ridden_at, kind, brand, board, rider_name, ghost_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(
    lap.id, lap.trackKey, lap.nickname, lap.time, lap.distance, lap.date,
    lap.kind, lap.brand, lap.board, lap.riderName, lap.ghost
  ).run();
  return json({ ok: true, id: lap.id });
}

async function getTracks(env) {
  const rows = await env.DB.prepare(
    `SELECT key, name, updated_at FROM tracks ORDER BY name`
  ).all();
  return json({
    tracks: (rows.results || []).map(row => ({
      key: row.key,
      name: row.name,
      updatedAt: row.updated_at
    }))
  });
}

async function getTrack(key, env) {
  if (!validKey(key)) return json({ error: 'bad track' }, 400);
  const row = await env.DB.prepare(
    `SELECT key, name, json, updated_at FROM tracks WHERE key = ?`
  ).bind(key).first();
  if (!row) return json({ error: 'not found' }, 404);
  let track = null;
  try { track = JSON.parse(row.json); } catch { track = null; }
  return json({ key: row.key, name: row.name, updatedAt: row.updated_at, track });
}

async function putTrack(key, request, env) {
  if (!canWrite(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!validKey(key)) return json({ error: 'bad track' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const text = JSON.stringify(body || {});
  if (text.length > 500000) return json({ error: 'too large' }, 413);
  const name = String((body && body.name) || key).trim().slice(0, 80) || key;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO tracks (key, name, json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name, json = excluded.json, updated_at = excluded.updated_at`
  ).bind(key, name, text, now).run();
  return json({ ok: true, key });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (path === '/tracks' && request.method === 'GET') return await getTracks(env);
      if (path.startsWith('/tracks/') && request.method === 'GET') {
        return await getTrack(decodeURIComponent(path.slice('/tracks/'.length)), env);
      }
      if (path.startsWith('/tracks/') && request.method === 'PUT') {
        return await putTrack(decodeURIComponent(path.slice('/tracks/'.length)), request, env);
      }
      if (path === '/laps' && request.method === 'GET') return await getLaps(url, env);
      if (path === '/laps' && request.method === 'POST') return await postLap(request, env);
      if (path.startsWith('/laps/') && request.method === 'GET') {
        return await getLap(decodeURIComponent(path.slice('/laps/'.length)), env);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: 'board unavailable' }, 500);
    }
  }
};
