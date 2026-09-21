// Badges. Each world's own script decides when to check these (it knows
// what code/trace just won); this file is just the shared catalog plus,
// for the cross-world ones, the check itself.
const ACHIEVEMENTS = [
  { id: 'jumper', title: 'Leap of Faith', icon: '\u{1F998}', description: 'Use jump() to clear a level.' },
  { id: 'looper', title: 'Automator', icon: '\u{1F501}', description: 'Use a loop to clear a level.' },
  { id: 'compass', title: 'Compass Rose', icon: '\u{1F9ED}', description: 'Use all four directions — up, down, left, right — in one clear.' },
  { id: 'patient', title: 'Patience', icon: '\u{23F3}', description: 'Use wait() to clear a level.' },
  { id: 'decider', title: 'Decision Maker', icon: '\u{1F914}', description: 'Use an if statement to clear a level.' },
  { id: 'reuser', title: 'Reusable Parts', icon: '\u{1F527}', description: 'Define a function and call it more than once to clear a level.' },
  { id: 'lister', title: 'List Handler', icon: '\u{1F4CB}', description: 'Loop over switches() to clear a level.' },
  { id: 'fearless', title: 'Never Flinched', icon: '\u{1F3C3}', description: 'Clear The Core without ever calling wait() — timed every step past the tentacles perfectly.' },
  { id: 'backtracker', title: 'Second Thoughts', icon: '\u{21A9}\u{FE0F}', description: 'Move backward and still reach the goal.' },
  { id: 'perfectionist', title: 'Perfectionist', icon: '\u{2B50}', description: 'Clear a level in par — the fewest possible moves.' },
  { id: 'escapee', title: 'Island Escapee', icon: '\u{1F3DD}\u{FE0F}', description: 'Clear every area currently on the island.' },
  { id: 'malware', title: 'Ghost in the Machine', icon: '\u{1F9A0}', description: 'Reach the Malware rank (2250 wins).' },
];

// Cross-world: call after any clear is recorded. Returns newly-earned ids.
function checkEscapeeAchievement(worldsRegistry) {
  const built = worldsRegistry.filter((w) => w.built);
  const allCleared = built.every((w) => Progress.getWorld(w.id).cleared);
  if (allCleared && built.length > 0) {
    return Progress.unlockAchievement('escapee');
  }
  return { list: Progress.getAchievements(), isNew: false };
}
