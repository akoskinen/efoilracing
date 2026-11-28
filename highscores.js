import { pauseGame, resumeGame } from './engine.js';
import {
  SIM_BRAND, SIM_BOARD, cloudBase, fetchLaps, fetchLap, postLap,
  normalizeLap, lapMatches
} from './cloud.js';

function formatLap(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const KIND_CHOICES = [
  ['all', 'All'],
  ['real', 'On water'],
  ['sim', 'Simulator']
];
const PERIOD_CHOICES = [
  ['today', 'Today'],
  ['week', 'Week'],
  ['season', 'Season'],
  ['all', 'All time']
];

export class HighScoreManager {
  constructor() {
    this.injectStyles();
    this.overlay = this.createOverlay();
    this.inputForm = this.createInputForm();
    this.board = this.createBoard();
    this.isVisible = false;
    this.transitionTimer = null;
    this.gamePaused = false;
    this.filters = { kind: 'all', period: 'all', brand: 'all' };
    this.trackKey = null;
    this.localLaps = [];
    this.remoteLaps = [];
    this.brands = [SIM_BRAND];
    this.cloudNote = '';
    this.loadSeq = 0;
    this.setupListeners();
  }

  injectStyles() {
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      #highscore-overlay {
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        height: 100dvh;
        background: rgba(8, 14, 18, 0);
        display: none;
        z-index: 1000;
        color: #fff;
        font-family: Helvetica, system-ui, sans-serif;
        transition: background 0.45s ease;
      }
      .highscore-overlay-visible { background: rgba(8, 14, 18, 0.28) !important; }
      .highscore-input, .lb {
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.45s ease, transform 0.45s ease;
      }
      .highscore-content-visible { opacity: 1 !important; transform: none !important; }

      .highscore-input {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -46%);
        width: min(420px, calc(100vw - 32px));
        box-sizing: border-box;
        background: #12181c;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 16px;
        padding: 28px 24px 22px;
        text-align: center;
      }
      .highscore-content-visible.highscore-input { transform: translate(-50%, -50%) !important; }
      .highscore-input h2 { margin: 0 0 6px; font-size: 22px; font-weight: 650; }
      .highscore-input .lap-time {
        margin: 0 0 16px;
        font-variant-numeric: tabular-nums;
        font-size: 28px;
        font-weight: 700;
      }
      .highscore-input input {
        width: 100%;
        box-sizing: border-box;
        font: inherit;
        font-size: 18px;
        text-align: center;
        background: #0c1216;
        border: 1px solid rgba(255,255,255,0.16);
        color: #fff;
        border-radius: 10px;
        padding: 12px;
        margin: 0 0 16px;
      }
      .highscore-input .lb-actions { display: flex; gap: 8px; justify-content: center; }
      .highscore-input button {
        min-height: 44px;
        padding: 0 18px;
        border: none;
        border-radius: 999px;
        font: inherit;
        font-size: 15px;
        cursor: pointer;
      }
      #save-btn { background: #fff; color: #12181c; font-weight: 650; }
      #cancel-btn { background: rgba(255,255,255,0.1); color: #fff; }

      .lb {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        padding:
          max(18px, env(safe-area-inset-top))
          max(20px, env(safe-area-inset-right))
          max(16px, env(safe-area-inset-bottom))
          max(20px, env(safe-area-inset-left));
        background:
          radial-gradient(1100px 420px at 50% -12%, rgba(90, 160, 190, 0.16), transparent 62%),
          #0c1418;
      }
      .lb-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .lb-kicker {
        margin: 0;
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.55);
      }
      .lb h2 { margin: 2px 0 0; font-size: clamp(22px, 3vw, 34px); font-weight: 680; letter-spacing: -0.02em; }
      .lb-close {
        min-width: 44px;
        min-height: 44px;
        padding: 0 16px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.16);
        background: transparent;
        color: #fff;
        font: inherit;
        font-size: 14px;
        cursor: pointer;
      }
      .lb-filters {
        display: flex;
        flex-wrap: wrap;
        gap: 14px 22px;
        margin: 18px 0 8px;
      }
      .lb-filter { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .lb-filter-label {
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.42);
      }
      .lb-seg { display: flex; flex-wrap: wrap; gap: 6px; }
      .lb-choice {
        min-height: 44px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.14);
        background: transparent;
        color: rgba(255,255,255,0.8);
        font: inherit;
        font-size: 14px;
        cursor: pointer;
      }
      .lb-choice[aria-pressed="true"] {
        background: #fff;
        color: #12181c;
        border-color: #fff;
      }
      .lb-status {
        min-height: 1.2em;
        margin: 0 0 8px;
        font-size: 13px;
        color: rgba(255,255,255,0.55);
      }
      .lb-scroll { flex: 1; overflow: auto; margin: 0 -8px; padding: 0 8px 8px; }
      .lb-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .lb-row {
        display: grid;
        grid-template-columns: 2.4rem minmax(0, 1.4fr) auto auto auto;
        gap: 6px 16px;
        align-items: center;
        min-height: 64px;
        padding: 10px 16px;
        border-radius: 12px;
        border-left: 3px solid transparent;
        background: rgba(255,255,255,0.035);
      }
      .lb-row.is-real { border-left-color: #7ec8e3; }
      .lb-row.is-sim { border-left-color: #e0b15a; }
      .lb-rank {
        font-variant-numeric: tabular-nums;
        font-size: 15px;
        color: rgba(255,255,255,0.55);
      }
      .lb-who { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .lb-name { font-size: 16px; font-weight: 650; }
      .lb-board, .lb-when { font-size: 13px; color: rgba(255,255,255,0.62); }
      .lb-source {
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .is-real .lb-source { color: #7ec8e3; }
      .is-sim .lb-source { color: #e0b15a; }
      .lb-time {
        font-variant-numeric: tabular-nums;
        font-size: 20px;
        font-weight: 700;
        text-align: right;
      }
      .lb-race {
        min-height: 44px;
        padding: 0 16px;
        border: none;
        border-radius: 999px;
        background: rgba(255,255,255,0.1);
        color: #fff;
        font: inherit;
        font-size: 14px;
        cursor: pointer;
      }
      .lb-race:hover { background: rgba(255,255,255,0.18); }
      .lb-empty {
        padding: 48px 8px;
        text-align: center;
        color: rgba(255,255,255,0.62);
        font-size: 15px;
      }
      @media (max-width: 720px) {
        .lb-row {
          grid-template-columns: 1.8rem minmax(0, 1fr) auto;
          grid-template-areas:
            "rank who time"
            "rank source race";
          gap: 4px 10px;
          padding: 12px;
        }
        .lb-rank { grid-area: rank; }
        .lb-who { grid-area: who; }
        .lb-source { grid-area: source; }
        .lb-time { grid-area: time; font-size: 18px; }
        .lb-race, .lb-norace { grid-area: race; justify-self: end; }
        .lb h2 { font-size: 24px; }
      }
    `;
    document.head.appendChild(styleEl);
  }

  createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'highscore-overlay';
    overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
    overlay.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    document.body.appendChild(overlay);
    return overlay;
  }

  createInputForm() {
    const form = document.createElement('div');
    form.innerHTML = `
      <div class="highscore-input">
        <h2>Save this lap</h2>
        <p class="lap-time"></p>
        <input type="text" id="nickname-input" maxlength="24" placeholder="Name" autocomplete="name">
        <div class="lb-actions">
          <button type="button" id="save-btn" onclick="window._tempSaveScore()">Save</button>
          <button type="button" id="cancel-btn" onclick="window._tempHideOverlay()">Cancel</button>
        </div>
      </div>
    `;
    return form;
  }

  createBoard() {
    const board = el('div', 'lb');
    const head = el('div', 'lb-head');
    const titles = el('div');
    titles.append(el('p', 'lb-kicker', 'Leaderboard'));
    const title = el('h2');
    title.className = 'track-name';
    titles.append(title);
    head.append(titles);
    const close = el('button', 'lb-close', 'Esc');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close leaderboard');
    head.append(close);
    board.append(head);

    const filters = el('div', 'lb-filters');
    filters.append(this.choiceGroup('Source', 'kind', KIND_CHOICES));
    filters.append(this.choiceGroup('Period', 'period', PERIOD_CHOICES));
    const brand = el('div', 'lb-filter');
    brand.append(el('span', 'lb-filter-label', 'Brand'));
    const brandSeg = el('div', 'lb-seg lb-brands');
    brand.append(brandSeg);
    filters.append(brand);
    board.append(filters);

    board.append(el('p', 'lb-status'));
    const scroll = el('div', 'lb-scroll');
    scroll.append(el('ol', 'lb-rows'));
    board.append(scroll);

    board.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !board.contains(btn)) return;
      if (btn.classList.contains('lb-choice')) {
        this.filters[btn.dataset.filter] = btn.dataset.value;
        this.render();
        if (cloudBase()) this.loadCloud();
      } else if (btn.classList.contains('lb-close')) {
        this.hideOverlay();
      } else if (btn.classList.contains('lb-race')) {
        this.raceLap(btn.dataset.id);
      }
    });
    return board;
  }

  choiceGroup(label, filter, choices) {
    const group = el('div', 'lb-filter');
    group.append(el('span', 'lb-filter-label', label));
    const seg = el('div', 'lb-seg');
    for (const [value, text] of choices) {
      const btn = el('button', 'lb-choice', text);
      btn.type = 'button';
      btn.dataset.filter = filter;
      btn.dataset.value = value;
      seg.append(btn);
    }
    group.append(seg);
    return group;
  }

  setupListeners() {
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'b' && !this.overlay.contains(document.activeElement)) {
        this.toggleScoreList();
      }
      if (e.key === 'Escape' && this.overlay.style.display === 'flex') {
        this.hideOverlay();
      }
    });
  }

  getScores(trackKey) {
    const scores = localStorage.getItem(`highscores_${trackKey}`);
    return scores ? JSON.parse(scores) : [];
  }

  saveScore(trackKey, entry) {
    const lap = normalizeLap({
      ...entry,
      id: entry.id || (crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`),
      date: entry.date instanceof Date ? entry.date.toISOString() : entry.date,
      kind: entry.kind || 'sim',
      brand: entry.brand || SIM_BRAND,
      board: entry.board || SIM_BOARD
    });
    if (!lap) return false;
    try {
      const stored = {
        id: lap.id,
        nickname: lap.nickname,
        time: lap.time,
        distance: lap.distance,
        date: lap.date,
        kind: lap.kind,
        brand: lap.brand,
        board: lap.board,
        riderName: lap.riderName
      };
      if (entry.ghostData && Array.isArray(entry.ghostData)) {
        const sampled = [];
        const interval = Math.max(1, Math.floor(entry.ghostData.length / 200));
        for (let i = 0; i < entry.ghostData.length && sampled.length < 200; i += interval) {
          sampled.push(storedGhostFrame(entry.ghostData[i]));
        }
        if (entry.ghostData.length && sampled.length) {
          sampled.push(storedGhostFrame(entry.ghostData[entry.ghostData.length - 1]));
        }
        stored.ghostData = sampled;
      }
      let scores = this.getScores(trackKey).map(normalizeLap).filter(Boolean);
      scores.push(stored);
      scores = retainLaps(scores);
      let serialized = JSON.stringify(scores);
      if (serialized.length > 2000000) {
        const ranked = scores.slice().sort((a, b) => a.time - b.time);
        const keep = new Set(ranked.slice(0, 3).map(s => s.id));
        for (const score of scores) if (!keep.has(score.id)) delete score.ghostData;
        serialized = JSON.stringify(scores);
      }
      localStorage.setItem(`highscores_${trackKey}`, serialized);
      postLap({ ...stored, trackKey }).catch(() => {});
      return true;
    } catch (err) {
      console.error('Error saving score:', err);
      try {
        const scores = this.getScores(trackKey);
        scores.push({
          id: lap.id, nickname: lap.nickname, time: lap.time, date: lap.date,
          kind: lap.kind, brand: lap.brand, board: lap.board
        });
        localStorage.setItem(`highscores_${trackKey}`, JSON.stringify(retainLaps(scores)));
        return true;
      } catch (fallbackErr) {
        console.error('Complete failure to save score:', fallbackErr);
        return false;
      }
    }
  }

  showInputForm(lapTime, ghostData, meta = {}) {
    if (this.currentTrackKey === 'free') return;
    this.pendingScore = {
      time: lapTime,
      distance: this.calculateDistance(ghostData),
      date: new Date(),
      ghostData,
      kind: meta.kind || 'sim',
      brand: meta.brand || SIM_BRAND,
      board: meta.board || SIM_BOARD,
      riderName: meta.riderName || ''
    };
    this.cancelPendingTransitions();
    setTimeout(() => {
      window._highScoreManager = this;
      window._tempSaveScore = function () {
        const input = document.getElementById('nickname-input');
        const nickname = input && input.value.trim() ? input.value.trim().slice(0, 24) : 'RIDER';
        setTimeout(() => {
          const mgr = window._highScoreManager;
          if (!mgr || !mgr.pendingScore) return;
          try {
            mgr.pendingScore.nickname = nickname;
            mgr.saveScore(window.currentTrackKey, mgr.pendingScore);
            mgr.pendingScore = null;
            mgr.hideOverlay();
          } catch (err) {
            console.error('Error saving score:', err);
          }
        }, 100);
      };
      window._tempHideOverlay = function () {
        if (window._highScoreManager) window._highScoreManager.hideOverlay();
      };
      this.overlay.innerHTML = '';
      this.overlay.appendChild(this.inputForm.cloneNode(true));
      this.overlay.style.display = 'flex';
      this.overlay.querySelector('.lap-time').textContent = formatLap(lapTime);
      pauseGame();
      this.gamePaused = true;
      const inputField = this.overlay.querySelector('#nickname-input');
      if (inputField) {
        inputField.value = '';
        inputField.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            window._tempSaveScore();
          }
        });
        setTimeout(() => inputField.focus(), 200);
      }
      setTimeout(() => {
        this.overlay.classList.add('highscore-overlay-visible');
        this.overlay.querySelector('.highscore-input').classList.add('highscore-content-visible');
      }, 50);
    }, 2000);
  }

  calculateDistance(ghostData) {
    if (!ghostData || !Array.isArray(ghostData) || ghostData.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < ghostData.length; i++) {
      const dx = ghostData[i].x - ghostData[i - 1].x;
      const dy = ghostData[i].y - ghostData[i - 1].y;
      total += Math.hypot(dx, dy);
    }
    return total;
  }

  showScoreList(trackKey = null) {
    this.trackKey = trackKey || window.currentTrackKey;
    const track = window.trackConfigs && window.trackConfigs[this.trackKey];
    this.cancelPendingTransitions();
    this.localLaps = this.getScores(this.trackKey).map(normalizeLap).filter(Boolean);
    this.remoteLaps = [];
    this.cloudNote = '';
    this.brands = brandList(this.localLaps, []);
    if (!this.brands.includes(this.filters.brand)) this.filters.brand = 'all';
    this.overlay.innerHTML = '';
    this.overlay.appendChild(this.board);
    this.overlay.style.display = 'flex';
    this.board.querySelector('.track-name').textContent = track ? track.name : 'This course';
    this.render();
    setTimeout(() => {
      this.overlay.classList.add('highscore-overlay-visible');
      this.board.classList.add('highscore-content-visible');
      pauseGame();
      this.gamePaused = true;
    }, 50);
    this.loadCloud();
  }

  async loadCloud() {
    if (!cloudBase() || !this.trackKey) return;
    const seq = ++this.loadSeq;
    const filters = { ...this.filters };
    try {
      const data = await fetchLaps(this.trackKey, filters);
      if (seq !== this.loadSeq) return;
      this.remoteLaps = data.laps;
      this.brands = brandList(this.localLaps, data.brands);
      this.cloudNote = '';
    } catch {
      if (seq !== this.loadSeq) return;
      this.remoteLaps = [];
      this.cloudNote = 'Couldn’t reach the cloud board. Showing laps saved on this device.';
    }
    if (this.overlay.contains(this.board)) this.render();
  }

  visibleLaps() {
    const byId = new Map();
    for (const lap of [...this.remoteLaps, ...this.localLaps]) {
      if (!lapMatches(lap, this.filters)) continue;
      const prev = byId.get(lap.id);
      if (!prev) byId.set(lap.id, lap);
      else if (!prev.ghostData && lap.ghostData) byId.set(lap.id, { ...prev, ...lap, ghostData: lap.ghostData, hasGhost: true });
    }
    return [...byId.values()].sort((a, b) => a.time - b.time || String(a.date).localeCompare(String(b.date)));
  }

  render() {
    for (const btn of this.board.querySelectorAll('.lb-choice')) {
      if (btn.dataset.filter === 'brand') continue;
      btn.setAttribute('aria-pressed', String(btn.dataset.value === this.filters[btn.dataset.filter]));
    }
    const brands = this.board.querySelector('.lb-brands');
    brands.innerHTML = '';
    for (const value of ['all', ...this.brands]) {
      const btn = el('button', 'lb-choice', value === 'all' ? 'All' : value);
      btn.type = 'button';
      btn.dataset.filter = 'brand';
      btn.dataset.value = value;
      btn.setAttribute('aria-pressed', String(value === this.filters.brand));
      brands.append(btn);
    }
    const status = this.board.querySelector('.lb-status');
    status.textContent = this.cloudNote || (cloudBase() ? '' : '');
    const rows = this.board.querySelector('.lb-rows');
    rows.innerHTML = '';
    const laps = this.visibleLaps();
    if (!laps.length) {
      const li = el('li', 'lb-empty');
      li.textContent = this.filters.kind === 'real'
        ? 'No on-water laps in this period yet.'
        : this.filters.kind === 'sim'
          ? 'No simulator laps in this period yet.'
          : 'No laps in this period yet.';
      rows.append(li);
      return;
    }
    laps.forEach((lap, index) => {
      const li = el('li', `lb-row is-${lap.kind}`);
      li.append(el('span', 'lb-rank', String(index + 1)));
      const who = el('div', 'lb-who');
      who.append(el('span', 'lb-name', lap.nickname));
      who.append(el('span', 'lb-board', `${lap.brand} · ${lap.board}`));
      const when = formatWhen(lap.date);
      if (when) who.append(el('span', 'lb-when', when));
      li.append(who);
      li.append(el('span', 'lb-source', lap.kind === 'real' ? 'On water' : 'Simulator'));
      li.append(el('span', 'lb-time', formatLap(lap.time)));
      if (lap.hasGhost) {
        const race = el('button', 'lb-race', 'Race');
        race.type = 'button';
        race.dataset.id = lap.id;
        li.append(race);
      } else {
        li.append(el('span', 'lb-norace', ''));
      }
      rows.append(li);
    });
  }

  async raceLap(id) {
    const laps = this.visibleLaps();
    let lap = laps.find(item => item.id === id);
    if (!lap) return;
    this.hideOverlay();
    try {
      if (!(lap.ghostData && lap.ghostData.length > 1) && cloudBase()) {
        const full = await fetchLap(id);
        if (full && full.ghostData) lap = full;
      }
      const ghostFrames = (lap.ghostData || []).map(frame => ({
        time: frame.time || 0,
        x: frame.x || 0,
        y: frame.y || 0,
        heading: frame.heading || 0,
        speedKmh: frame.speedKmh,
        leanDeg: frame.leanDeg,
        liftM: frame.liftM,
        finalLapTime: lap.time
      })).sort((a, b) => a.time - b.time);
      if (ghostFrames.length < 2) {
        console.warn('No ghost data available for this score');
        return;
      }
      const formattedGhost = {
        trackKey: this.trackKey,
        distance: lap.distance,
        time: lap.time,
        frames: ghostFrames,
        riderName: lap.nickname
      };
      window.ghostDataMap.set(this.trackKey, formattedGhost);
      window.currentGhost = formattedGhost;
      window.showGhost = true;
      if (typeof window.setKeepCurrentGhost === 'function') window.setKeepCurrentGhost(true);
      else window.keepCurrentGhost = true;
      window.ghostWakeTrail = [];
      const keepGhostCheckbox = document.getElementById('keepGhost');
      if (keepGhostCheckbox) keepGhostCheckbox.checked = true;
      if (typeof window.updateGhostStats === 'function') window.updateGhostStats();
      if (typeof window.enableGhostRacing === 'function') window.enableGhostRacing();
      const note = document.createElement('div');
      note.textContent = `Racing against ${lap.nickname} (${formatLap(lap.time)})`;
      note.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.72);color:#fff;padding:10px 18px;border-radius:999px;z-index:100;font-family:Helvetica,system-ui,sans-serif';
      document.body.appendChild(note);
      setTimeout(() => note.remove(), 2000);
    } catch (error) {
      console.error('Error setting up ghost:', error);
    }
  }

  hideOverlay() {
    this.cancelPendingTransitions();
    this.loadSeq++;
    if (this.gamePaused) {
      resumeGame();
      this.gamePaused = false;
    }
    this.overlay.classList.remove('highscore-overlay-visible');
    const content = this.overlay.querySelector('.highscore-input') || this.overlay.querySelector('.lb');
    if (content) content.classList.remove('highscore-content-visible');
    this.transitionTimer = setTimeout(() => {
      this.overlay.style.display = 'none';
      this.overlay.innerHTML = '';
    }, 480);
  }

  cancelPendingTransitions() {
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  toggleScoreList() {
    if (this.overlay.style.display === 'none' || !this.overlay.style.display) this.showScoreList();
    else this.hideOverlay();
  }
}

function storedGhostFrame(frame) {
  const out = {
    time: Number(frame.time.toFixed(2)),
    x: Number(frame.x.toFixed(2)),
    y: Number(frame.y.toFixed(2)),
    heading: Number(frame.heading.toFixed(2))
  };
  if (Number.isFinite(frame.speedKmh)) out.speedKmh = Number(frame.speedKmh.toFixed(1));
  if (Number.isFinite(frame.leanDeg)) out.leanDeg = Number(frame.leanDeg.toFixed(1));
  if (Number.isFinite(frame.liftM)) out.liftM = Number(frame.liftM.toFixed(3));
  return out;
}

function retainLaps(scores) {
  const laps = scores.map(normalizeLap).filter(Boolean);
  laps.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const kept = laps.slice(0, 120);
  const keepGhost = new Set(kept.slice().sort((a, b) => a.time - b.time).slice(0, 10).map(lap => lap.id));
  for (const lap of kept.slice(0, 3)) keepGhost.add(lap.id);
  return kept.map(lap => {
    const copy = { ...lap };
    if (!keepGhost.has(copy.id)) {
      delete copy.ghostData;
      copy.hasGhost = false;
    } else {
      copy.hasGhost = !!(copy.ghostData && copy.ghostData.length > 1);
    }
    return copy;
  });
}

function brandList(laps, extra) {
  const names = new Set([SIM_BRAND]);
  for (const lap of laps) if (lap.brand) names.add(lap.brand);
  for (const name of extra || []) if (name) names.add(String(name));
  return [...names].sort((a, b) => a.localeCompare(b));
}
