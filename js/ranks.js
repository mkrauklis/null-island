// Player rank: a title based on how many times the whole game (all 6
// worlds) has been cleared — see Progress.checkForWin. Wins, not points:
// each rank up is one full playthrough, not incremental score.
const RANKS = [
  { min: 0, title: 'Beginner' },
  { min: 3, title: 'Learner' },
  { min: 5, title: 'Technician' },
  { min: 7, title: 'Coded' },
  { min: 10, title: 'Hacked' },
  { min: 15, title: 'Webbed' },
];

function computeRank() {
  const wins = Progress.getWins();
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (wins >= r.min) rank = r;
  }
  const next = RANKS.find((r) => r.min > wins);
  return { title: rank.title, wins, next: next ? { title: next.title, winsAway: next.min - wins } : null };
}
