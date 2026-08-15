// commentary.js
//
// One voice at a time. Overlapping `new Audio().play()` calls were saturating
// the audio graph whenever several buoys "apexed" in the same frames.

const KEY_ALIASES = {
  turn_optimalspeed_tightline_good: "turn_optimalspeed_tightline_goodthrottle",
  turn_optimalspeed_tightline_late: "turn_optimalspeed_tightline_latethrottle",
  turn_optimalspeed_wideline_good: "turn_optimalspeed_wideline_goodthrottle",
  turn_optimalspeed_wideline_late: "turn_optimalspeed_wideline_latethrottle"
};

export const commentaryClips = {
  start_over50: [
    "commentary/ak/start_over50/start_over50_1.mp3",
    "commentary/ak/start_over50/start_over50_2.mp3",
    "commentary/ak/start_over50/start_over50_3.mp3"
  ],
  start_30_50: [
    "commentary/ak/start_30_50/start_30_50_1.mp3",
    "commentary/ak/start_30_50/start_30_50_2.mp3",
    "commentary/ak/start_30_50/start_30_50_3.mp3"
  ],
  start_under30: [
    "commentary/ak/start_under30/start_under30_1.mp3",
    "commentary/ak/start_under30/start_under30_2.mp3",
    "commentary/ak/start_under30/start_under30_3.mp3"
  ],

  turn_optimalspeed_tightline_goodthrottle: [
    "commentary/ak/turn_optimalspeed_tightline_goodthrottle/throttle_good_1.mp3",
    "commentary/ak/turn_optimalspeed_tightline_goodthrottle/throttle_good_2.mp3"
  ],
  turn_optimalspeed_tightline_latethrottle: [
    "commentary/ak/turn_optimalspeed_tightline_latethrottle/throttle_late_1.mp3",
    "commentary/ak/turn_optimalspeed_tightline_latethrottle/throttle_late_2.mp3"
  ],
  turn_optimalspeed_wideline_goodthrottle: [
    "commentary/ak/turn_optimalspeed_wideline_goodthrottle/wideline_1.mp3"
  ],
  turn_optimalspeed_wideline_latethrottle: [
    "commentary/ak/turn_optimalspeed_wideline_latethrottle/tightline_1.mp3"
  ],

  turn_generic: [
    "commentary/ak/turn_generic/ok_1.mp3",
    "commentary/ak/turn_generic/herewego_1.mp3"
  ]
};

const voice = new Audio();
voice.preload = "auto";

let busy = false;
let pendingKey = null;
let playGen = 0;
const lastClipByKey = {};

function clipsFor(eventKey) {
  const key = KEY_ALIASES[eventKey] || eventKey;
  const clips = commentaryClips[key];
  if (!clips || !clips.length) return null;
  return { key, clips };
}

function pickClip(key, clips) {
  if (clips.length === 1) return { path: clips[0], index: 0 };
  const last = lastClipByKey[key];
  const choices = clips
    .map((path, index) => ({ path, index }))
    .filter(c => c.index !== last);
  const pool = choices.length ? choices : clips.map((path, index) => ({ path, index }));
  return pool[Math.floor(Math.random() * pool.length)];
}

function finishPlay(gen) {
  if (gen !== playGen) return;
  busy = false;
  const next = pendingKey;
  pendingKey = null;
  if (next) playCommentary(next);
}

function startClip(key, clips) {
  const pick = pickClip(key, clips);
  lastClipByKey[key] = pick.index;
  playGen += 1;
  const gen = playGen;
  busy = true;

  voice.onended = () => finishPlay(gen);
  voice.onerror = () => finishPlay(gen);

  voice.pause();
  try { voice.currentTime = 0; } catch (_) { /* ignore */ }
  voice.src = pick.path;
  voice.volume = 1.0;
  voice.play().catch(err => {
    console.warn("Failed to play commentary clip:", pick.path, err);
    finishPlay(gen);
  });
}

export function playCommentary(eventKey, options = {}) {
  const resolved = clipsFor(eventKey);
  if (!resolved) {
    console.warn("No commentary clips for eventKey:", eventKey);
    return;
  }

  if (options.interrupt) {
    playGen += 1;
    pendingKey = null;
    busy = false;
    voice.pause();
  }

  if (busy) {
    pendingKey = resolved.key;
    return;
  }

  startClip(resolved.key, resolved.clips);
}

export function resetCommentaryQueue() {
  pendingKey = null;
}
