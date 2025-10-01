////////////////////////////////////////////////////////////
// engine.js
////////////////////////////////////////////////////////////
// This simulator and the code of the referenced modules is/are 
// the property of Antti Koskinen (anttikoskinen@mac.com)
// All Rights reserved, contact by email for any inquiries.
////////////////////////////////////////////////////////////

import { trackConfigs } from "./trackConfigs.js";
import { commentaryClips, playCommentary } from "./commentary.js";
import { HighScoreManager } from './highscores.js';

// --- Canvas and Context ---
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// --- Track Setup Variables ---
let currentTrackKey = 'speedTrack'; // default track key
let currentTrack    = trackConfigs[currentTrackKey]; // default track object

let buoys = [];
let timingLine = { x1: 0, y1: 0, x2: 0, y2: 0 };
let gates = { start: null, finish: null, parallelStart: null, parallelFinish: null };

// We'll store the offset used to center the track on the canvas.
let trackOffset = { x: 0, y: 0 };

// Gather all track keys from trackConfigs, e.g. ["speedTrack", "dubaiTrack", ...]
const availableTrackKeys = Object.keys(trackConfigs);

// --- Additional Variables for Turn Apex Logic ---
let turnStates = {};
const THROTTLE_WINDOW = 0.5; // We'll track last 0.5s of throttle usage

function initTurnStates() {
  // We'll reset or create states for each turn buoy
  buoys.forEach(b => {
    if (b.turnIndex != null) {
      turnStates[b.turnIndex] = {
        apexReached: false,
        previousDistance: null,
        minDistance: Infinity,
        apexSpeed: 0,

        // Throttle usage queue
        throttleQueue: [],
        queueTime: 0
      };
    }
  });
}

// Add this helper function at the top level, before it's used
function lineIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
    // Calculate denominator
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (den == 0) return false;

    // Calculate intersection parameters
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;

    // Check if intersection occurs within both line segments
    return (t >= 0 && t <= 1 && u >= 0 && u <= 1);
}

// Make sure computedGates is declared at the top level
let computedGates = null;

// --- Compute Buoys Function ---
function computeBuoys() {
  // 1) Build an intermediate array "rawBuoyData" that scales the coordinates
  const rawBuoyData = currentTrack.buoys.map(b => {
    const px = b.x * currentTrack.scale;
    const py = canvas.height - (b.y * currentTrack.scale);
    return {
      px,
      py,
      turnIndex: b.turnIndex ?? null,
      aliases: b.aliases ?? [],
      apexRadius: b.apexRadius ?? 20,
      optimalSpeed: b.optimalSpeed
    };
  });

  // 2) If there's a parallel track, add its buoys to centroid calculation
  let totalPoints = [...rawBuoyData];
  if (currentTrack.parallelTrack) {
    const parallelBuoys = rawBuoyData.map(b => ({
      ...b,
      py: b.py - (currentTrack.trackSeparation * currentTrack.scale)
    }));
    totalPoints = [...totalPoints, ...parallelBuoys];
  }

  // 3) Find the centroid including both tracks if present
  const centroid = totalPoints.reduce((acc, b) => ({
    x: acc.x + b.px,
    y: acc.y + b.py
  }), { x: 0, y: 0 });
  centroid.x /= totalPoints.length;
  centroid.y /= totalPoints.length;

  // 4) Compute offset to center the track on the canvas
  trackOffset.x = canvas.width / 2 - centroid.x;
  trackOffset.y = canvas.height / 2 - centroid.y;

  // 5) Create the final buoys array, applying offset
  buoys = rawBuoyData.map(b => ({
    x: b.px + trackOffset.x,
    y: b.py + trackOffset.y,
    turnIndex: b.turnIndex,
    aliases: b.aliases,
    apexRadius: b.apexRadius,
    optimalSpeed: b.optimalSpeed
  }));

  // 6) Compute timing system
  if (currentTrack.useGates) {
    // Set parent reference for gates
    currentTrack.gates.parent = currentTrack;
    
    // Use gate system
    computedGates = currentTrack.gates.computeGates(trackMetersToPixel);
    
    if (currentTrack.gates.sameStartFinish) {
      gates = {
        start: computedGates.start,
        finish: computedGates.start,
        parallelStart: computedGates.parallelStart,
        parallelFinish: computedGates.parallelStart
      };
    } else {
      gates = {
        start: computedGates.start,
        finish: computedGates.finish,
        parallelStart: computedGates.parallelStart,
        parallelFinish: computedGates.parallelFinish
      };
    }
    
    // Clear timing line
    timingLine = { x1: 0, y1: 0, x2: 0, y2: 0 };
  } else {
    // Use old timing line system
  timingLine = currentTrack.computeTimingLine(buoys, canvas);
    // Clear gates
    gates = { start: null, finish: null, parallelStart: null, parallelFinish: null };
  }

  // 7) Initialize apex states for these buoys
  initTurnStates();
}

// --- Audio Manager ---
const AudioManager = {
    sounds: {
        wind: document.getElementById('windAudio'),
        music: document.getElementById('musicAudio'),
        boomStop: document.getElementById('boomStopAudio'),
        collision: document.getElementById('collisionAudio')
    },
    
    init() {
        // Set up audio elements
        this.sounds.music.loop = true;
        this.sounds.wind.loop = true;
        
        // Start wind sound with zero volume
        this.sounds.wind.volume = 0;
        this.playSound('wind').catch(err => console.warn('Failed to start wind sound:', err));
        
        // Add error handlers
        Object.values(this.sounds).forEach(audio => {
            audio.addEventListener('error', (e) => {
                console.warn('Audio error:', e);
            });
        });
        
        // Add ended handler for wind sound to ensure it keeps playing
        this.sounds.wind.addEventListener('ended', () => {
            this.playSound('wind').catch(err => console.warn('Wind sound restart failed:', err));
        });
    },
    
    ensureWindPlaying() {
        const wind = this.sounds.wind;
        if (wind.paused) {
            this.playSound('wind').catch(err => console.warn('Failed to resume wind sound:', err));
        }
    },
    
    playSound(soundId, options = {}) {
        const sound = this.sounds[soundId];
        if (!sound) {
            console.warn(`Sound not found: ${soundId}`);
            return Promise.reject(new Error(`Sound not found: ${soundId}`));
        }
        
        return new Promise((resolve, reject) => {
            try {
                // Reset the sound to beginning
                sound.currentTime = 0;
                
                // Set volume if specified
                if (typeof options.volume === 'number') {
                    sound.volume = Math.max(0, Math.min(1, options.volume));
                }
                
                // Play the sound
                const playPromise = sound.play();
                
                if (playPromise !== undefined) {
                    playPromise
                        .then(() => resolve())
                        .catch(error => {
                            console.warn(`Failed to play ${soundId}:`, error);
                            reject(error);
                        });
      } else {
                    resolve();
                }
            } catch (error) {
                console.warn(`Error playing ${soundId}:`, error);
                reject(error);
            }
        });
    },
    
    stopSound(soundId) {
        const sound = this.sounds[soundId];
        if (!sound) return;
        
        try {
            sound.pause();
            sound.currentTime = 0;
        } catch (error) {
            console.warn(`Error stopping ${soundId}:`, error);
        }
    },
    
    fadeOutMusic(duration = 2000) {
        const music = this.sounds.music;
        if (!music || music.paused) return;
        
        let volume = music.volume;
        const steps = 50;
        const step = 1 / steps;
        const interval = duration / steps;
        
        const fade = () => {
            volume = Math.max(0, volume - step);
            music.volume = volume;
            
            if (volume > 0) {
                setTimeout(fade, interval);
            } else {
                this.stopSound('music');
                music.volume = 1.0; // Reset volume for next play
            }
        };
        
        fade();
    }
};

// Initialize audio manager
AudioManager.init();

// --- Canvas Resize ---
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  computeBuoys();
}
window.addEventListener('resize', resizeCanvas);

// --- Track Selector Handling (Radio Buttons) ---
const trackRadios = document.querySelectorAll('input[name="track"]');
trackRadios.forEach(radio => {
  radio.addEventListener('change', function(){
    if (this.checked) {
      currentTrackKey = this.value;
      currentTrack    = trackConfigs[currentTrackKey];
      computeBuoys();
      
      // Reset player state
      speed = 0;
      bankAngleDeg = 0;
      wakeTrail = [];
      
      // Position player centered horizontally, higher above the lap time display
      pos.x = (canvas.width / 2) - 4; // Shift 4px to the left
      pos.y = canvas.height - 150; // Changed from 100 to 150 pixels up from bottom
      heading = -Math.PI / 2; // Point upward (-90 degrees)
      
      // Reset or clear the ideal line
      idealLineData = null;
      showIdealLine = false;
      ghostWakeTrail = [];
      
      // Update URL to reflect track change (without reloading page)
      const url = new URL(window.location);
      url.searchParams.set('track', currentTrackKey);
      window.history.replaceState({}, '', url);
    }
  });
});

// --- URL Parameter Handling ---
function parseURLParams() {
  const params = new URLSearchParams(window.location.search);
  
  // Check for track parameter
  if (params.has('track')) {
    const trackFromURL = params.get('track');
    
    // Check if this is a valid track key
    if (availableTrackKeys.includes(trackFromURL)) {
      // Update current track
      currentTrackKey = trackFromURL;
      currentTrack = trackConfigs[currentTrackKey];
      
      // Update radio button
      const radioToSelect = document.querySelector(`input[name="track"][value="${currentTrackKey}"]`);
      if (radioToSelect) {
        radioToSelect.checked = true;
      }
      
      // Compute buoys for the new track
      computeBuoys();
    }
  }
  
  // Check for fullscreen parameter
  if (params.has('fullscreen') && params.get('fullscreen') === 'true') {
    // Small delay to ensure everything is loaded
    setTimeout(() => {
      toggleFullScreen();
    }, 500);
  }
}

// --- Fullscreen Toggle ---
function toggleFullScreen() {
  if (!document.fullscreenElement) {
    // Enter fullscreen
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) { /* Safari */
      document.documentElement.webkitRequestFullscreen();
    } else if (document.documentElement.msRequestFullscreen) { /* IE11 */
      document.documentElement.msRequestFullscreen();
    }
  } else {
    // Exit fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) { /* Safari */
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) { /* IE11 */
      document.msExitFullscreen();
    }
  }
  
  // Update fullscreen button state
  updateFullscreenButtonState();
}

// Add this to window's global scope so it can be called from buttons or links
window.toggleFullScreen = toggleFullScreen;

// --- Fullscreen Button ---
function createFullscreenButton() {
  const button = document.createElement('div');
  button.id = 'fullscreen-button';
  button.innerHTML = '[ ]';
  button.title = 'Toggle Fullscreen';
  
  // Add CSS for the button
  const style = document.createElement('style');
  style.textContent = `
    #fullscreen-button {
      position: fixed;
      top: 15px;
      right: 15px;
      color: rgba(255, 255, 255, 0.5);
      font-family: monospace;
      font-size: 16px;
      padding: 5px 8px;
      cursor: pointer;
      z-index: 1000;
      border-radius: 4px;
      user-select: none;
      transition: all 0.2s ease;
    }
    
    #fullscreen-button:hover {
      color: rgba(255, 255, 255, 0.9);
      transform: scale(1.1);
    }
  `;
  document.head.appendChild(style);
  
  // Add click handler
  button.addEventListener('click', () => {
    toggleFullScreen();
  });
  
  // Add to document
  document.body.appendChild(button);
  
  // Set initial state
  updateFullscreenButtonState();
  
  // Add fullscreen change listener
  document.addEventListener('fullscreenchange', updateFullscreenButtonState);
  document.addEventListener('webkitfullscreenchange', updateFullscreenButtonState);
  document.addEventListener('mozfullscreenchange', updateFullscreenButtonState);
  document.addEventListener('MSFullscreenChange', updateFullscreenButtonState);
}

function updateFullscreenButtonState() {
  const button = document.getElementById('fullscreen-button');
  if (!button) return;
  
  if (document.fullscreenElement) {
    button.innerHTML = '[ x ]';
    button.title = 'Exit Fullscreen (Esc)';
  } else {
    button.innerHTML = '[ ]';
    button.title = 'Enter Fullscreen';
  }
}

// --- Game Physics and Control Variables ---
const maxSpeed       = 100;
const timeToMaxSpeed = 18;
const accelRate      = maxSpeed / timeToMaxSpeed;
const decelRate      = 12.333;
const speedConversion= 0.6;
const speedScale     = 0.837;

const BANK_ANGLE_MAX = 55;
const bankRate0to30  = 40;
const bankRate30to55 = 10;
let bankAngleDeg     = 0;
const bankDecay      = 0.9;

function updateBankAngle(dt) {
  let targetSign = 0;
  if (keys['ArrowLeft'])  targetSign = -1;
  if (keys['ArrowRight']) targetSign =  1;
  
  if (targetSign !== 0) {
    let currentMag = Math.abs(bankAngleDeg);
    let sign = Math.sign(bankAngleDeg);
    if (sign === 0) sign = targetSign;
    if (sign !== targetSign) {
      currentMag = 0;
      bankAngleDeg = 0;
      sign = targetSign;
    }
    let rate = (currentMag < 30) ? bankRate0to30 : bankRate30to55;
    currentMag += rate * dt;
    if (currentMag > BANK_ANGLE_MAX) currentMag = BANK_ANGLE_MAX;
    bankAngleDeg = sign * currentMag;
  } else {
    if (Math.abs(bankAngleDeg) < 0.5) {
      bankAngleDeg = 0;
    } else {
      const decayPow = Math.pow(bankDecay, 60 * dt);
      bankAngleDeg *= decayPow;
      if (Math.abs(bankAngleDeg) < 0.05) bankAngleDeg = 0;
    }
  }
}

// --- Turn Radius Interpolation ---
const baseline30Data = [
  { speed:10, radius:10 },
  { speed:15, radius:15 },
  { speed:30, radius:30 },
  { speed:40, radius:65 },
  { speed:60, radius:80 }
];
const reduceData = [
  { speed:10, factor:0.85 },
  { speed:15, factor:0.82 },
  { speed:30, factor:0.83 },
  { speed:40, factor:0.85 },
  { speed:60, factor:0.90 }
];

function interpPiecewise(table, spd){
  let s = Math.max(10, Math.min(60, spd));
  for (let i = 1; i < table.length; i++){
    const prev = table[i - 1];
    const cur  = table[i];
    if (s >= prev.speed && s <= cur.speed) {
      const span   = cur.speed - prev.speed;
      const ratio  = (s - prev.speed) / span;
      const valPrev= (prev.radius !== undefined) ? prev.radius : prev.factor;
      const valCur = (cur.radius  !== undefined) ? cur.radius  : cur.factor;
      return valPrev + (valCur - valPrev) * ratio;
    }
  }
  if (s <= table[0].speed) {
    return (table[0].radius !== undefined) ? table[0].radius : table[0].factor;
  }
  const last = table[table.length - 1];
  return (last.radius !== undefined) ? last.radius : last.factor;
}

function getTurnRadius(speedKmh, angleDeg) {
  let ang = Math.max(0, Math.min(55, angleDeg));
  const base30    = interpPiecewise(baseline30Data, speedKmh);
  const factorMax = interpPiecewise(reduceData,          speedKmh);
  const radiusAt50= base30 * factorMax;
  
  if (ang < 30) {
    const frac = ang / 30;
    const bigVal = 5000;
    return bigVal + frac * (base30 - bigVal);
  } else if (ang <= 50) {
    const frac = (ang - 30) / 20;
    return base30 + frac * (radiusAt50 - base30);
  } else {
    return radiusAt50;
  }
}

const turnGain  = 15;
const lowFactor = 0.02084;

// --- Movement & Telemetry ---
let heading = 0;
let speed   = 0;
const pos   = { x: 0, y: 0 };
let oldPos  = { x: 0, y: 0 };

let lapActive      = false;
let lapStartTime   = 0;
let currentLapTime = 0;

// Change laps array to a Map to store laps per track
let lapsMap = new Map(); // Store laps for each track

let distanceTraveled = 0;
let topSpeedKmh      = 0;
let minSpeedKmh      = Infinity;
let sumSpeeds        = 0;
let frameCount       = 0;
let lastPosTelemetry = { x: 0, y: 0 };

let collidedThisLap  = false;
let penaltySeconds   = 0;

// --- Ghost Data & Functions ---
let ghostDataMap = new Map(); // Store ghosts for each track
let recordedGhost = [];
let ghostStats = {
    lapTime: 0,
    topSpeed: 0,
    avgSpeed: 0
};

// Add ghost wake trail array
let ghostWakeTrail = [];

// Add a variable to store the current ghost separately from the last completed lap
let currentGhost = null;
let lastValidGhost = null;
let keepCurrentGhost = false;  // This should already exist, tied to the checkbox

// Add a new variable to control ghost visibility
let showGhost = false;

function pixelToTrackMeters(px, py) {
  const localX = px - trackOffset.x;
  const localY = py - trackOffset.y;
  const metersX= localX / currentTrack.scale;
  const metersY= (canvas.height - localY) / currentTrack.scale;
  return { x: metersX, y: metersY };
}

function trackMetersToPixel(mx, my) {
  const localX = mx * currentTrack.scale;
  const localY = canvas.height - (my * currentTrack.scale);
  return {
    x: localX + trackOffset.x,
    y: localY + trackOffset.y
  };
}

function recordGhostData(timeSec) {
  if (!lapActive) return;
  const trackM = pixelToTrackMeters(pos.x, pos.y);
  // Calculate the current average speed based on sumSpeeds and frameCount
  const currentAvgSpeed = frameCount > 0 ? sumSpeeds / frameCount : 0;
  // Add current speed data to the ghost frame
  recordedGhost.push({
    time: timeSec,
    x: trackM.x,
    y: trackM.y,
    heading,
    speedKmh: speed * speedConversion, // Current speed
    avgSpeedKmh: currentAvgSpeed       // Running average speed
  });
}

function getGhostPosition(t, ghostData) {
  if (!ghostData || !ghostData.frames || !Array.isArray(ghostData.frames) || ghostData.frames.length === 0) {
    return null;
  }
  
  const frames = ghostData.frames;
  
  // Handle case where time is before first frame
  if (t <= frames[0].time) {
    return { ...frames[0] };
  }
  
  // Handle case where time is after last frame
  const lastIndex = frames.length - 1;
  if (t >= frames[lastIndex].time) {
    return { ...frames[lastIndex] };
  }
  
  // Binary search to find closest frame pair more efficiently
  let low = 0;
  let high = frames.length - 1;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    
    if (frames[mid].time <= t && (mid === lastIndex || frames[mid + 1].time >= t)) {
      // Found the lower bound frame
      const prev = frames[mid];
      const next = frames[mid + 1];
      
      // Calculate how far between frames we are (0.0 to 1.0)
      const ratio = (t - prev.time) / (next.time - prev.time);
      
      // Linear interpolation between frames
      return {
        x: prev.x + ratio * (next.x - prev.x),
        y: prev.y + ratio * (next.y - prev.y),
        heading: prev.heading + ratio * (next.heading - prev.heading),
        time: t
      };
    }
    
    if (frames[mid].time > t) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  
  // Fallback: use first frame (should not reach here if data is valid)
  return { ...frames[0] };
}

function drawGhostFrame() {
    // Only proceed if all conditions are met
    if (!lapActive || !showGhost || !currentGhost) {
        return;
    }
    
    if (!currentGhost.frames || !Array.isArray(currentGhost.frames) || currentGhost.frames.length === 0) {
        return;
    }
    
    // Get the current time in seconds since lap start
    const timeSec = (performance.now() - lapStartTime) / 1000;
    
    // Find the frame at the current time
    const frame = getGhostPosition(timeSec, currentGhost);
    if (!frame) {
        return;
    }
    
    // Calculate pixel position from track meters
    let ghostX, ghostY;
    
    // For Sicily, show ghost on parallel track
    if (currentTrackKey === 'sicily') {
        const parallel = trackMetersToPixel(
            frame.x,
            frame.y + currentTrack.trackSeparation
        );
        ghostX = parallel.x;
        ghostY = parallel.y;
    } else {
        // For other tracks, show ghost on same track
        const pos = trackMetersToPixel(frame.x, frame.y);
        ghostX = pos.x;
        ghostY = pos.y;
    }
    
    // Draw the ghost
    drawGhost(ghostX, ghostY, frame.heading);
    
    // Update ghost wake trail
    ghostWakeTrail.push({ x: ghostX, y: ghostY });
    const targetWakeLength = 200; // Fixed length for ghost wake
    while (ghostWakeTrail.length > 1 && totalTrailDistance(ghostWakeTrail) > targetWakeLength) {
        ghostWakeTrail.shift();
    }
}

// Separate function to draw the ghost racer at a given position
function drawGhost(x, y, heading) {
  ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading - Math.PI / 2);
    ctx.globalAlpha = 0.25;  // Keep original transparency
  ctx.beginPath();
  ctx.moveTo(0, 12.5);
  ctx.bezierCurveTo(4, 7.5, 4, -7.5, 0, -12.5);
  ctx.bezierCurveTo(-4, -7.5, -4, 7.5, 0, 12.5);
  ctx.closePath();
    ctx.fillStyle = '#ff88ff';  // Keep original color
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1.0;
}

function startLap(){
  lapStartTime = performance.now();
  currentLapTime = 0;
  lapActive = true;
  
  // Clear ghost wake trail
  ghostWakeTrail = [];
  
  // Initialize ghost if available
  if (showGhost || ghostDataMap.has(currentTrackKey)) {
    // Get the stored ghost for this track
    const trackGhost = ghostDataMap.get(currentTrackKey);
    
    // Use current ghost if we're keeping it, otherwise use the stored track ghost
    if (trackGhost) {
      if (!keepCurrentGhost || !currentGhost) {
        currentGhost = trackGhost;
        showGhost = true;
      }
      
      // Update ghost stats display
      updateGhostStats();
    }
  }
  
  // Reset collision tracking
  collidedThisLap = false;
  penaltySeconds = 0;
  
  // Reset telemetry
  distanceTraveled = 0;
  topSpeedKmh = 0;
  minSpeedKmh = Infinity;
  sumSpeeds = 0;
  frameCount = 0;
  lastPosTelemetry = { x: pos.x, y: pos.y };
  
  // Reset ghost recording
  recordedGhost = [];
  
  // Start music
  AudioManager.playSound('music')
    .catch(err => console.warn('Failed to play music:', err));
  
  // Play appropriate commentary based on starting speed
  const speedKmh = speed * speedConversion;
  if (speedKmh > 50) {
    playCommentary("start_over50");
  } else if (speedKmh > 30) {
    playCommentary("start_30_50");
  } else {
    playCommentary("start_under30");
  }
}

// Calculate average speed properly
function calculateAvgSpeed(distance, time) {
  if (!time || time <= 0) return 0;
  // Calculate the average speed directly from distance and time
  // Distance is in meters, time is in seconds
  // (distance / time) gives m/s, multiply by 3.6 to convert to km/h
  return (distance / time) * 3.6; // Convert m/s to km/h
}

function completeLap() {
    // Calculate the final lap time based on the current time
    const rawSec = (performance.now() - lapStartTime) / 1000;
    currentLapTime = rawSec;
    
    if (collidedThisLap) {
        currentLapTime += penaltySeconds;
    }
    
    // Play sound effects
    AudioManager.playSound('boomStop')
        .catch(err => console.warn('Failed to play boom stop sound:', err));
    AudioManager.fadeOutMusic();
    
    // Calculate average speed using arithmetic mean of speed readings
    // This will match what the speedometer shows when speed is constant
    const avgSpeedKmh = frameCount > 0 ? sumSpeeds / frameCount : 0;
    
    // Get or create laps array for current track
    if (!lapsMap.has(currentTrackKey)) {
        lapsMap.set(currentTrackKey, []);
    }
    const trackLaps = lapsMap.get(currentTrackKey);
    
    // Store lap data for telemetry with collision status
    trackLaps.unshift({
        finalTime: currentLapTime,
        distance: distanceTraveled,
        topSpeed: topSpeedKmh,
        minSpeed: (minSpeedKmh === Infinity ? 0 : minSpeedKmh),
        avgSpeed: avgSpeedKmh,
        collided: collidedThisLap
    });
    if (trackLaps.length > 4) trackLaps.pop(); // Keep only last 4 laps
    
    // Update display with penalty if applicable
    const lapTimeStr = currentLapTime.toFixed(3);
    const penaltyText = collidedThisLap ? ` (+${penaltySeconds}s penalty!)` : '';
    document.getElementById('lapTimeDisplay').innerText = `Laptime: ${lapTimeStr}${penaltyText}`;
    
    // Add lap to history
    const historyDiv = document.getElementById('lapHistory');
    const lapEntry = document.createElement('div');
    lapEntry.innerHTML = `Lap: ${lapTimeStr}s | Top: ${topSpeedKmh.toFixed(1)} | Avg: ${avgSpeedKmh.toFixed(1)} | Min: ${minSpeedKmh.toFixed(1)} km/h${collidedThisLap ? ` (+${penaltySeconds}s penalty!)` : ''}`;
    historyDiv.insertBefore(lapEntry, historyDiv.firstChild);
    
    // Set lap to inactive before any potential game pause
    lapActive = false;
    
    // Force a redraw of the telemetry to update the display
    // This ensures telemetry is updated before any highscore form appears
    drawTelemetry();
    
    // Only store ghost data if it's a valid lap
    if (!collidedThisLap && currentLapTime > 10 && distanceTraveled > 100) {
        // Store distance in the ghost data
        const newGhostData = {
    trackKey: currentTrackKey,
            distance: distanceTraveled,
            time: currentLapTime,
            avgSpeed: avgSpeedKmh, // Store the calculated average speed
            frames: recordedGhost.map(frame => ({
                ...frame,
                finalLapTime: currentLapTime
            }))
        };
        
        // Store as last valid ghost
        lastValidGhost = newGhostData;
        
        // If we're not keeping the current ghost, update it for this track
        if (!keepCurrentGhost) {
            currentGhost = lastValidGhost;
            ghostDataMap.set(currentTrackKey, lastValidGhost);
        }
        
        // Update ghost stats display
        updateGhostStats();

        // After recording ghost data, show input form if it's a good time
        setTimeout(() => {
            highScoreManager.showInputForm(currentLapTime, recordedGhost);
        }, 500);
        
        // Always enable ghost racing for the next lap with a valid ghost
        showGhost = true;
        // Update checkbox if it exists
        const ghostCheckbox = document.getElementById('showGhost');
        if (ghostCheckbox) {
            ghostCheckbox.checked = true;
        }
  }
}

// --- Input Handling ---
const keys = {};

document.addEventListener('keydown', function(e) {
  // Don't process keyboard shortcuts if game is paused or if typing in an input
  if (gamePaused || (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return;
  }
  
  switch(e.key) {
    case 'ArrowUp':
    case 'i':
    case 'I':
      e.preventDefault();
      keys['ArrowUp'] = true;
      break;
    case 'ArrowDown':
    case 'k':
    case 'K':
      e.preventDefault();
      keys['ArrowDown'] = true;
      break;
    case 'ArrowLeft':
    case 'j':
    case 'J':
      e.preventDefault();
      keys['ArrowLeft'] = true;
      break;
    case 'ArrowRight':
    case 'l':
    case 'L':
      e.preventDefault();
      keys['ArrowRight'] = true;
      break;
    // Keep your other cases
  }

  // Toggle 'P' to show/hide the ideal line
  if (e.key === 'p' || e.key === 'P') {
    showIdealLine = !showIdealLine;
    if (showIdealLine && !idealLineData) {
      loadIdealLineForCurrentTrack();
    }
  }

  // Press 'T' to cycle to the next track
  if (e.key === 't' || e.key === 'T') {
    cycleToNextTrack();
  }
});

document.addEventListener('keyup', function(e) {
  switch(e.key) {
    case 'ArrowUp':
    case 'i':
    case 'I':
      keys['ArrowUp'] = false;
      break;
    case 'ArrowDown':
    case 'k':
    case 'K':
      keys['ArrowDown'] = false;
      break;
    case 'ArrowLeft':
    case 'j':
    case 'J':
      keys['ArrowLeft'] = false;
      break;
    case 'ArrowRight':
    case 'l':
    case 'L':
      keys['ArrowRight'] = false;
      break;
    // Keep your other cases
  }

  // Keep your other existing key handlers
  // ...
});

// Update cycleToNextTrack to handle track-specific telemetry
function cycleToNextTrack() {
  const currentIndex = availableTrackKeys.indexOf(currentTrackKey);
  if (currentIndex === -1) return;

  // Move to the next track, wrap around if needed
  const nextIndex = (currentIndex + 1) % availableTrackKeys.length;
  currentTrackKey = availableTrackKeys[nextIndex];
  currentTrack = trackConfigs[currentTrackKey];
  
  // Update global reference for highscore system
  window.currentTrackKey = currentTrackKey;

  // Update the radio buttons to reflect the new track
  trackRadios.forEach(radio => {
    radio.checked = (radio.value === currentTrackKey);
  });
    
  // Reset music if it was playing
  if (!AudioManager.sounds.music.paused) {
    AudioManager.sounds.music.pause();
    AudioManager.sounds.music.currentTime = 0;
  }
  
  computeBuoys();
    
  // Position player centered horizontally (minus 1m), higher above the lap time display
  pos.x = (canvas.width / 2) - (1 * currentTrack.scale) - 4; // Add 4px shift to the left
  pos.y = canvas.height - 150;
  heading = -Math.PI / 2; // Point upward (-90 degrees)
  
  // Reset for lap timing system
  lapActive = false;
  validCrossing = false;
  
  // Clear or reload ideal line if you want
  idealLineData = null;
  showIdealLine = false;
  ghostWakeTrail = [];
    
  // Update current ghost for the new track
  currentGhost = ghostDataMap.get(currentTrackKey) || null;
  if (!keepCurrentGhost) {
    lastValidGhost = null;
  }

  // Set prevPos to current pos to avoid immediate false crossing detection
  prevPos.x = pos.x;
  prevPos.y = pos.y;
    
  // Update ghost stats for the new track
  updateGhostStats();
}

// --- Intersection & Timing Line Crossing ---
function orientation(p, q, r){
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function linesIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2){
  const p1 = { x: ax1, y: ay1 }, p2 = { x: ax2, y: ay2 };
  const p3 = { x: bx1, y: by1 }, p4 = { x: bx2, y: by2 };
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) {
    if ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)) return true;
  }
  return false;
}

// Add this near the top with other state variables
let prevPos = { x: 0, y: 0 };

// Modify the checkGateCrossing function to be simpler and more reliable
function checkGateCrossing(oldPos, newPos) {
    // First check if we're using gates
    if (currentTrack.useGates) {
        if (!computedGates) return false;
        
        // For Belgium track, check direction before allowing crossing
        if (currentTrackKey === 'belgium') {
            if (lineIntersection(
                oldPos.x, oldPos.y,
                newPos.x, newPos.y,
                computedGates.start.x1, computedGates.start.y1,
                computedGates.start.x2, computedGates.start.y2
            )) {
                const moveVectorX = newPos.x - oldPos.x;
                if (moveVectorX < 0) {
                    return false; // Ignore right to left crossings
                }
                return 'start';
            }
            return false;
        }

        // For other tracks using gates
        if (computedGates.start && lineIntersection(
            oldPos.x, oldPos.y,
            newPos.x, newPos.y,
            computedGates.start.x1, computedGates.start.y1,
            computedGates.start.x2, computedGates.start.y2
        )) {
            return 'start';
        }
        
        if (!currentTrack.gates.sameStartFinish && computedGates.finish) {
            if (lineIntersection(
                oldPos.x, oldPos.y,
                newPos.x, newPos.y,
                computedGates.finish.x1, computedGates.finish.y1,
                computedGates.finish.x2, computedGates.finish.y2
            )) {
                return 'finish';
            }
        }
        return false;
    } else {
        // For tracks using timing line
        if (lineIntersection(
            oldPos.x, oldPos.y,
            newPos.x, newPos.y,
    timingLine.x1, timingLine.y1,
    timingLine.x2, timingLine.y2
  )) {
            // If lap is active, this is a finish. If not, this is a start
            return lapActive ? 'finish' : 'start';
        }
    }
    return false;
}

// --- Collision Detection with Buoys ---
function checkBuoyCollisions(){
  if (!lapActive || collidedThisLap) return;
  
  for (const b of buoys) {
    const dx   = b.x - pos.x;
    const dy   = b.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 12) {
      penaltySeconds += 10;
      collidedThisLap = true;
      AudioManager.playSound('collision')
          .catch(err => console.warn('Failed to play collision sound:', err));
      break;
    }
  }
}

// --- THROTTLE USAGE ---
function updateThrottleQueue(st, dt) {
  // st => turnStates entry
  const throttlePressed = !!keys['ArrowUp'];
  st.throttleQueue.push({ pressed: throttlePressed, dt: dt });
  st.queueTime += dt;

  // pop from front if exceed 0.5s
  while (st.queueTime > THROTTLE_WINDOW && st.throttleQueue.length > 0) {
    const oldest = st.throttleQueue.shift();
    st.queueTime -= oldest.dt;
  }
}

// --- APEX DETECTION ---
function checkBuoyApexes(dt) {
  buoys.forEach(b => {
    if (b.turnIndex == null) return; // not a turn buoy
    const st = turnStates[b.turnIndex];
    if (st.apexReached) return; // already done

    const dx = b.x - pos.x;
    const dy = b.y - pos.y;
    const dist = Math.hypot(dx, dy);

    // track line tightness
    if (dist < st.minDistance) {
      st.minDistance = dist;
    }

    // track throttle usage
    updateThrottleQueue(st, dt);

    // apex detection
    if (st.previousDistance == null) {
      st.previousDistance = dist;
      return;
    }
    if (dist > st.previousDistance) {
      // apex found
      st.apexReached = true;
      st.apexSpeed = speed * speedConversion;
      handleApexCommentary(b, st);
    } else {
      // still approaching
      st.previousDistance = dist;
    }
  });
}

function handleApexCommentary(buoy, st) {
  // measure how much throttle was engaged in last 0.5s
  let pressedTime = 0;
  for (let item of st.throttleQueue) {
    if (item.pressed) pressedTime += item.dt;
  }
  const fractionEngaged = (st.queueTime > 0) ? (pressedTime / st.queueTime) : 0;
  const throttleResult = (fractionEngaged > 0.6) ? "good" : "late";

  // compare apexSpeed with buoy.optimalSpeed if present
  let speedDiff = Infinity;
  if (typeof buoy.optimalSpeed === "number") {
    speedDiff = Math.abs(st.apexSpeed - buoy.optimalSpeed);
  }
  const nearOptimal = (speedDiff <= 25);

  // line tightness
  const tightLine = (st.minDistance < 15);

  // pick an event key
  let eventKey = "turn_generic";
  if (nearOptimal && tightLine && throttleResult === "good") {
    eventKey = "turn_optimalspeed_tightline_goodthrottle";
  } else if (nearOptimal && tightLine && throttleResult === "late") {
    eventKey = "turn_optimalspeed_tightline_latethrottle";
  } else if (nearOptimal && !tightLine) {
    eventKey = "turn_optimalspeed_wideline_" + throttleResult;
  }
  // etc. fallback => "turn_generic"

  playCommentary(eventKey);
}

// --- Update Function ---
function update(dt){
  // Store previous position before updating
  prevPos.x = pos.x;
  prevPos.y = pos.y;
  
  if (keys['ArrowUp']) {
    speed += accelRate * dt;
  }
  if (keys['ArrowDown']) {
    speed -= decelRate * dt;
  }
  speed = Math.max(0, Math.min(maxSpeed, speed));
  
  updateBankAngle(dt);
  
  const speedKmh = speed * speedConversion;
  const radius   = getTurnRadius(speedKmh, Math.abs(bankAngleDeg));
  const angleRad = (bankAngleDeg * Math.PI) / 180;
  const turnFactor = Math.sign(bankAngleDeg) * (Math.abs(angleRad) * turnGain) * ((1 / radius) + lowFactor);
  heading += turnFactor * dt;
  
  pos.x += speed * speedScale * dt * Math.cos(heading);
  pos.y += speed * speedScale * dt * Math.sin(heading);
  
  let wrapped = false;
  if (pos.x > canvas.width) { pos.x = 0; wrapped = true; }
  else if (pos.x < 0)       { pos.x = canvas.width; wrapped = true; }
  if (pos.y > canvas.height){ pos.y = 0; wrapped = true; }
  else if (pos.y < 0)       { pos.y = canvas.height; wrapped = true; }
  
  // Update wind volume based on speed and ensure it's playing
  AudioManager.ensureWindPlaying();
  AudioManager.sounds.wind.volume = speed / maxSpeed;
  
  document.getElementById('speedDisplay').innerText    = `Speed: ${speedKmh.toFixed(1)} km/h`;
  document.getElementById('bankAngleDisplay').innerText= `Bank: ${bankAngleDeg.toFixed(0)}°`;

  // Update ghost stats with the correct average speed
  if (currentGhost && showGhost) {
    // Make sure ghost stats are updated with the correct speed
    updateGhostStats();
  }
  
  if (!wrapped) {
    // Debug Sicily's directional crossing (if applicable)
    if (currentTrackKey === 'sicily') {
      debugDirectionalCrossing();
    }
    
    handleLapTiming();
  }
  
  if (lapActive) {
    if (speedKmh > topSpeedKmh) topSpeedKmh = speedKmh;
    if (speedKmh < minSpeedKmh) minSpeedKmh = speedKmh;
    sumSpeeds += speedKmh;
    frameCount++;
    
    const dx = pos.x - lastPosTelemetry.x;
    const dy = pos.y - lastPosTelemetry.y;
    const distPx = Math.hypot(dx, dy);
    // Calculate the distance directly from pixels to meters using the track scale
    const distM = distPx / currentTrack.scale;
    distanceTraveled += distM;
    lastPosTelemetry.x = pos.x;
    lastPosTelemetry.y = pos.y;
    
    checkBuoyCollisions();
    checkBuoyApexes(dt);

    const rawSec = (performance.now() - lapStartTime) / 1000;
    // Update currentLapTime continuously during active lap
    currentLapTime = rawSec;
    recordGhostData(rawSec);
    
    // Update lap time display
    updateLapTimeDisplay();
    } else {
    // Update lap time display for inactive lap
    updateLapTimeDisplay();
  }
}

// --- Wake Trail and Drawing ---
let wakeTrail = [];
function totalTrailDistance(trail){
  let d = 0;
  for (let i = 1; i < trail.length; i++){
    d += Math.hypot(
      trail[i].x - trail[i-1].x,
      trail[i].y - trail[i-1].y
    );
  }
  return d;
}

function drawWake(){
  // Draw player wake
  if (wakeTrail.length < 2) return;
  for (let i = 1; i < wakeTrail.length; i++){
    const t = i / wakeTrail.length;
    const alpha = t;
    ctx.beginPath();
    ctx.moveTo(wakeTrail[i-1].x, wakeTrail[i-1].y);
    ctx.lineTo(wakeTrail[i].x, wakeTrail[i].y);
    ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Draw ghost wake only during active laps
  if (lapActive && ghostWakeTrail.length >= 2) {
    for (let i = 1; i < ghostWakeTrail.length; i++){
      const t = i / ghostWakeTrail.length;
      const alpha = t;
      ctx.beginPath();
      ctx.moveTo(ghostWakeTrail[i-1].x, ghostWakeTrail[i-1].y);
      ctx.lineTo(ghostWakeTrail[i].x, ghostWakeTrail[i].y);
      ctx.strokeStyle = `rgba(255,136,255,${alpha.toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawTrack() {
  // Draw main track buoys (bottom track)
  buoys.forEach(b => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, 8, 0, 2*Math.PI);
    ctx.fillStyle = '#FFFF00';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();

    // Draw parallel track buoys (top track) if enabled
    if (currentTrack.parallelTrack) {
      const parallel = trackMetersToPixel(
        pixelToTrackMeters(b.x, b.y).x,
        pixelToTrackMeters(b.x, b.y).y + currentTrack.trackSeparation
      );
      ctx.beginPath();
      ctx.arc(parallel.x, parallel.y, 8, 0, 2*Math.PI);
      ctx.fillStyle = '#FFFF00';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  });

  // Draw timing system
  if (currentTrack.useGates) {
    // Draw main track gates (bottom)
    ctx.beginPath();
    ctx.moveTo(gates.start.x1, gates.start.y1);
    ctx.lineTo(gates.start.x2, gates.start.y2);
    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!currentTrack.gates.sameStartFinish) {
      ctx.beginPath();
      ctx.moveTo(gates.finish.x1, gates.finish.y1);
      ctx.lineTo(gates.finish.x2, gates.finish.y2);
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Draw parallel track gates (top) if enabled
    if (currentTrack.parallelTrack) {
      ctx.beginPath();
      ctx.moveTo(gates.parallelStart.x1, gates.parallelStart.y1);
      ctx.lineTo(gates.parallelStart.x2, gates.parallelStart.y2);
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 1;
      ctx.stroke();

      if (!currentTrack.gates.sameStartFinish) {
        ctx.beginPath();
        ctx.moveTo(gates.parallelFinish.x1, gates.parallelFinish.y1);
        ctx.lineTo(gates.parallelFinish.x2, gates.parallelFinish.y2);
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  } else {
    // Draw timing line
  ctx.beginPath();
  ctx.moveTo(timingLine.x1, timingLine.y1);
  ctx.lineTo(timingLine.x2, timingLine.y2);
    ctx.strokeStyle = '#FF0000';
  ctx.lineWidth = 1;
  ctx.stroke();
  }
}

function drawTelemetry() {
  ctx.save();
    ctx.font = '14px monospace';
  ctx.fillStyle = '#fff';
  let x = 20, y = 50;
    
    ctx.fillText(`${currentTrack.name} Telemetry:`, x, y);
  y += 20;
    
    const trackLaps = lapsMap.get(currentTrackKey) || [];
    
    if (trackLaps.length === 0) {
        ctx.fillText('No laps recorded', x, y);
    } else {
        trackLaps.forEach((lap, idx) => {
    // Calculate correct lap number: newest lap (idx 0) should have highest number
    const lapNumber = trackLaps.length - idx;
    ctx.fillText(`Lap ${lapNumber}:`, x, y);
    y += 18;
            if (lap.collided) {
                ctx.fillText(`  Time:   ${lap.finalTime.toFixed(2)} s  (+${penaltySeconds}s penalty!)`, x, y);
            } else {
    ctx.fillText(`  Time:   ${lap.finalTime.toFixed(2)} s`, x, y);
            }
    y += 18;
    ctx.fillText(`  Dist:   ${lap.distance.toFixed(1)} m`, x, y);
    y += 18;
    ctx.fillText(`  TopSpd: ${lap.topSpeed.toFixed(1)} km/h`, x, y);
    y += 18;
    ctx.fillText(`  MinSpd: ${lap.minSpeed.toFixed(1)} km/h`, x, y);
    y += 18;
    ctx.fillText(`  AvgSpd: ${lap.avgSpeed.toFixed(1)} km/h`, x, y);
    y += 24;
  });
    }
  ctx.restore();
}

function drawRacer() {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(heading - Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(0, 12.5);
  ctx.bezierCurveTo(4, 7.5, 4, -7.5, 0, -12.5);
  ctx.bezierCurveTo(-4, -7.5, -4, 7.5, 0, 12.5);
  ctx.closePath();
  ctx.fillStyle = '#00ccff';
  ctx.fill();
  ctx.restore();
}

// --- Ideal Line Toggle ---
let showIdealLine = false;
let idealLineData = null;

// Load the ideal line for the current track
function loadIdealLineForCurrentTrack() {
  const trackKey = currentTrackKey;
  
  // Reset ideal line data
  idealLineData = null;
  
  // If this track doesn't have an ideal line, don't try to load it
  if (!trackConfigs[trackKey].hasIdealLine) {
      return;
    }
  
  // Create a unique filename based on the track
  const filename = `${trackKey}_idealline.json`;
  
  // Try to load from localStorage first
  const storedData = localStorage.getItem(filename);
  if (storedData) {
    try {
      const data = JSON.parse(storedData);
    idealLineData = data;
      // Ideal line loaded from localStorage
      return;
    } catch (e) {
      // If there's an error parsing the data, proceed to load from server
    }
  }
  
  // Load from server
  fetch(`ideallines/${filename}`)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to load ideal line: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      idealLineData = data;
      // Store in localStorage for future use
      localStorage.setItem(filename, JSON.stringify(data));
      // Ideal line loaded from server
    })
    .catch(error => {
      console.warn('Error loading ideal line:', error);
    });
}

function drawIdealLine() {
  if (!showIdealLine) return;
  if (!idealLineData || !idealLineData.frames) return;

  if (idealLineData.trackKey && idealLineData.trackKey !== currentTrackKey) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
  ctx.lineWidth   = 1;
  ctx.beginPath();

  let started = false;
  for (let i = 0; i < idealLineData.frames.length; i++) {
    const frame = idealLineData.frames[i];
    const { x: px, y: py } = trackMetersToPixel(frame.x, frame.y);
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.restore();
}

// --- Main Game Loop ---
let lastTimestamp = 0;
let gamePaused = false;

function gameLoop(timestamp) {
  if (gamePaused) {
    requestAnimationFrame(gameLoop);
    return;
  }
  
  if (!lastTimestamp) lastTimestamp = timestamp;
  let dt = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;
  if (dt > 0.1) dt = 0.1;
  
  // Update player wake trail
  wakeTrail.push({ x: pos.x, y: pos.y });
  const targetWakeLength = (speed / maxSpeed) * 200;
  while (wakeTrail.length > 1 && totalTrailDistance(wakeTrail) > targetWakeLength) {
    wakeTrail.shift();
  }
  
  // Update game state
  update(dt);
  
  // Clear screen
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw in order of visual importance
  drawIdealLine();
  drawTrack();
  drawWake();
  drawGhostFrame(); // Ghost rendering has high priority
  drawRacer();
  drawTouchZones();
  drawTelemetry();
  
  requestAnimationFrame(gameLoop);
}

// --- Ghost Export / Import Controls ---
const exportGhostBtn  = document.getElementById('exportGhostBtn');
const importGhostFile = document.getElementById('importGhostFile');
const clearGhostBtn   = document.getElementById('clearGhostBtn');

exportGhostBtn.addEventListener('click', () => {
  if (!ghostDataMap.size > 0) {
    alert('No ghost data to export yet. Complete at least one lap.');
    return;
  }
  const jsonData = JSON.stringify(Array.from(ghostDataMap.values()));
  const blob = new Blob([jsonData], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href  = url;
  link.download = 'lapData.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});

// Add a new function to calculate average speed correctly
function calculateAverageSpeed(distance, time) {
    if (!time || time <= 0) return 0;
    return (distance / time) * 3.6; // Convert m/s to km/h
}

function updateGhostStats() {
    const statsElement = document.getElementById('ghostStats');
    if (!currentGhost) {
        statsElement.textContent = `No ghost for ${currentTrack.name}`;
        return;
    }
    
    // Get the lap time and recorded average speed if available
    const time = currentGhost.frames[currentGhost.frames.length - 1].finalLapTime;
    let avgSpeed = 0;
    
    // Try to get the average speed from stored ghost data
    if (currentGhost.avgSpeed !== undefined) {
        // Use pre-calculated average speed if available
        avgSpeed = currentGhost.avgSpeed;
    } else if (currentGhost.frames && currentGhost.frames.length > 0) {
        // If not available, try to calculate from frame data if possible
        // First check if frames have speed data
        if (currentGhost.frames[0].avgSpeedKmh !== undefined) {
            // Use the last frame's average speed
            const lastFrame = currentGhost.frames[currentGhost.frames.length - 1];
            avgSpeed = lastFrame.avgSpeedKmh || 0;
        } else {
            // Fall back to distance/time calculation as a last resort
            const distance = currentGhost.distance;
            if (distance && distance > 0) {
                avgSpeed = calculateAverageSpeed(distance, time);
            }
        }
    }
    
    statsElement.textContent = `${currentTrack.name} Ghost - Time: ${time.toFixed(2)}s, Avg Speed: ${avgSpeed.toFixed(1)} km/h`;
}

// Update the ghost import handler
importGhostFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
        const text = await file.text();
    const imported = JSON.parse(text);

        // Check if it's an array of track-specific ghosts
        if (Array.isArray(imported)) {
            // Handle array of ghosts (old format)
            imported.forEach(ghost => {
                if (ghost.trackKey && ghost.frames) {
                    ghostDataMap.set(ghost.trackKey, ghost);
                }
            });
        } else if (imported.trackKey && imported.frames) {
            // Handle single ghost data
            ghostDataMap.set(imported.trackKey, imported);
        } else {
            alert('Invalid ghost data file format.');
            return;
        }

        // Update ghost stats for current track
        currentGhost = ghostDataMap.get(currentTrackKey) || null;
        updateGhostStats();
    alert('Ghost data imported successfully! It will appear on your next lap.');
  } catch (err) {
    alert('Failed to read file: ' + err);
  }
});

// Update the checkbox handler
document.getElementById('keepGhost').addEventListener('change', function(e) {
    keepCurrentGhost = e.target.checked;
});

// Update the clear button handler
clearGhostBtn.addEventListener('click', () => {
  ghostDataMap.clear();
  ghostWakeTrail = [];
  document.getElementById('keepGhost').checked = false;
  keepCurrentGhost = false;
  // Set currentGhost to null to fully clear it
  currentGhost = null; 
  showGhost = false;
  // Update checkbox
  const showGhostCheckbox = document.getElementById('showGhost');
  if (showGhostCheckbox) {
    showGhostCheckbox.checked = false;
  }
  updateGhostStats();
  alert('Ghost data cleared.');
});

// Call this on initial load
updateGhostStats();

// --- Initialization ---
resizeCanvas();

// Parse URL parameters before initializing player position
parseURLParams();

// Initialize player position centered horizontally, higher above the lap time display
pos.x = (canvas.width / 2) - 4; // Shift 4px to the left
pos.y = canvas.height - 150; // Changed from 100 to 150 pixels up from bottom
heading = -Math.PI / 2; // Point upward (-90 degrees)

// Add drag and drop event handlers
const ghostControlsDiv = document.getElementById('ghostControls');

// Prevent default drag behaviors
ghostControlsDiv.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ghostControlsDiv.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
});

ghostControlsDiv.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ghostControlsDiv.style.backgroundColor = 'transparent';
});

// Handle the drop
ghostControlsDiv.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    ghostControlsDiv.style.backgroundColor = 'transparent';

    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.json')) {
        alert('Please drop a valid .json ghost file');
        return;
    }

    try {
        const text = await file.text();
        const imported = JSON.parse(text);

        // Check if it's an array of track-specific ghosts
        if (Array.isArray(imported)) {
            // Handle array of ghosts (old format)
            imported.forEach(ghost => {
                if (ghost.trackKey && ghost.frames) {
                    ghostDataMap.set(ghost.trackKey, ghost);
                }
            });
        } else if (imported.trackKey && imported.frames) {
            // Handle single ghost data
            ghostDataMap.set(imported.trackKey, imported);
        } else {
            alert('Invalid ghost data file format.');
            return;
        }

        // Update ghost stats for current track
        currentGhost = ghostDataMap.get(currentTrackKey) || null;
        updateGhostStats();
        alert('Ghost data imported successfully! It will appear on your next lap.');
    } catch (err) {
        alert('Failed to read file: ' + err);
    }
});

// Add near other initialization code
const touchControls = {
    activeZones: {
        leftUpper: false,  // Lean left
        leftLower: false,  // Lean right
        rightUpper: false, // Accelerate
        rightLower: false  // Decelerate
    },

    init() {
        canvas.addEventListener('touchstart', this.handleTouch.bind(this));
        canvas.addEventListener('touchmove', this.handleTouch.bind(this));
        canvas.addEventListener('touchend', this.handleTouchEnd.bind(this));
        canvas.addEventListener('touchcancel', this.handleTouchEnd.bind(this));
    },

    getZone(x, y) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const midX = width / 2;
        
        if (x < midX) {
            const slope = height / midX;
            const touchY = height - y;
            const lineY = slope * x;
            return touchY > lineY ? 'leftUpper' : 'leftLower';
        } else {
            const slope = height / midX;
            const touchY = y;
            const lineY = slope * (x - midX);
            return touchY < lineY ? 'rightUpper' : 'rightLower';
        }
    },

    handleTouch(e) {
        e.preventDefault();
        
        Object.keys(this.activeZones).forEach(zone => {
            this.activeZones[zone] = false;
        });

        for (let i = 0; i < e.touches.length; i++) {
            const touch = e.touches[i];
            const zone = this.getZone(touch.clientX, touch.clientY);
            this.activeZones[zone] = true;
        }

        if (this.activeZones.leftUpper) {
            keys['ArrowLeft'] = true;
            keys['ArrowRight'] = false;
        } else if (this.activeZones.leftLower) {
            keys['ArrowLeft'] = false;
            keys['ArrowRight'] = true;
        } else {
            keys['ArrowLeft'] = false;
            keys['ArrowRight'] = false;
        }

        if (this.activeZones.rightUpper) {
            keys['ArrowUp'] = true;
            keys['ArrowDown'] = false;
        } else if (this.activeZones.rightLower) {
            keys['ArrowUp'] = false;
            keys['ArrowDown'] = true;
        } else {
            keys['ArrowUp'] = false;
            keys['ArrowDown'] = false;
        }
    },

    handleTouchEnd(e) {
        if (e.touches.length === 0) {
            Object.keys(this.activeZones).forEach(zone => {
                this.activeZones[zone] = false;
            });
            keys['ArrowLeft'] = false;
            keys['ArrowRight'] = false;
            keys['ArrowUp'] = false;
            keys['ArrowDown'] = false;
        } else {
            this.handleTouch(e);
        }
    }
};

// Prevent default touch behaviors
document.addEventListener('touchmove', (e) => {
    e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => {
    e.preventDefault();
});

// Initialize touch controls if device supports touch
if ('ontouchstart' in window) {
    touchControls.init();
}

function drawTouchZones() {
    if (!('ontouchstart' in window)) return;
    
    const width = canvas.width;
    const height = canvas.height;
    const midX = width / 2;

    ctx.save();
    // Reduce opacity to 0.01
    ctx.globalAlpha = 0.01;
    
    // Left side zones
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(midX, 0);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = touchControls.activeZones.leftUpper ? '#fff' : '#666';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, height);
    ctx.lineTo(midX, 0);
    ctx.lineTo(midX, height);
    ctx.closePath();
    ctx.fillStyle = touchControls.activeZones.leftLower ? '#fff' : '#666';
    ctx.fill();

    // Right side zones - mirrored from left side
    // Upper right (accelerate)
    ctx.beginPath();
    ctx.moveTo(width, 0);
    ctx.lineTo(midX, 0);
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = touchControls.activeZones.rightUpper ? '#fff' : '#666';
    ctx.fill();

    // Lower right (decelerate)
    ctx.beginPath();
    ctx.moveTo(width, height);
    ctx.lineTo(midX, 0);
    ctx.lineTo(midX, height);
    ctx.closePath();
    ctx.fillStyle = touchControls.activeZones.rightLower ? '#fff' : '#666';
    ctx.fill();

    ctx.restore();
}

// Add these at the top with other state variables
let validCrossing = false;
let lastCrossingTime = 0;

function handleLapTiming() {
    const crossing = checkGateCrossing(prevPos, pos);
    
    if (!crossing) {
        // If directional gates and we're not actually crossing a gate,
        // check if we're moving away from the start line - helps reset validCrossing
        // if player backs away from the gate
        if (currentTrack.requiresDirectionalGates && validCrossing) {
            // Get distance to start gate
            if (computedGates && computedGates.start) {
                const gateMidX = (computedGates.start.x1 + computedGates.start.x2) / 2;
                const gateMidY = (computedGates.start.y1 + computedGates.start.y2) / 2;
                
                // Check if we're moving away from gate
                const distOld = Math.hypot(prevPos.x - gateMidX, prevPos.y - gateMidY);
                const distNew = Math.hypot(pos.x - gateMidX, pos.y - gateMidY);
                
                // If we're moving away from the gate by a significant amount
                if (distNew > distOld + 50) {
                    validCrossing = false;
                }
            }
        }
        return;
    }

    // Add debounce for crossing detection (500ms cooldown between detections)
    const now = performance.now();
    if (now - lastCrossingTime < 500) {
        return; // Ignore crossings that happen too quickly
    }
    
    // Update the last crossing time
    lastCrossingTime = now;

    if (currentTrack.useGates) {
        if (currentTrack.requiresDirectionalGates) {
            // Calculate crossing direction
            const moveVectorX = pos.x - prevPos.x;
            if (moveVectorX < 0) {
                // Moving right to left, reset valid crossing state
                validCrossing = false;
                return;
            }
            
            // Valid left-to-right crossing
            if (!validCrossing) {
                validCrossing = true;
                startLap();
            } else {
                completeLap();
                validCrossing = false;
            }
        } else {
            // Normal gate handling
            if (crossing === 'start' && !currentTrack.gates.sameStartFinish) {
                // Only start a new lap if no lap is currently active
                if (!lapActive) {
                    startLap();
                }
                // If a lap is active, ignore the start gate crossing
            } else if (crossing === 'finish' || (crossing === 'start' && currentTrack.gates.sameStartFinish)) {
                // Only complete lap if a lap is actually active
                if (!lapActive) {
                    return; // Ignore finish gate crossings when no lap is active
                }
                
                // Special handling for Sicily's directional finish gate
                if (currentTrackKey === 'sicily' && currentTrack.directionalFinishGate && crossing === 'finish') {
                    // Check if we're crossing from left to right (positive x movement)
                    const moveVectorX = pos.x - prevPos.x;
                    if (moveVectorX <= 0) {
                        // Moving right to left or vertically, ignore this crossing
                        return;
                    }
                }
                
                completeLap();
            }
        }
    } else {
        // Old timing line system
        if (crossing === 'start') {
            // Only start a new lap if no lap is currently active
            if (!lapActive) {
                startLap();
            }
            // If a lap is active, ignore the start crossing
        } else if (crossing === 'finish') {
            // Only complete lap if a lap is actually active
            if (lapActive) {
                completeLap();
            }
        }
    }
}

// Add new gate crossing detection that checks direction
function crossedGateInCorrectDirection(oldPos, newPos, gate) {
    // Create gate vector (from point 1 to point 2)
    const gateVector = {
        x: gate.x2 - gate.x1,
        y: gate.y2 - gate.y1
    };
    
    // Create movement vector
    const moveVector = {
        x: newPos.x - oldPos.x,
        y: newPos.y - oldPos.y
    };
    
    // Calculate cross product to determine direction
    // For 2D vectors, cross product is just: (a.x * b.y - a.y * b.x)
    const crossProduct = gateVector.x * moveVector.y - gateVector.y * moveVector.x;
    
    // Positive cross product means counter-clockwise, negative means clockwise
    return crossProduct < 0; // Return true if crossing from left to right relative to gate
}

// Update the initialization section to properly initialize prevPos
function resetTrack() {
    speed = 0;
    bankAngleDeg = 0;
    wakeTrail = [];
    
    pos.x = (canvas.width / 2) - 4; // Shift 4px to the left
    pos.y = canvas.height - 150;
    prevPos.x = pos.x;
    prevPos.y = pos.y;
    
    heading = -Math.PI / 2;
    validCrossing = false;
    
    idealLineData = null;
    showIdealLine = false;
    ghostWakeTrail = [];
}

function updateLapTimeDisplay() {
    const lapTimeStr = currentLapTime.toFixed(2);
    const penaltyText = collidedThisLap ? ` (+${penaltySeconds}s penalty!)` : '';
    document.getElementById('lapTimeDisplay').innerText = `Laptime: ${lapTimeStr}${penaltyText}`;
}

// Add with other initialization code
const highScoreManager = new HighScoreManager();

// Export these for highscores.js to use
export function pauseGame() {
    gamePaused = true;
}

export function resumeGame() {
    gamePaused = false;
    lastTimestamp = performance.now();  // Prevent time jump
}

requestAnimationFrame(gameLoop);

// Make these variables accessible globally for the highscore system
window.currentTrackKey = currentTrackKey;
window.trackConfigs = trackConfigs;
window.updateGhostStats = updateGhostStats;
window.keepCurrentGhost = keepCurrentGhost;
window.ghostDataMap = ghostDataMap;
window.startLap = startLap; // Expose startLap function

// Add a helper function to enable ghost racing for debugging
window.enableGhostRacing = function() {
  const ghost = ghostDataMap.get(currentTrackKey);
  if (ghost) {
    currentGhost = ghost;
    keepCurrentGhost = true;
    showGhost = true;
    
    // Update checkboxes if they exist
    const keepGhostCheckbox = document.getElementById('keepGhost');
    if (keepGhostCheckbox) {
      keepGhostCheckbox.checked = true;
    }
    
    const showGhostCheckbox = document.getElementById('showGhost');
    if (showGhostCheckbox) {
      showGhostCheckbox.checked = true;
    }
    
    updateGhostStats();
    return true;
  } else {
    console.log("No ghost data available for track: " + currentTrackKey);
    return false;
  }
};

// Add a helper to disable ghost racing too
window.disableGhostRacing = function() {
  showGhost = false;
  
  const showGhostCheckbox = document.getElementById('showGhost');
  if (showGhostCheckbox) {
    showGhostCheckbox.checked = false;
  }
  
  return true;
};

// Add this function after handleLapTiming function
function debugDirectionalCrossing() {
    // Only run in debug mode when Sicily track is active
    if (currentTrackKey !== 'sicily' || !currentTrack.directionalFinishGate) return;
    
    // Check if crossing the finish gate
    if (computedGates && computedGates.finish) {
        const isIntersecting = lineIntersection(
            prevPos.x, prevPos.y,
            pos.x, pos.y,
            computedGates.finish.x1, computedGates.finish.y1,
            computedGates.finish.x2, computedGates.finish.y2
        );
        
        if (isIntersecting) {
            // Check direction
            const moveVectorX = pos.x - prevPos.x;
            const isLeftToRight = moveVectorX > 0;
            
            console.log(`Sicily finish gate crossed: ${isLeftToRight ? 'LEFT TO RIGHT ✓' : 'RIGHT TO LEFT ✗'}`);
        }
    }
}

// Create fullscreen button
createFullscreenButton();
