// trackConfigs.js

export const trackConfigs = {
  speedTrack: {
	name: "Speedtrack",
	scale: 4, // conversion factor from meters to pixels
	useGates: false,
	// For speedTrack, we use the first buoy as the start of the timing line
	computeTimingLine: function(buoys, canvas) {
	  return {
		x1: buoys[0].x,
		y1: buoys[0].y,
		x2: canvas.width / 2,
		y2: canvas.height
	  };
	},
	gates: {
	  sameStartFinish: true,
	  computeGates: function(buoys, canvas) {
		return {
		  finish: {
			x1: buoys[0].x,
			y1: buoys[0].y,
			x2: canvas.width / 2,
			y2: canvas.height
		  }
		};
	  }
	},
	buoys: [
	  {
		x: 20,
		y: 15,
		// No turnIndex here, since it's just the timing line buoy
		turnIndex: null,
		// Maybe physically known as #1 and #5, so:
		aliases: [1, 5],
		apexRadius: 40
	  },
	  {
		x: 81.43,
		y: 48.56,
		// This buoy is encountered twice (e.g., #2 and #4)
		turnIndex: 2,
		aliases: [2, 4],
		// Example radius for apex detection if you want
		apexRadius: 40,
		optimalSpeed: 30 // in km/h
	  },
	  {
		x: 125,
		y: 15,
		// We'll call this turn #3
		turnIndex: 3,
		aliases: [3],
		apexRadius: 40,
		optimalSpeed: 30 // in km/h
	  }
	]
  },

  dubaiTrack: {
	name: "Dubai",
	scale: 4,
	useGates: false,
	// For dubaiTrack, the timing line starts at the buoy closest to the bottom
	computeTimingLine: function(buoys, canvas) {
	  // Find the buoy with the largest 'y' value (after converting to pixel coords)
	  let bottomBuoy = buoys[0];
	  buoys.forEach(b => {
		if (b.y > bottomBuoy.y) {
		  bottomBuoy = b;
		}
	  });
	  return {
		x1: bottomBuoy.x,
		y1: bottomBuoy.y,
		x2: canvas.width / 2,
		y2: canvas.height
	  };
	},
	gates: {
	  sameStartFinish: true,
	  computeGates: function(buoys, canvas) {
		// Find the buoy with the largest 'y' value
		let bottomBuoy = buoys[0];
		buoys.forEach(b => {
		  if (b.y > bottomBuoy.y) {
			bottomBuoy = b;
		  }
		});
		return {
		  finish: {
			x1: bottomBuoy.x,
			y1: bottomBuoy.y,
			x2: canvas.width / 2,
			y2: canvas.height
		  }
		};
	  }
	},
	buoys: [
	  // Goal Area with 2 lane separators
	  { x: 55,  y: 1 },
	  { x: 75,  y: 0 },
	  { x: 95,  y: 1 },

	  // Bottom center parable
	  { x: 55,  y: 21 },
	  { x: 75,  y: 21 },
	  { x: 95,  y: 21 },
	
	  // Turn 4 Top Left
	  { x: 35,  y: 55 },
	  { x: 35,  y: 75 },
	  { x: 15,  y: 75 },
	
	  // Turn 1 (bottom right)
	  { x: 150, y: 5 },
	  { x: 140, y: 25 },
	  
	  // Turn 2 Top Right
	  { x: 135, y: 75 },
	  { x: 115, y: 75 },
	  { x: 115, y: 55 },
	
	  // Turn 5 bottom left
	  { x: 10,  y: 25 },
	  { x: 0,   y: 5 }
	]
  },

  // Declarative format (see trackSchema.js) — gates defined in track meters.
  sicily: {
	name: "Sicily",
	scale: 4,
	parallelTrack: true,
	trackSeparation: 80,
	buoys: [
	  // Bottom track buoys
	  {
		x: 150,
		y: 60,    // Was 40
		turnIndex: 1,
		aliases: [1],
		apexRadius: 40,
		optimalSpeed: 30
	  },
	  {
		x: 0,
		y: 40,    // Was 20
		turnIndex: 2,
		aliases: [2],
		apexRadius: 40,
		optimalSpeed: 30
	  },
	  {
		x: 150,
		y: 20,    // Was 0
		turnIndex: 3,
		aliases: [3],
		apexRadius: 40,
		optimalSpeed: 30
	  },
	  {
		x: 0,
		y: 0,     // Was -20
		turnIndex: 4,
		aliases: [4],
		apexRadius: 40,
		optimalSpeed: 30
	  }
	],
	gate: {
	  sameStartFinish: false,
	  directional: false,
	  directionalFinish: true,
	  direction: { x: 1, y: 0 },
	  start:  { x1: 75, y1: 50,  x2: 75, y2: 65 },
	  finish: { x1: 75, y1: -10, x2: 75, y2: 5 }
	}
  },

  belgium: {
    name: "Belgium",
    scale: 4,
    buoys: [
      {
        x: 191,  // Starting from buoy 1
        y: 0,
        turnIndex: 1,
        aliases: [1],
        apexRadius: 40,
        optimalSpeed: 30
      },
      {
        x: 191, // About 65m from buoy 1
        y: 65,  // About 65m up from buoy 1
        turnIndex: 2,
        aliases: [2],
        apexRadius: 40,
        optimalSpeed: 30
      },
      {
        x: 76,  // About 115m from buoy 2
        y: 40, // Following the distances in the image
        turnIndex: 3,
        aliases: [3],
        apexRadius: 40,
        optimalSpeed: 30
      },
      {
        x: 0,   // About 77m from buoy 3
        y: 10,  // Forms the left loop of the figure-8
        turnIndex: 4,
        aliases: [4],
        apexRadius: 40,
        optimalSpeed: 30
      }
    ],
    gate: {
      sameStartFinish: true,
      directional: true,
      direction: { x: 1, y: 0 },
      start: { x1: 191, y1: -20, x2: 191, y2: 0 }
    }
  }
};
