-- Leaderboard laps and the courses they were ridden on.
-- Apply with: wrangler d1 execute efoil-racing --file=schema.sql

CREATE TABLE IF NOT EXISTS tracks (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS laps (
  id TEXT PRIMARY KEY,
  track_key TEXT NOT NULL,
  nickname TEXT NOT NULL,
  time_s REAL NOT NULL,
  distance_m REAL,
  ridden_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  brand TEXT NOT NULL,
  board TEXT NOT NULL,
  rider_name TEXT,
  ghost_json TEXT
);

CREATE INDEX IF NOT EXISTS laps_track_time ON laps (track_key, time_s);
CREATE INDEX IF NOT EXISTS laps_track_ridden ON laps (track_key, ridden_at);
