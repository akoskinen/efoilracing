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
        transition: background 2s ease, backdrop-filter 2s ease;
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
        transition: opacity 2s ease, transform 2s ease;
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
        <input type="text" maxlength="4" pattern="[A-Z]*" placeholder="NAME">
        <p>Press ENTER to save</p>
        <p>Press ESC to cancel</p>
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

    // Handle input form submission
    const inputField = this.inputForm.querySelector('input');
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const nickname = inputField.value.trim().toUpperCase();
        if (nickname) {
          this.handleScoreSubmission(nickname);
          // Don't clear the input field - user prefers to keep it
        }
      }
      
      // Also allow ESC key to close the form when focused on input
      if (e.key === 'Escape') {
        this.hideOverlay();
      }
    });
  }

  getScores(trackKey) {
    const scores = localStorage.getItem(`highscores_${trackKey}`);
    return scores ? JSON.parse(scores) : [];
  }

  saveScore(trackKey, entry) {
    let scores = this.getScores(trackKey);
    scores.push(entry);
    scores.sort((a, b) => a.time - b.time);
    scores = scores.slice(0, 15); // Keep top 15
    localStorage.setItem(`highscores_${trackKey}`, JSON.stringify(scores));
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
    
    // Delay showing the overlay to allow telemetry to update
    setTimeout(() => {
      this.overlay.innerHTML = '';
      this.overlay.appendChild(this.inputForm);
      this.overlay.style.display = 'flex';
      
      // Update the form to show the lap time
      this.inputForm.querySelector('.lap-time').textContent = 
        `Lap Time: ${lapTime.toFixed(2)}s`;
      
      // Trigger the fade-in effect
      setTimeout(() => {
        this.overlay.classList.add('highscore-overlay-visible');
        this.inputForm.querySelector('.highscore-input').classList.add('highscore-content-visible');
        
        // Pause the game immediately instead of waiting for animation
        pauseGame();
        this.gamePaused = true;
        
        // Focus on the input field
        const inputField = this.inputForm.querySelector('input');
        if (inputField) {
          inputField.focus();
        }
      }, 50);
    }, 1000); // Allow 1 second for telemetry to update
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
          const ghostFrames = score.ghostData.map(frame => ({
            time: frame.time || 0,
            x: frame.x || 0,
            y: frame.y || 0,
            heading: frame.heading || 0,
            avgSpeedKmh: score.time > 0 ? (score.distance / score.time) * 3.6 : 0,
            finalLapTime: score.time
          }));
          
          // Sort frames by time to ensure proper sequence
          ghostFrames.sort((a, b) => a.time - b.time);
          
          // Create a properly formatted ghost object
          const formattedGhost = {
            trackKey: currentTrackKey,
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
          const statsElement = document.getElementById('ghostStats');
          if (statsElement) {
            statsElement.textContent = `${score.nickname} - Time: ${score.time.toFixed(2)}s`;
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
    
    // Trigger the fade-in effect
    setTimeout(() => {
      this.overlay.classList.add('highscore-overlay-visible');
      this.scoreList.querySelector('.highscore-list').classList.add('highscore-content-visible');
      
      // Pause the game immediately instead of waiting for animation
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
    
    // Fade out the overlay
    this.overlay.classList.remove('highscore-overlay-visible');
    const content = this.overlay.querySelector('.highscore-input') || this.overlay.querySelector('.highscore-list');
    if (content) {
      content.classList.remove('highscore-content-visible');
    }
    
    // Don't wait for animation to complete to hide the overlay
    // Just set a shorter timeout
    this.transitionTimer = setTimeout(() => {
      this.overlay.style.display = 'none';
      this.overlay.innerHTML = '';
    }, 500); // Much shorter timeout (500ms instead of 2000ms)
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
