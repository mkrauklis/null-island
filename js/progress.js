// Save data: per-world clear/best-moves progress, plus which command
// snippets the player has typed at least once (so the command palette
// knows what to turn into a clickable button). All localStorage-backed —
// this is a static site with no account system, so "save data" just means
// "this browser, this machine."

const PROGRESS_KEY = 'null-island:progress:v1';
const SNIPPETS_KEY = 'null-island:snippets:v1';
const ACHIEVEMENTS_KEY = 'null-island:achievements:v1';
const SEEDS_KEY = 'null-island:seeds:v1';
const CHARACTER_KEY = 'null-island:character:v1';

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
    return all[worldId] || { cleared: false, bestMoves: null, parMoves: null };
  },

  // Records a clear, keeping the lowest move count ever achieved. Returns
  // the updated { cleared, bestMoves, parMoves } for that world.
  recordClear(worldId, moves) {
    const all = this._load(PROGRESS_KEY) || {};
    const prev = all[worldId] || { cleared: false, bestMoves: null, parMoves: null };
    const bestMoves = prev.bestMoves === null ? moves : Math.min(prev.bestMoves, moves);
    all[worldId] = { ...prev, cleared: true, bestMoves };
    this._save(PROGRESS_KEY, all);
    return all[worldId];
  },

  // Levels are procedurally generated per player (see getSeed) so par isn't
  // a fixed constant — this caches the current layout's par alongside that
  // world's progress so World Select can show it without re-running that
  // world's whole generator.
  setWorldPar(worldId, parMoves) {
    const all = this._load(PROGRESS_KEY) || {};
    const prev = all[worldId] || { cleared: false, bestMoves: null, parMoves: null };
    all[worldId] = { ...prev, parMoves };
    this._save(PROGRESS_KEY, all);
  },

  // A per-world random seed, picked once and stuck to, so a player's layout
  // (and their best-moves history against it) stays stable across replays.
  getSeed(worldId) {
    const seeds = this._load(SEEDS_KEY) || {};
    if (seeds[worldId] == null) {
      seeds[worldId] = Math.floor(Math.random() * 2 ** 31);
      this._save(SEEDS_KEY, seeds);
    }
    return seeds[worldId];
  },

  isUnlocked(worldId, worldsInOrder) {
    const index = worldsInOrder.findIndex((w) => w.id === worldId);
    if (index <= 0) return true;
    for (let i = 0; i < index; i++) {
      if (!this.getWorld(worldsInOrder[i].id).cleared) return false;
    }
    return true;
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

  getAchievements() {
    return this._load(ACHIEVEMENTS_KEY) || [];
  },

  // Returns { list, isNew } — isNew is false if this id was already earned,
  // so callers can show a "new achievement" notice only when it's actually new.
  unlockAchievement(id) {
    const earned = this.getAchievements();
    if (earned.includes(id)) return { list: earned, isNew: false };
    earned.push(id);
    this._save(ACHIEVEMENTS_KEY, earned);
    return { list: earned, isNew: true };
  },

  getCharacter() {
    const saved = this._load(CHARACTER_KEY) || {};
    return {
      color: saved.color || 'orange',
      accessory: saved.accessory || 'none',
      skin: saved.skin || 'capuchin',
    };
  },

  setCharacter(character) {
    this._save(CHARACTER_KEY, character);
  },

  resetAll() {
    try {
      localStorage.removeItem(PROGRESS_KEY);
      localStorage.removeItem(SNIPPETS_KEY);
      localStorage.removeItem(ACHIEVEMENTS_KEY);
      localStorage.removeItem(SEEDS_KEY);
    } catch (e) {
      // ignore
    }
  },
};
