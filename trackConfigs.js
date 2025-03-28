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

  sicily: {
	name: "Sicily",
	scale: 4,
	useGates: true,
	parallelTrack: true,
	trackSeparation: 80,
	directionalFinishGate: true,
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
	gates: {
	  sameStartFinish: false,
	  computeGates: function(trackMetersToPixel) {
		// Main track start gate (15m tall instead of 20m)
		const mainStartPos1 = trackMetersToPixel(75, 50);
		const mainStartPos2 = trackMetersToPixel(75, 65);  // Was 70
		const mainStart = {
		  x1: mainStartPos1.x,
		  y1: mainStartPos1.y,
		  x2: mainStartPos2.x,
		  y2: mainStartPos2.y
		};

		// Main track finish gate (15m tall)
		const mainFinishPos1 = trackMetersToPixel(75, -10);
		const mainFinishPos2 = trackMetersToPixel(75, 5);   // Was 10
		const mainFinish = {
		  x1: mainFinishPos1.x,
		  y1: mainFinishPos1.y,
		  x2: mainFinishPos2.x,
		  y2: mainFinishPos2.y
		};

		// Parallel track start gate (15m tall)
		const parallelStartPos1 = trackMetersToPixel(75, this.parent.trackSeparation + 50);
		const parallelStartPos2 = trackMetersToPixel(75, this.parent.trackSeparation + 65);  // Was +70
		const parallelStart = {
		  x1: parallelStartPos1.x,
		  y1: parallelStartPos1.y,
		  x2: parallelStartPos2.x,
		  y2: parallelStartPos2.y
		};

		// Parallel track finish gate (15m tall)
		const parallelFinishPos1 = trackMetersToPixel(75, this.parent.trackSeparation - 10);
		const parallelFinishPos2 = trackMetersToPixel(75, this.parent.trackSeparation + 5);  // Was +10
		const parallelFinish = {
		  x1: parallelFinishPos1.x,
		  y1: parallelFinishPos1.y,
		  x2: parallelFinishPos2.x,
		  y2: parallelFinishPos2.y
		};

		return {
		  start: mainStart,
		  finish: mainFinish,
		  parallelStart: parallelStart,
		  parallelFinish: parallelFinish
		};
	  }
	}
  },

  belgium: {
    name: "Belgium",
    scale: 4,
    useGates: true,
    requiresDirectionalGates: true,
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
    gates: {
      sameStartFinish: true,
      computeGates: function(trackMetersToPixel) {
        // Place the gate at the bottom of the track, vertically oriented
        const startFinish = {
          x1: trackMetersToPixel(191, -20).x,
          y1: trackMetersToPixel(191, -20).y,
          x2: trackMetersToPixel(191, 0).x,
          y2: trackMetersToPixel(191, 0).y
        };

        return {
          start: startFinish,
          finish: startFinish
        };
      }
    }
  }
};
