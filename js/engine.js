// Shared engine: simulate a player's code against a level, then play back
// the resulting trace as an animation. See DESIGN.md for why simulate-then-
// replay is the execution model for these early, non-reactive worlds.

const TILE = { GROUND: 'ground', GAP: 'gap', GOAL: 'goal' };
const MAX_STEPS = 300;

// Runs `userCode` against `levelConfig` and returns a trace of every move,
// without touching the screen. Throws are caught and reported as `error`.
function simulateSideScroller(levelConfig, userCode) {
  const { columns, startCol } = levelConfig;
  const state = { col: startCol, alive: true, won: false };
  const trace = [{ col: state.col, event: 'start' }];
  let error = null;
  let steps = 0;

  function tileAt(col) {
    return columns[col] ?? null;
  }

  function guard() {
    steps++;
    if (steps > MAX_STEPS) {
      throw new Error('Too many moves — check for an infinite loop.');
    }
  }

  function step(newCol, action) {
    guard();
    if (!state.alive || state.won) return;
    const tile = tileAt(newCol);
    if (tile === null || tile === TILE.GAP) {
      state.alive = false;
      state.col = newCol;
      trace.push({ col: newCol, event: 'fell', action });
      return;
    }
    state.col = newCol;
    trace.push({ col: newCol, event: tile === TILE.GOAL ? 'goal' : 'move', action });
    if (tile === TILE.GOAL) state.won = true;
  }

  const api = {
    moveRight: () => step(state.col + 1, 'moveRight'),
    moveLeft: () => step(state.col - 1, 'moveLeft'),
    jump: () => step(state.col + 2, 'jump'),
  };

  try {
    const fn = new Function('moveRight', 'moveLeft', 'jump', userCode);
    fn(api.moveRight, api.moveLeft, api.jump);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error };
}

// Plays a trace back on a p5 canvas, one step at a time, and renders the
// level's tiles. One instance per level page.
class SideScrollerRunner {
  constructor(p, levelConfig, opts = {}) {
    this.p = p;
    this.level = levelConfig;
    this.tile = opts.tile || 48;
    this.groundY = opts.groundY || 260;
    this.stepTime = opts.stepTime || 0.35;
    this.trace = [{ col: levelConfig.startCol, event: 'start' }];
    this.playIndex = 0;
    this.playT = 0;
    this.playing = false;
    this.status = 'idle';
  }

  loadTrace(trace, success, errorMessage) {
    this.trace = trace;
    this.playIndex = 0;
    this.playT = 0;
    this.playing = trace.length > 1;
    this.finalSuccess = success;
    this.errorMessage = errorMessage;
    this.status = this.playing ? 'playing' : (errorMessage ? 'error' : 'idle');
  }

  update(dt) {
    if (!this.playing) return;
    this.playT += dt;
    if (this.playT >= this.stepTime) {
      this.playT = 0;
      this.playIndex++;
      if (this.playIndex >= this.trace.length - 1) {
        this.playing = false;
        const last = this.trace[this.trace.length - 1];
        if (this.errorMessage) this.status = 'error';
        else if (last.event === 'goal') this.status = 'won';
        else if (last.event === 'fell') this.status = 'fell';
        else this.status = 'idle';
      }
    }
  }

  currentCol() {
    const from = this.trace[this.playIndex];
    const to = this.trace[Math.min(this.playIndex + 1, this.trace.length - 1)];
    const t = this.playing ? Math.min(this.playT / this.stepTime, 1) : 1;
    return from.col + (to.col - from.col) * t;
  }

  isJumpingNow() {
    const to = this.trace[Math.min(this.playIndex + 1, this.trace.length - 1)];
    return this.playing && to.action === 'jump';
  }

  draw() {
    const p = this.p;
    p.background(10, 14, 20);

    this.level.columns.forEach((tile, i) => {
      const x = i * this.tile;
      if (tile === TILE.GAP) {
        p.noStroke();
        p.fill(20, 12, 16);
        p.rect(x, this.groundY, this.tile, this.tile * 2);
        return;
      }
      p.noStroke();
      p.fill(tile === TILE.GOAL ? p.color(61, 220, 132) : p.color(35, 41, 54));
      p.rect(x, this.groundY, this.tile, this.tile);
      if (tile === TILE.GOAL) {
        p.stroke(61, 220, 132);
        p.strokeWeight(2);
        p.line(x + this.tile / 2, this.groundY, x + this.tile / 2, this.groundY - this.tile);
        p.noStroke();
      }
    });

    const col = this.currentCol();
    const x = col * this.tile + this.tile / 2;
    const jumpArc = this.isJumpingNow() ? Math.sin(Math.min(this.playT / this.stepTime, 1) * Math.PI) * this.tile * 0.9 : 0;
    const y = this.groundY - this.tile / 2 - jumpArc;

    p.fill(240, 190, 70);
    p.circle(x, y, this.tile * 0.5);
  }
}
