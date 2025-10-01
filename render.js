// Draw the entire world
function drawWorld() {
  // Draw water
  ctx.fillStyle = '#0077be';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw course (buoys, ideal line, etc.)
  drawCourse();
  
  // Draw ghost wake trails
  drawGhostWake();
  
  // Draw ghost if enabled
  if (showGhost && currentGhost && raceInProgress) {
    drawGhost(ghostRider.x, ghostRider.y, ghostRider.heading);
  }
  
  // Draw player wake trail
  drawPlayerWake();
  
  // Draw player
  drawPlayer();
  
  // Draw UI elements
  drawSpeedometer();
  drawTimer();
}

// Draw the ghost wake trail
function drawGhostWake() {
  if (!showGhost || ghostWakeTrail.length < 2) return;
  
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  
  for (let i = 1; i < ghostWakeTrail.length; i++) {
    const t = i / ghostWakeTrail.length;
    
    ctx.beginPath();
    ctx.moveTo(ghostWakeTrail[i-1].x, ghostWakeTrail[i-1].y);
    ctx.lineTo(ghostWakeTrail[i].x, ghostWakeTrail[i].y);
    
    // Gradually fade the wake trail
    const alpha = 0.5 * (1 - t);
    ctx.strokeStyle = `rgba(255, 100, 255, ${alpha.toFixed(2)})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // Age the wake section
    ghostWakeTrail[i].age += 0.01;
  }
  
  // Remove old wake points
  ghostWakeTrail = ghostWakeTrail.filter(point => point.age < 1.0);
}

// Draw the ghost rider
function drawGhost(x, y, heading) {
  ctx.save();
  
  // Position at the ghost's location
  ctx.translate(x, y);
  ctx.rotate(heading);
  
  // Semi-transparent ghost
  ctx.globalAlpha = 0.6;
  
  // Draw ghost body
  ctx.beginPath();
  ctx.moveTo(0, 15);
  ctx.lineTo(10, -10);
  ctx.lineTo(-10, -10);
  ctx.closePath();
  ctx.fillStyle = '#ff00ff';
  ctx.fill();
  
  // Reset transparency
  ctx.globalAlpha = 1.0;
  
  ctx.restore();
}

// Draw the player wake trail
function drawPlayerWake() {
  if (playerWake.length < 2) return;
  
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  
  for (let i = 1; i < playerWake.length; i++) {
    const t = i / playerWake.length;
    
    ctx.beginPath();
    ctx.moveTo(playerWake[i-1].x, playerWake[i-1].y);
    ctx.lineTo(playerWake[i].x, playerWake[i].y);
    
    // Gradually fade the wake trail
    const alpha = 0.8 * (1 - t);
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(2)})`;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
}

// Draw the player
function drawPlayer() {
  ctx.save();
  
  // Position at the player's location
  ctx.translate(player.x, player.y);
  ctx.rotate(player.heading);
  
  // Draw player body
  ctx.beginPath();
  ctx.moveTo(0, 15);
  ctx.lineTo(10, -10);
  ctx.lineTo(-10, -10);
  ctx.closePath();
  ctx.fillStyle = '#00ffff';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.stroke();
  
  ctx.restore();
} 