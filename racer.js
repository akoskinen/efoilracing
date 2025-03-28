// Main game loop
function gameLoop(timestamp) {
  // Calculate delta time
  const deltaTime = timestamp - lastTime;
  lastTime = timestamp;

  // Control physics only runs if game is not paused
  if (!isPaused) {
    // Physics update
    updatePhysics(deltaTime);
    
    // Handle collisions
    checkBoundaryCollisions();
    
    // Update timer if race is in progress
    if (raceInProgress) {
      updateRaceTimer(deltaTime);
    }
    
    // Record player position for ghost replay
    if (raceInProgress) {
      recordGhostFrame();
    }
    
    // Update ghost position if enabled
    if (showGhost && currentGhost && raceInProgress) {
      updateGhostPosition();
    }
  }
  
  // These always run, even when paused
  
  // Update camera
  updateCamera();
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw everything
  drawWorld();

  // Request next frame
  requestAnimationFrame(gameLoop);
}

// Ghost racing functionality
function recordGhostFrame() {
  if (!playerGhostData) {
    playerGhostData = [];
  }
  
  playerGhostData.push({
    time: raceTimer,
    x: player.x,
    y: player.y,
    heading: player.heading
  });
}

function updateGhostPosition() {
  if (!currentGhost || !currentGhost.frames || currentGhost.frames.length === 0) {
    return;
  }
  
  // Find the frame that corresponds to the current race time
  const ghostFrames = currentGhost.frames;
  let currentIndex = 0;
  let nextIndex = 1;
  
  // Find the frames that bracket the current time
  while (nextIndex < ghostFrames.length && ghostFrames[nextIndex].time < raceTimer) {
    currentIndex++;
    nextIndex++;
  }
  
  // If we've gone past the last frame, stay at the last position
  if (nextIndex >= ghostFrames.length) {
    ghostRider.x = ghostFrames[ghostFrames.length - 1].x;
    ghostRider.y = ghostFrames[ghostFrames.length - 1].y;
    ghostRider.heading = ghostFrames[ghostFrames.length - 1].heading;
    return;
  }
  
  // Interpolate between frames
  const currentFrame = ghostFrames[currentIndex];
  const nextFrame = ghostFrames[nextIndex];
  const frameDuration = nextFrame.time - currentFrame.time;
  
  if (frameDuration > 0) {
    const t = (raceTimer - currentFrame.time) / frameDuration;
    
    ghostRider.x = lerp(currentFrame.x, nextFrame.x, t);
    ghostRider.y = lerp(currentFrame.y, nextFrame.y, t);
    ghostRider.heading = lerpAngle(currentFrame.heading, nextFrame.heading, t);
    
    // Add wake trail points for the ghost
    if (ghostWakeTrail.length === 0 || 
        distance(ghostRider.x, ghostRider.y, ghostWakeTrail[ghostWakeTrail.length - 1].x, ghostWakeTrail[ghostWakeTrail.length - 1].y) > 10) {
      ghostWakeTrail.push({
        x: ghostRider.x,
        y: ghostRider.y,
        age: 0
      });
    }
  }
}

function enableGhostRacing() {
  showGhost = true;
  updateGhostStats();
}

function disableGhostRacing() {
  showGhost = false;
  keepCurrentGhost = false;
  ghostWakeTrail = [];
  updateGhostStats();
}

function updateGhostStats() {
  const statsElement = document.getElementById('ghostStats');
  if (statsElement) {
    if (showGhost && currentGhost && currentGhost.frames.length > 0) {
      // Find best lap time from ghost data
      const lastFrame = currentGhost.frames[currentGhost.frames.length - 1];
      const lapTime = lastFrame.finalLapTime || 0;
      const averageSpeed = lastFrame.avgSpeedKmh || 0;
      
      statsElement.textContent = `Ghost - Time: ${lapTime.toFixed(2)}s | Avg: ${averageSpeed.toFixed(1)} km/h`;
      statsElement.style.display = 'block';
    } else {
      statsElement.style.display = 'none';
    }
  }
}

// Save ghost data after completing a lap
function saveGhostData(trackKey, lapTime, distance) {
  if (!playerGhostData || playerGhostData.length === 0) return;
  
  // Add final lap data to each frame
  playerGhostData.forEach(frame => {
    frame.finalLapTime = lapTime;
  });
  
  // Store ghost data in the map
  const ghostData = {
    trackKey: trackKey,
    frames: playerGhostData
  };
  
  // Save to ghost map
  ghostDataMap.set(trackKey, ghostData);
  
  // Only set as current ghost if we want to keep showing it
  if (!keepCurrentGhost) {
    currentGhost = ghostData;
  }
}

// Handle checkpoint and lap completion
function handleCheckpointCrossed(cpIndex) {
  // Checkpoint sound
  playSound('checkpoint');
  
  // Update checkpoint marker
  const nextCheckpoint = (cpIndex + 1) % currentTrack.checkpoints.length;
  currentCheckpoint = cpIndex;
  nextCheckpointIndex = nextCheckpoint;
  
  // If this is the start/finish line and we've hit all checkpoints
  if (cpIndex === 0 && checkpointsHit.size === currentTrack.checkpoints.length - 1) {
    // Complete the lap
    completeLap();
    
    // Reset checkpoint tracking
    checkpointsHit.clear();
  } else {
    // Add this checkpoint to our hit list
    checkpointsHit.add(cpIndex);
  }
}

// Complete a lap
function completeLap() {
  const lapTime = raceTimer;
  raceTimer = 0;
  totalLaps++;
  
  // Calculate track completion
  const trackDistance = calculateTrackLength(currentTrack.checkpoints);
  
  // Save ghost data if this is the first lap or a better time
  if (!bestLapTime || lapTime < bestLapTime) {
    bestLapTime = lapTime;
    saveGhostData(currentTrackKey, lapTime, trackDistance);
    
    // Save to high scores
    highScores.addScore(currentTrackKey, {
      nickname: playerName,
      time: lapTime,
      distance: trackDistance,
      date: new Date(),
      ghostData: playerGhostData
    });
  }
  
  // Reset the ghost data for the next lap
  playerGhostData = [];
  
  // Show lap time
  displayLapTime(lapTime, bestLapTime);
  
  // Lap complete sound
  playSound('lapComplete');
} 