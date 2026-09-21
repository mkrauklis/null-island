// Player rank: a title based on how many times the whole game (all 6
// worlds) has been cleared — see Progress.checkForWin. Wins, not points:
// each rank up is one full playthrough, not incremental score.
const RANKS = [
  { min: 0, title: 'Beginner', color: [96, 189, 110] },
  { min: 3, title: 'Learner', color: [224, 142, 62] },
  { min: 5, title: 'Technician', color: [214, 69, 69] },
  { min: 7, title: 'Coded', color: [160, 160, 170] },
  { min: 10, title: 'Hacked', color: [161, 96, 204] },
  { min: 15, title: 'Webbed', color: [110, 200, 235] },
  { min: 25, title: 'Networked', color: [230, 90, 150] },
  { min: 50, title: 'Interwebbed', color: [224, 196, 90] },
  { min: 100, title: 'Darkwebbed', color: [90, 45, 145] },
  { min: 250, title: 'Code Ascendant', color: [240, 245, 255] },
  { min: 500, title: 'Error', color: [255, 45, 85] },
  { min: 1000, title: 'Voxelist', color: [140, 255, 90] },
];

function computeRank() {
  const wins = Progress.getWins();
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (wins >= r.min) rank = r;
  }
  const next = RANKS.find((r) => r.min > wins);
  return {
    title: rank.title,
    color: rank.color,
    wins,
    next: next ? { title: next.title, winsAway: next.min - wins } : null,
  };
}
