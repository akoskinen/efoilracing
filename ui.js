// Add a ghost toggle to the UI
function createGhostControls() {
  // Container for ghost controls
  const ghostContainer = document.createElement('div');
  ghostContainer.id = 'ghostControls';
  ghostContainer.style.cssText = `
    position: absolute;
    bottom: 20px;
    right: 20px;
    background-color: rgba(0, 0, 0, 0.6);
    padding: 10px;
    border-radius: 5px;
    color: white;
    font-family: monospace;
    z-index: 5;
  `;

  // Ghost stats display
  const ghostStats = document.createElement('div');
  ghostStats.id = 'ghostStats';
  ghostStats.style.cssText = `
    margin-bottom: 8px;
    font-size: 12px;
    display: none;
  `;
  ghostContainer.appendChild(ghostStats);

  // Create controls
  const controls = document.createElement('div');
  controls.style.cssText = `
    display: flex;
    align-items: center;
    gap: 10px;
  `;

  // Ghost toggle
  const ghostLabel = document.createElement('label');
  ghostLabel.style.cssText = 'display: flex; align-items: center; cursor: pointer; font-size: 12px;';
  
  const ghostToggle = document.createElement('input');
  ghostToggle.type = 'checkbox';
  ghostToggle.id = 'showGhost';
  ghostToggle.checked = window.showGhost || false;
  ghostToggle.style.cssText = 'margin-right: 5px;';
  
  ghostLabel.appendChild(ghostToggle);
  ghostLabel.appendChild(document.createTextNode('Show Ghost'));
  
  // Keep ghost toggle
  const keepGhostLabel = document.createElement('label');
  keepGhostLabel.style.cssText = 'display: flex; align-items: center; cursor: pointer; font-size: 12px;';
  
  const keepGhostToggle = document.createElement('input');
  keepGhostToggle.type = 'checkbox';
  keepGhostToggle.id = 'keepGhost';
  keepGhostToggle.checked = window.keepCurrentGhost || false;
  keepGhostToggle.style.cssText = 'margin-right: 5px;';
  
  keepGhostLabel.appendChild(keepGhostToggle);
  keepGhostLabel.appendChild(document.createTextNode('Keep Current'));

  // Add event listeners
  ghostToggle.addEventListener('change', function() {
    window.showGhost = this.checked;
    if (this.checked) {
      window.enableGhostRacing();
    } else {
      window.disableGhostRacing();
    }
  });
  
  keepGhostToggle.addEventListener('change', function() {
    window.keepCurrentGhost = this.checked;
  });

  // Add controls to container
  controls.appendChild(ghostLabel);
  controls.appendChild(keepGhostLabel);
  ghostContainer.appendChild(controls);

  // Add to UI
  document.body.appendChild(ghostContainer);
} 