// commentary.js

// 1) Define the dictionary of eventKey -> array of possible audio paths
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

  // New apex/turn triggers:
  turn_optimalspeed_tightline_good: [
	"commentary/ak/turn_optimalspeed_tightline_goodthrottle/throttle_good_1.mp3",
	"commentary/ak/turn_optimalspeed_tightline_goodthrottle/throttle_good_2.mp3"
  ],
  turn_optimalspeed_tightline_late: [
	"commentary/ak/turn_optimalspeed_tightline_latethrottle/throttle_late_1.mp3",
	"commentary/ak/turn_optimalspeed_tightline_latethrottle/throttle_late_2.mp3"
  ],
  turn_optimalspeed_wideline_good: [
	"commentary/ak/turn_optimalspeed_wideline_goodthrottle/wideline_1.mp3"
  ],
  turn_optimalspeed_wideline_late: [
	"commentary/ak/turn_optimalspeed_wideline_latethrottle/tightline_1.mp3"
  ],

  // Fallback or generic commentary
  turn_generic: [
	"commentary/ak/turn_generic/ok_1.mp3",
	"commentary/ak/turn_generic/herewego_1.mp3"
  ]

  // Add more event keys as needed
};

export function playCommentary(eventKey) {
  const clips = commentaryClips[eventKey];
  if (!clips || !clips.length) {
	console.warn("No commentary clips for eventKey:", eventKey);
	return;
  }

  // pick a random file
  const index = Math.floor(Math.random() * clips.length);
	const audioPath = clips[index];
	const audio = new Audio(audioPath);
	audio.volume = 1.0;
	audio.play().catch(err => {
	  console.warn("Failed to play commentary clip:", audioPath, err);
	});
  }