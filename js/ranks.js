// Player rank: a title computed from overall progress (worlds cleared,
// stars earned, achievements unlocked), not stored — always recomputed
// from Progress so it can never drift out of sync with the save data.
const RANKS = [
  { min: 0, title: 'Beginner' },
  { min: 16, title: 'Learner' },
  { min: 31, title: 'Technician' },
  { min: 46, title: 'Coded' },
  { min: 61, title: 'Hacked' },
  { min: 80, title: 'Webbed' },
];

function computeRankScore(worldsRegistry) {
  let score = 0;
  worldsRegistry.forEach((w) => {
    if (!w.built) return;
    const state = Progress.getWorld(w.id);
    if (!state.cleared) return;
    score += 10;
    const par = state.parMoves !== null && state.parMoves !== undefined ? state.parMoves : w.parMoves;
    if (par !== null && state.bestMoves <= par) score += 5;
  });
  score += Progress.getAchievements().length * 3;
  return score;
}

function computeRank(worldsRegistry) {
  const score = computeRankScore(worldsRegistry);
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (score >= r.min) rank = r;
  }
  const next = RANKS.find((r) => r.min > score);
  return { title: rank.title, score, next: next ? { title: next.title, pointsAway: next.min - score } : null };
}
