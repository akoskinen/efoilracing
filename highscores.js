import { pauseGame, resumeGame } from './engine.js';

export class HighScoreManager {
  constructor() {
    this.injectStyles();
    this.overlay = this.createOverlay();
    this.inputForm = this.createInputForm();
    this.scoreList = this.createScoreList();
    this.isVisible = false;
    this.setupListeners();
    this.transitionTimer = null; // Add a timer to track transitions
    this.gamePaused = false; // Track pause state
  }
  
  injectStyles() {
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      #highscore-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0);
        backdrop-filter: blur(0px);
        -webkit-backdrop-filter: blur(0px);
        display: none;
        justify-content: center;
        align-items: center;
        z-index: 1000;
        font-family: monospace;
        transition: background 0.7s ease, backdrop-filter 0.7s ease;
      }
      
      .highscore-overlay-visible {
        background: rgba(0, 0, 0, 0.7) !important;
        backdrop-filter: blur(8px) !important;
        -webkit-backdrop-filter: blur(8px) !important;
      }
      
      .highscore-input, .highscore-list {
        background: #111;
        padding: 20px;
        border: 1px solid #333;
        border-radius: 5px;
        color: #fff;
        opacity: 0;
        transform: translateY(-10px);
        transition: opacity 0.7s ease, transform 0.7s ease;
      }
      
      .highscore-content-visible {
        opacity: 1 !important;
        transform: translateY(0) !important;
      }
      
      .highscore-input {
        text-align: center;
      }
      
      .highscore-list {
        min-width: 300px;
      }
      
      .highscore-list h2 {
        text-align: center;
        margin-top: 0;
      }
      
      .highscore-input input {
        text-transform: uppercase;
        font-size: 24px;
        width: 100px;
        text-align: center;
        background: #222;
        border: 1px solid #444;
        color: #fff;
        padding: 5px;
        margin: 10px 0;
      }
      
      .highscore-list table {
        width: 100%;
        border-collapse: collapse;
      }
      
      .highscore-list th, .highscore-list td {
        padding: 5px;
        border-bottom: 1px solid #333;
      }
      
      .highscore-list th:first-child {
        text-align: left;
      }
      
      .highscore-list td:nth-child(2) {
        text-align: center;
      }
      
      .highscore-list td:nth-child(3) {
        text-align: right;
      }
      
      .challenge-btn {
        background: #333;
        border: none;
        color: #fff;
        padding: 2px 8px;
        cursor: pointer;
        transition: background 0.2s;
      }
      
      .challenge-btn:hover {
        background: #555;
      }
      
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      @keyframes fadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    document.head.appendChild(styleEl);
  }

  createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'highscore-overlay';
    document.body.appendChild(overlay);
    return overlay;
  }

  createInputForm() {
    const form = document.createElement('div');
    form.innerHTML = `
      <div class="highscore-input">
        <h2>New High Score!</h2>
        <p class="lap-time"></p>
        <input type="text" id="nickname-input" maxlength="4" placeholder="NAME" autocomplete="off">
        <div style="margin-top: 15px;">
          <button type="button" id="save-btn" onclick="window._tempSaveScore()" style="background: #007bff; color: white; border: none; padding: 8px 16px; font-size: 16px; cursor: pointer; margin-right: 10px; border-radius: 4px;">SAVE</button>
          <button type="button" id="cancel-btn" onclick="window._tempHideOverlay()" style="background: #555; color: white; border: none; padding: 8px 16px; font-size: 16px; cursor: pointer; border-radius: 4px;">CANCEL</button>
        </div>
      </div>
    `;
    return form;
  }

  createScoreList() {
    const list = document.createElement('div');
    list.innerHTML = `
      <div class="highscore-list">
        <h2>Top 15 - <span class="track-name"></span></h2>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Name</th>
              <th>Time</th>
              <th></th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    return list;
  }

  setupListeners() {
    // B key to toggle highscore display
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'b' && !this.overlay.contains(document.activeElement)) {
        this.toggleScoreList();
      }
      
      // ESC key to close the overlay
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
    try {
      // Make a copy with optimized ghost data
      const optimizedEntry = {
        nickname: entry.nickname,
        time: entry.time,
        distance: entry.distance,
        date: entry.date
      };
      
      // Optimize ghost data by reducing precision and sampling
      if (entry.ghostData && Array.isArray(entry.ghostData)) {
        // Only store a reduced subset of frames - no need for 60fps recording
        // Take roughly 5 frames per second 
        const sampledFrames = [];
        const interval = Math.max(1, Math.floor(entry.ghostData.length / 200)); // Max 200 frames
        
        for (let i = 0; i < entry.ghostData.length; i += interval) {
          if (sampledFrames.length >= 200) break; // Hard limit
          
          const frame = entry.ghostData[i];
          sampledFrames.push({
            time: Number(frame.time.toFixed(2)),
            x: Number(frame.x.toFixed(2)),
            y: Number(frame.y.toFixed(2)),
            heading: Number(frame.heading.toFixed(2))
          });
        }
        
        // Ensure we always include the last frame
        if (entry.ghostData.length > 0 && sampledFrames.length > 0) {
          const lastFrame = entry.ghostData[entry.ghostData.length - 1];
          sampledFrames.push({
            time: Number(lastFrame.time.toFixed(2)),
            x: Number(lastFrame.x.toFixed(2)),
            y: Number(lastFrame.y.toFixed(2)),
            heading: Number(lastFrame.heading.toFixed(2))
          });
        }
        
        optimizedEntry.ghostData = sampledFrames;
      }
      
      // Get existing scores and add the new one
      let scores = this.getScores(trackKey);
      scores.push(optimizedEntry);
      scores.sort((a, b) => a.time - b.time);
      scores = scores.slice(0, 15); // Keep top 15
      
      // Calculate storage needs and potentially prune ghost data from older entries
      const serialized = JSON.stringify(scores);
      if (serialized.length > 2000000) { // If approaching 2MB
        // Keep ghost data only for top 3 scores
        for (let i = 3; i < scores.length; i++) {
          delete scores[i].ghostData; // Remove ghost data from older entries
        }
      }
      
      localStorage.setItem(`highscores_${trackKey}`, JSON.stringify(scores));
      return true;
    } catch (err) {
      console.error("Error saving score:", err);
      
      // Last resort - try saving without any ghost data
      try {
        let scores = this.getScores(trackKey);
        const bareEntry = {
          nickname: entry.nickname,
          time: entry.time,
          date: entry.date
        };
        scores.push(bareEntry);
        scores.sort((a, b) => a.time - b.time);
        scores = scores.slice(0, 15);
        localStorage.setItem(`highscores_${trackKey}`, JSON.stringify(scores));
        return true;
      } catch (fallbackErr) {
        console.error("Complete failure to save score:", fallbackErr);
        return false;
      }
    }
  }

  showInputForm(lapTime, ghostData) {
    if (this.currentTrackKey === 'free') return;
    
    // Check if this time would make the top 15
    const scores = this.getScores(window.currentTrackKey);
    const wouldRank = scores.length < 15 || lapTime < scores[scores.length - 1].time;
    
    // If it's not a top 15 time, don't show the form
    if (!wouldRank) {
      return;
    }
    
    // Store values for later
    this.pendingScore = {
      time: lapTime,
      distance: this.calculateDistance(ghostData),
      date: new Date(),
      ghostData: ghostData
    };
    
    // Clear any existing timers
    this.cancelPendingTransitions();
    
    // Wait for 2 seconds after lap completion before showing the form
    setTimeout(() => {
      // Store instance reference in window for inline onclick handlers
      window._highScoreManager = this;
      
      // Global functions for inline handlers
      window._tempSaveScore = function() {
        const input = document.getElementById('nickname-input');
        const nickname = input ? input.value.trim().toUpperCase() : "UNKNOWN";
        
        setTimeout(() => {
          if (window._highScoreManager && window._highScoreManager.pendingScore) {
            try {
              window._highScoreManager.pendingScore.nickname = nickname;
              window._highScoreManager.saveScore(window.currentTrackKey, window._highScoreManager.pendingScore);
              window._highScoreManager.pendingScore = null;
              
              // Call hideOverlay to use the fade transition
              window._highScoreManager.hideOverlay();
            } catch (err) {
              console.error("Error saving score:", err);
            }
          } else {
            console.error("Missing highScoreManager or pendingScore");
          }
        }, 100);
      };
      
      window._tempHideOverlay = function() {
        // Use the hideOverlay method for the fade transition
        if (window._highScoreManager) {
          window._highScoreManager.hideOverlay();
        } else {
          // Fallback to direct hide
          const overlay = document.getElementById('highscore-overlay');
          if (overlay) overlay.style.display = 'none';
          
          // Resume game
          if (typeof resumeGame === 'function') {
            resumeGame();
          }
        }
      };
      
      // Show the overlay immediately with a fresh DOM
      this.overlay.innerHTML = '';
      this.overlay.appendChild(this.inputForm.cloneNode(true));
      this.overlay.style.display = 'flex';
      
      // Update the form to show the lap time
      this.overlay.querySelector('.lap-time').textContent = 
        `Lap Time: ${lapTime.toFixed(2)}s`;
      
      // Pause the game immediately
      pauseGame();
      this.gamePaused = true;
      
      // Setup input element for Enter key handling
      const inputField = this.overlay.querySelector('#nickname-input');
      if (inputField) {
        // Reset
        inputField.value = '';
        
        // Auto uppercase
        inputField.addEventListener('input', function() {
          this.value = this.value.toUpperCase();
        });
        
        // Add simple Enter key handler
        inputField.addEventListener('keypress', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            window._tempSaveScore();
          }
        });
        
        // Focus after DOM is ready
        setTimeout(() => {
          inputField.focus();
        }, 200);
      }
      
      // Add a small delay before starting the transition for better visual effect
      setTimeout(() => {
        // Make the overlay content visible with transition
        this.overlay.classList.add('highscore-overlay-visible');
        this.overlay.querySelector('.highscore-input').classList.add('highscore-content-visible');
      }, 50);
    }, 2000); // Wait 2 seconds after lap completion
  }

  calculateDistance(ghostData) {
    if (!ghostData || !Array.isArray(ghostData) || ghostData.length < 2) {
      return 0;
    }
    
    let totalDistance = 0;
    for (let i = 1; i < ghostData.length; i++) {
      const prev = ghostData[i - 1];
      const curr = ghostData[i];
      
      // Calculate Euclidean distance between points
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      totalDistance += Math.sqrt(dx * dx + dy * dy);
    }
    
    return totalDistance;
  }

  handleScoreSubmission(nickname) {
    if (this.pendingScore) {
      // Add the nickname to the score data
      this.pendingScore.nickname = nickname;
      
      // Add to high scores
      this.saveScore(window.currentTrackKey, this.pendingScore);
      
      // Clear the pending score
      this.pendingScore = null;
    }
    
    // Hide the form
    this.hideOverlay();
  }

  showScoreList(autoHide = false, trackKey = null) {
    // Use provided trackKey or get from global
    const currentTrackKey = trackKey || window.currentTrackKey;
    const trackConfigs = window.trackConfigs;
    
    // Clear any existing timers
    this.cancelPendingTransitions();
    
    this.overlay.innerHTML = '';
    this.overlay.appendChild(this.scoreList);
    this.overlay.style.display = 'flex';

    const tbody = this.scoreList.querySelector('tbody');
    tbody.innerHTML = '';
    
    const scores = this.getScores(currentTrackKey);
    
    if (scores.length === 0) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td colspan="4" style="text-align: center; padding: 10px;">No high scores yet!</td>
      `;
      tbody.appendChild(row);
    } else {
      scores.forEach((score, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${index + 1}</td>
          <td style="text-align: center">${score.nickname}</td>
          <td style="text-align: right">${score.time.toFixed(2)}s</td>
          <td>
            <button class="challenge-btn" data-index="${index}">Race</button>
          </td>
        `;
        tbody.appendChild(row);
      });
    }

    this.scoreList.querySelector('.track-name').textContent = 
      trackConfigs[currentTrackKey].name;

    // Add challenge button listeners
    const challengeBtns = tbody.querySelectorAll('.challenge-btn');
    challengeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const score = scores[parseInt(btn.dataset.index)];
        this.hideOverlay();
        
        // Format ghost data properly
        try {
          // First, ensure each frame has required fields
          const ghostFrames = score.ghostData ? score.ghostData.map(frame => ({
            time: frame.time || 0,
            x: frame.x || 0,
            y: frame.y || 0,
            heading: frame.heading || 0,
            finalLapTime: score.time
          })) : [];
          
          if (ghostFrames.length === 0) {
            console.warn("No ghost data available for this score");
            return;
          }
          
          // Sort frames by time to ensure proper sequence
          ghostFrames.sort((a, b) => a.time - b.time);
          
          // Create a properly formatted ghost object
          const formattedGhost = {
            trackKey: currentTrackKey,
            distance: score.distance,
            time: score.time,
            frames: ghostFrames
          };
          
          // Store the ghost in both places
          window.ghostDataMap.set(currentTrackKey, formattedGhost);
          window.currentGhost = formattedGhost;
          
          // Set flags
          window.showGhost = true;
          window.keepCurrentGhost = true;
          
          // Force ghost to show on next lap
          window.ghostWakeTrail = [];  // Clear any old wake trail
          
          // Update UI
          const keepGhostCheckbox = document.getElementById('keepGhost');
          if (keepGhostCheckbox) {
            keepGhostCheckbox.checked = true;
          }
          
          // Update ghost stats display
          if (typeof window.updateGhostStats === 'function') {
            window.updateGhostStats(); // Let the main engine's function calculate the right average speed
          } else {
            // Fallback if update function isn't available
            const statsElement = document.getElementById('ghostStats');
            if (statsElement) {
              const avgSpeed = score.time > 0 ? (score.distance / score.time) * 3.6 : 0;
              statsElement.textContent = `${score.nickname} - Time: ${score.time.toFixed(2)}s, Avg Speed: ${avgSpeed.toFixed(1)} km/h`;
            }
          }
          
          // Call enableGhostRacing to set up ghost
          if (typeof window.enableGhostRacing === 'function') {
            window.enableGhostRacing();
          }
        } catch (error) {
          console.error('Error setting up ghost:', error);
        }
        
        // Add a visual confirmation
        const notification = document.createElement('div');
        notification.textContent = `Racing against ${score.nickname}'s ghost (${score.time.toFixed(2)}s)`;
        notification.style.cssText = `
          position: fixed;
          bottom: 100px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0,0,0,0.7);
          color: white;
          padding: 10px 20px;
          border-radius: 5px;
          font-family: monospace;
          z-index: 100;
          animation: fadeOut 2s forwards;
        `;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 2000);
      });
    });
    
    // Add a small delay before starting transition
    setTimeout(() => {
      // Make the overlay content visible with transition
      this.overlay.classList.add('highscore-overlay-visible');
      this.scoreList.querySelector('.highscore-list').classList.add('highscore-content-visible');
      
      // Pause the game immediately instead of waiting for animation to complete
      pauseGame();
      this.gamePaused = true;
    }, 50);
  }

  hideOverlay() {
    // Cancel any pending transitions
    this.cancelPendingTransitions();
    
    // Resume the game immediately if it was paused
    if (this.gamePaused) {
      resumeGame();
      this.gamePaused = false;
    }
    
    // Fade out the overlay instead of hiding immediately
    this.overlay.classList.remove('highscore-overlay-visible');
    const content = this.overlay.querySelector('.highscore-input') || this.overlay.querySelector('.highscore-list');
    if (content) {
      content.classList.remove('highscore-content-visible');
    }
    
    // Set a timer to fully hide after animation completes
    this.transitionTimer = setTimeout(() => {
      this.overlay.style.display = 'none';
      this.overlay.innerHTML = '';
    }, 700); // Shorter than original 2s but enough to see the transition
  }

  cancelPendingTransitions() {
    // Clear any transition timers
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  toggleScoreList() {
    if (this.overlay.style.display === 'none' || !this.overlay.style.display) {
      this.showScoreList();
    } else {
      this.hideOverlay();
    }
  }
} 