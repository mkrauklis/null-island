// Save data: per-world clear/best-moves progress, plus which command
// snippets the player has typed at least once (so the command palette
// knows what to turn into a clickable button). All localStorage-backed —
// this is a static site with no account system, so "save data" just means
// "this browser, this machine."

const PROGRESS_KEY = 'null-island:progress:v1';
const SNIPPETS_KEY = 'null-island:snippets:v1';

const Progress = {
  _load(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  },

  _save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // storage unavailable (private browsing, quota) — play on without saving
    }
  },

  getWorld(worldId) {
    const all = this._load(PROGRESS_KEY) || {};
    return all[worldId] || { cleared: false, bestMoves: null };
  },

  // Records a clear, keeping the lowest move count ever achieved. Returns
  // the updated { cleared, bestMoves } for that world.
  recordClear(worldId, moves) {
    const all = this._load(PROGRESS_KEY) || {};
    const prev = all[worldId] || { cleared: false, bestMoves: null };
    const bestMoves = prev.bestMoves === null ? moves : Math.min(prev.bestMoves, moves);
    all[worldId] = { cleared: true, bestMoves };
    this._save(PROGRESS_KEY, all);
    return all[worldId];
  },

  isUnlocked(worldId, worldsInOrder) {
    const index = worldsInOrder.findIndex((w) => w.id === worldId);
    if (index <= 0) return true;
    return this.getWorld(worldsInOrder[index - 1].id).cleared;
  },

  getUnlockedSnippets() {
    return this._load(SNIPPETS_KEY) || [];
  },

  unlockSnippet(id) {
    const unlocked = this.getUnlockedSnippets();
    if (!unlocked.includes(id)) {
      unlocked.push(id);
      this._save(SNIPPETS_KEY, unlocked);
    }
    return unlocked;
  },

  resetAll() {
    try {
      localStorage.removeItem(PROGRESS_KEY);
      localStorage.removeItem(SNIPPETS_KEY);
    } catch (e) {
      // ignore
    }
  },
};
