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
