// Save data: per-world clear/best-moves progress, plus which command
// snippets the player has typed at least once (so the command palette
// knows what to turn into a clickable button). All localStorage-backed —
// this is a static site with no account system, so "save data" just means
// "this browser, this machine."
//
// Multiple saves: everything below is scoped to a "slot" (one save file —
// its own worlds progress, achievements, snippets, seeds, and character
// look, all independent of any other slot's). The data keys that used to
// be the whole story are now just suffixes; _key() prefixes whichever slot
// is currently active. Slot bookkeeping itself (the slot list and which
// one is active) deliberately lives OUTSIDE that scoping — it has to be
// readable before you know which slot you're in.

const SLOTS_INDEX_KEY = 'null-island:slots:v1';
const ACTIVE_SLOT_KEY = 'null-island:active-slot:v1';
const LEGACY_KEYS = {
  progress: 'null-island:progress:v1',
  snippets: 'null-island:snippets:v1',
  achievements: 'null-island:achievements:v1',
  seeds: 'null-island:seeds:v1',
  character: 'null-island:character:v1',
};

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

  // Every per-slot key is this suffix, prefixed with whichever slot is
  // active. Bare `_load(this._key('wins'))` / `_save(this._key('wins'), x)`
  // is how every existing method below stays scoped to a slot without
  // having to think about slots at all.
  _key(suffix) {
    return `null-island:slot:${this.getActiveSlotId()}:${suffix}`;
  },

  // --- slots ---------------------------------------------------------

  _ensureSlots() {
    let slots = this._load(SLOTS_INDEX_KEY);
    if (slots && slots.length) return slots;

    // First run since this feature shipped: if there's real progress
    // sitting under the old un-prefixed keys, carry it into a new "Slot 1"
    // instead of orphaning it. Copies rather than deletes the legacy keys
    // — harmless leftovers, but never a silent data loss.
    const hasLegacyData = Object.values(LEGACY_KEYS).some((k) => localStorage.getItem(k) !== null);
    const id = 'slot_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    slots = [{ id, name: 'Slot 1', createdAt: Date.now() }];
    this._save(SLOTS_INDEX_KEY, slots);
    this._save(ACTIVE_SLOT_KEY, id);

    if (hasLegacyData) {
      Object.entries(LEGACY_KEYS).forEach(([suffix, legacyKey]) => {
        const value = this._load(legacyKey);
        if (value !== null) this._save(`null-island:slot:${id}:${suffix}`, value);
      });
    }
    return slots;
  },

  listSlots() {
    return this._ensureSlots();
  },

  getActiveSlotId() {
    let id = this._load(ACTIVE_SLOT_KEY);
    const slots = this._load(SLOTS_INDEX_KEY);
    if (id && slots && slots.some((s) => s.id === id)) return id;
    // Active pointer missing or stale (e.g. its slot was deleted elsewhere)
    // — fall back to ensuring at least one slot exists and use that.
    const ensured = this._ensureSlots();
    return this._load(ACTIVE_SLOT_KEY) || ensured[0].id;
  },

  getActiveSlot() {
    const id = this.getActiveSlotId();
    return this.listSlots().find((s) => s.id === id);
  },

  // Read-only summary of a slot that ISN'T necessarily the active one —
  // for a save picker showing every slot's progress without switching
  // into each one first.
  getSlotSummary(id) {
    const key = (suffix) => `null-island:slot:${id}:${suffix}`;
    const progress = this._load(key('progress')) || {};
    const worldsCleared = Object.values(progress).filter((w) => w && w.cleared).length;
    const character = this._load(key('character')) || {};
    return { worldsCleared, character };
  },

  createSlot(name) {
    const slots = this._ensureSlots();
    const id = 'slot_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    slots.push({ id, name: name || `Slot ${slots.length + 1}`, createdAt: Date.now() });
    this._save(SLOTS_INDEX_KEY, slots);
    this._save(ACTIVE_SLOT_KEY, id);
    return id;
  },

  switchActiveSlot(id) {
    const slots = this._ensureSlots();
    if (!slots.some((s) => s.id === id)) return false;
    this._save(ACTIVE_SLOT_KEY, id);
    return true;
  },

  renameSlot(id, name) {
    const slots = this._ensureSlots();
    const slot = slots.find((s) => s.id === id);
    if (!slot || !name) return false;
    slot.name = name;
    this._save(SLOTS_INDEX_KEY, slots);
    return true;
  },

  // Removes a slot and all six of its data keys. Never leaves zero slots —
  // if this was the last one, a fresh "Slot 1" takes its place so every
  // other method still has somewhere valid to read/write.
  deleteSlot(id) {
    let slots = this._ensureSlots();
    slots = slots.filter((s) => s.id !== id);
    Object.keys(LEGACY_KEYS).forEach((suffix) => {
      try { localStorage.removeItem(`null-island:slot:${id}:${suffix}`); } catch (e) { /* ignore */ }
    });
    if (!slots.length) {
      const newId = 'slot_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      slots = [{ id: newId, name: 'Slot 1', createdAt: Date.now() }];
      this._save(SLOTS_INDEX_KEY, slots);
      this._save(ACTIVE_SLOT_KEY, newId);
      return;
    }
    this._save(SLOTS_INDEX_KEY, slots);
    if (this._load(ACTIVE_SLOT_KEY) === id) {
      this._save(ACTIVE_SLOT_KEY, slots[0].id);
    }
  },

  // --- per-slot game data (unchanged behavior, now slot-scoped) ------

  getWorld(worldId) {
    const all = this._load(this._key('progress')) || {};
    return all[worldId] || { cleared: false, bestMoves: null, parMoves: null };
  },

  // Records a clear, keeping the lowest move count ever achieved. Returns
  // the updated { cleared, bestMoves, parMoves } for that world.
  recordClear(worldId, moves) {
    const all = this._load(this._key('progress')) || {};
    const prev = all[worldId] || { cleared: false, bestMoves: null, parMoves: null };
    const bestMoves = prev.bestMoves === null ? moves : Math.min(prev.bestMoves, moves);
    all[worldId] = { ...prev, cleared: true, bestMoves };
    this._save(this._key('progress'), all);
    return all[worldId];
  },

  // Levels are procedurally generated per player (see getSeed) so par isn't
  // a fixed constant — this caches the current layout's par alongside that
  // world's progress so World Select can show it without re-running that
  // world's whole generator.
  setWorldPar(worldId, parMoves) {
    const all = this._load(this._key('progress')) || {};
    const prev = all[worldId] || { cleared: false, bestMoves: null, parMoves: null };
    all[worldId] = { ...prev, parMoves };
    this._save(this._key('progress'), all);
  },

  // A per-world random seed, picked once and stuck to, so a player's layout
  // (and their best-moves history against it) stays stable across replays.
  getSeed(worldId) {
    const seeds = this._load(this._key('seeds')) || {};
    if (seeds[worldId] == null) {
      seeds[worldId] = Math.floor(Math.random() * 2 ** 31);
      this._save(this._key('seeds'), seeds);
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
    return this._load(this._key('snippets')) || [];
  },

  unlockSnippet(id) {
    const unlocked = this.getUnlockedSnippets();
    if (!unlocked.includes(id)) {
      unlocked.push(id);
      this._save(this._key('snippets'), unlocked);
    }
    return unlocked;
  },

  getAchievements() {
    return this._load(this._key('achievements')) || [];
  },

  // Returns { list, isNew } — isNew is false if this id was already earned,
  // so callers can show a "new achievement" notice only when it's actually new.
  unlockAchievement(id) {
    const earned = this.getAchievements();
    if (earned.includes(id)) return { list: earned, isNew: false };
    earned.push(id);
    this._save(this._key('achievements'), earned);
    return { list: earned, isNew: true };
  },

  getCharacter() {
    const saved = this._load(this._key('character')) || {};
    return {
      color: saved.color || 'orange',
      accessory: saved.accessory || 'none',
      skin: saved.skin || 'capuchin',
    };
  },

  setCharacter(character) {
    this._save(this._key('character'), character);
  },

  resetAll() {
    try {
      localStorage.removeItem(this._key('progress'));
      localStorage.removeItem(this._key('snippets'));
      localStorage.removeItem(this._key('achievements'));
      localStorage.removeItem(this._key('seeds'));
    } catch (e) {
      // ignore
    }
  },
};
