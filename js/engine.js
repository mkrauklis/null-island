// Shared engine: simulate a player's code against a level, then play back
// the resulting trace as an animation. See DESIGN.md for why simulate-then-
// replay is the execution model for these early, non-reactive worlds.
//
// The simulation step (simulateSideScroller) decides WHICH discrete grid
// column each command lands on — that's the teaching-facing contract and
// stays fixed. Everything below it (SideScrollerRunner) is free to animate
// the trip between those columns with as much real physics as we want
// without changing what a level of code "means".

const TILE_TYPE = { GROUND: 'ground', GAP: 'gap', GOAL: 'goal' };
const MAX_STEPS = 300;

// Deterministic PRNG (mulberry32) — every level is randomized, but seeded,
// so a given seed always regenerates the exact same layout. See
// Progress.getSeed: a player's seed is picked once and stuck to, so their
// "best moves"/par history stays about one consistent layout instead of a
// new one every reload.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic Fisher-Yates using a seeded rng() (0..1) rather than Math.random.
function shuffleWithRng(array, rng) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Parses `code` with Acorn (if loaded) purely to locate syntax errors before
// ever running it, since `new Function(...)`'s thrown SyntaxError doesn't
// reliably carry a usable line/column across browsers. Returns null if the
// code parses fine (or Acorn isn't available — execution still catches
// errors, just without a highlighted location in that fallback case).
function findSyntaxError(code) {
  if (typeof acorn === 'undefined') return null;
  try {
    acorn.parse(code, { ecmaVersion: 2020 });
    return null;
  } catch (e) {
    return {
      line: e.loc ? e.loc.line : 1,
      column: e.loc ? e.loc.column : 0,
      message: e.message,
    };
  }
}

// Reveals the "Next World" CTA on a win. Assumes the level-page convention
// levels/<id>/index.html and that worlds-registry.js is loaded on the page.
function renderNextWorldLink(worldId) {
  const btn = document.getElementById('next-world-btn');
  if (!btn || typeof WORLDS === 'undefined') return;
  const index = WORLDS.findIndex((w) => w.id === worldId);
  const next = WORLDS[index + 1];
  if (next && next.built) {
    btn.href = '../' + next.id + '/index.html';
    btn.textContent = 'Next: ' + next.title + ' →';
  } else {
    btn.href = '../../worlds.html';
    btn.textContent = next ? 'More worlds coming soon →' : 'Back to World Select →';
  }
  btn.classList.add('visible');
}

// Shows a small "new achievement" line for any ids in `newlyEarnedIds`.
// Expects achievements.js's ACHIEVEMENTS catalog to be loaded.
function announceAchievements(newlyEarnedIds) {
  const el = document.getElementById('achievement-notice');
  if (!el || !newlyEarnedIds.length || typeof ACHIEVEMENTS === 'undefined') return;
  const names = newlyEarnedIds
    .map((id) => ACHIEVEMENTS.find((a) => a.id === id))
    .filter(Boolean)
    .map((a) => `${a.icon} ${a.title}`);
  if (names.length) {
    el.innerHTML = 'New achievement: ' + names.join(', ');
  }
}

// Strips // and /* */ comments before the command palette scans code for
// "has the player typed this yet" — otherwise a command mentioned in the
// level's own starter comment unlocks itself for free.
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

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
    if (tile === null || tile === TILE_TYPE.GAP) {
      state.alive = false;
      state.col = newCol;
      trace.push({ col: newCol, event: 'fell', action });
      return;
    }
    state.col = newCol;
    trace.push({ col: newCol, event: tile === TILE_TYPE.GOAL ? 'goal' : 'move', action });
    if (tile === TILE_TYPE.GOAL) state.won = true;
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

// True minimum number of actions to clear a side-scroller level, via BFS
// over columns. Used for the "par" shown on the world-select screen and to
// decide whether a clear earns a star — computed, not guessed, so it can't
// drift out of sync with the level data or with what the sim actually
// allows (e.g. jump() isn't restricted to only work over an actual gap).
function computeMinMoves(levelConfig) {
  const { columns, startCol } = levelConfig;
  const n = columns.length;
  function tileAt(c) { return columns[c] ?? null; }
  const dist = new Array(n).fill(Infinity);
  dist[startCol] = 0;
  const queue = [startCol];
  let qi = 0;
  let goalDist = Infinity;
  while (qi < queue.length) {
    const col = queue[qi++];
    if (tileAt(col) === TILE_TYPE.GOAL) { goalDist = Math.min(goalDist, dist[col]); continue; }
    for (const step of [1, 2, -1]) {
      const nc = col + step;
      if (nc < 0 || nc >= n) continue;
      const t = tileAt(nc);
      if (t === null || t === TILE_TYPE.GAP) continue;
      if (dist[nc] > dist[col] + 1) {
        dist[nc] = dist[col] + 1;
        queue.push(nc);
      }
    }
  }
  return goalDist;
}

// --- physics/animation tuning -------------------------------------------
const GRAVITY = 2600; // px/s^2, drives the jump arc
const JUMP_VELOCITY = 620; // px/s, initial upward speed of a jump
const JUMP_DURATION = (2 * JUMP_VELOCITY) / GRAVITY; // time to land, derived not guessed
const WALK_STEP_TIME = 0.28; // seconds to walk one tile
const FALL_GRAVITY = 2200; // px/s^2, drives the death-fall once off the edge

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

// Deterministic pseudo-random in [0,1) from an integer seed — used for tile
// rivets/parallax so the scenery doesn't reshuffle every frame.
function hash01(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Plays a trace back on a p5 canvas, one step at a time, with real gravity
// on the jump arc and the death fall, plus a scrolling camera so bigger
// future levels don't need a wider canvas.
class SideScrollerRunner {
  constructor(p, levelConfig, opts = {}) {
    this.p = p;
    this.level = levelConfig;
    this.tile = opts.tile || 48;
    this.viewportW = opts.viewportW || 480;
    this.viewportH = opts.viewportH || 320;
    this.groundY = opts.groundY || 240;
    this.cameraX = 0;
    this.trace = [{ col: levelConfig.startCol, event: 'start' }];
    this.stepIndex = 0;
    this.stepElapsed = 0;
    this.playing = false;
    this.status = 'idle';
    this.fallPhase = false;
    this.fallElapsed = 0;
    this._buildLayers();
  }

  levelWidthPx() {
    return this.level.columns.length * this.tile;
  }

  loadTrace(trace, success, errorMessage) {
    this.trace = trace;
    this.stepIndex = 0;
    this.stepElapsed = 0;
    this.playing = trace.length > 1;
    this.finalSuccess = success;
    this.errorMessage = errorMessage;
    this.fallPhase = false;
    this.fallElapsed = 0;
    this.status = this.playing ? 'playing' : (errorMessage ? 'error' : 'idle');
  }

  currentStepDuration() {
    const to = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    return to && to.action === 'jump' ? JUMP_DURATION : WALK_STEP_TIME;
  }

  update(dt) {
    if (this.playing) {
      this.stepElapsed += dt;
      const dur = this.currentStepDuration();
      if (this.stepElapsed >= dur) {
        this.stepElapsed = 0;
        this.stepIndex++;
        if (this.stepIndex >= this.trace.length - 1) {
          this.playing = false;
          const last = this.trace[this.trace.length - 1];
          if (this.errorMessage) this.status = 'error';
          else if (last.event === 'goal') this.status = 'won';
          else if (last.event === 'fell') { this.status = 'fell'; this.fallPhase = true; }
          else this.status = 'idle';
        }
      }
    } else if (this.fallPhase) {
      this.fallElapsed += dt;
    }

    const pos = this.playerPos();
    const targetCam = clamp(
      pos.x - this.viewportW / 2,
      0,
      Math.max(0, this.levelWidthPx() - this.viewportW)
    );
    const smoothing = 1 - Math.exp(-dt * 8);
    this.cameraX += (targetCam - this.cameraX) * smoothing;
  }

  // Position of the player in LEVEL space (before camera offset), plus
  // enough info to pose the sprite (jumping/walking/falling).
  playerPos() {
    const from = this.trace[this.stepIndex];
    const to = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const dur = this.currentStepDuration();
    const t = this.playing ? clamp(this.stepElapsed / dur, 0, 1) : 1;

    const fromX = from.col * this.tile + this.tile / 2;
    const toX = to.col * this.tile + this.tile / 2;
    const baseY = this.groundY - this.tile / 2;

    if (this.fallPhase) {
      const dy = 0.5 * FALL_GRAVITY * this.fallElapsed * this.fallElapsed;
      return { x: toX, y: baseY + dy, jumping: false, falling: true, walkT: 0 };
    }

    if (to.action === 'jump') {
      const time = t * JUMP_DURATION;
      const rise = JUMP_VELOCITY * time - 0.5 * GRAVITY * time * time;
      return { x: lerp(fromX, toX, t), y: baseY - rise, jumping: true, falling: false, walkT: t };
    }

    const te = easeInOutQuad(t);
    const bob = Math.sin(t * Math.PI) * 3;
    return { x: lerp(fromX, toX, te), y: baseY - bob, jumping: false, falling: false, walkT: t };
  }

  _buildLayers() {
    const p = this.p;
    this.scanlines = p.createGraphics(this.viewportW, this.viewportH);
    this.scanlines.noStroke();
    this.scanlines.fill(0, 0, 0, 28);
    for (let y = 0; y < this.viewportH; y += 4) {
      this.scanlines.rect(0, y, this.viewportW, 1);
    }

    this.vignette = p.createGraphics(this.viewportW, this.viewportH);
    const ctx = this.vignette.drawingContext;
    const g = ctx.createRadialGradient(
      this.viewportW / 2, this.viewportH / 2, this.viewportH * 0.35,
      this.viewportW / 2, this.viewportH / 2, this.viewportH * 0.75
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.viewportW, this.viewportH);
  }

  draw() {
    const p = this.p;
    this._drawSky();
    this._drawParallax();

    p.push();
    p.translate(-Math.round(this.cameraX), 0);
    this._drawTiles();
    this._drawPlayer();
    p.pop();

    p.image(this.scanlines, 0, 0);
    p.image(this.vignette, 0, 0);
  }

  _drawSky() {
    const p = this.p;
    for (let y = 0; y < this.viewportH; y++) {
      const t = y / this.viewportH;
      const c = p.lerpColor(p.color(8, 11, 18), p.color(16, 21, 32), t);
      p.stroke(c);
      p.line(0, y, this.viewportW, y);
    }
  }

  _drawParallax() {
    const p = this.p;
    p.push();
    p.translate(-Math.round(this.cameraX * 0.3), 0);
    p.noStroke();
    const spacing = 90;
    const count = Math.ceil((this.viewportW / 0.3 + this.cameraX) / spacing) + 4;
    for (let i = 0; i < count; i++) {
      const x = i * spacing + 20;
      const h = 60 + hash01(i) * 90;
      const w = 34 + hash01(i + 50) * 18;
      p.fill(20, 25, 36, 200);
      p.rect(x, this.groundY - h, w, h, 2);
      p.fill(60, 200, 150, 40 + hash01(i + 100) * 40);
      const lightCount = 2 + Math.floor(hash01(i + 200) * 3);
      for (let j = 0; j < lightCount; j++) {
        p.rect(x + 4, this.groundY - h + 8 + j * 14, w - 8, 3);
      }
    }
    p.pop();
  }

  _drawTiles() {
    const p = this.p;
    this.level.columns.forEach((tile, i) => {
      const x = i * this.tile;
      if (tile === TILE_TYPE.GAP) {
        p.noStroke();
        const ctx = p.drawingContext;
        const grad = ctx.createLinearGradient(0, this.groundY, 0, this.groundY + this.tile * 1.6);
        grad.addColorStop(0, 'rgba(8,6,10,1)');
        grad.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = grad;
        ctx.fillRect(x, this.groundY, this.tile, this.tile * 1.6);

        p.fill(230, 180, 40);
        const stripeW = 8;
        for (let sx = -this.tile; sx < this.tile; sx += stripeW * 2) {
          p.quad(
            x + sx, this.groundY - 4,
            x + sx + stripeW, this.groundY - 4,
            x + sx + stripeW - 5, this.groundY,
            x + sx - 5, this.groundY
          );
        }
        return;
      }

      p.noStroke();
      p.fill(tile === TILE_TYPE.GOAL ? p.color(28, 48, 40) : p.color(34, 40, 52));
      p.rect(x, this.groundY, this.tile, this.tile);
      p.fill(255, 255, 255, 18);
      p.rect(x, this.groundY, this.tile, 3);

      p.fill(10, 13, 18, 160);
      const rivets = 2;
      for (let r = 0; r < rivets; r++) {
        const rx = x + this.tile * (0.28 + r * 0.44);
        const ry = this.groundY + this.tile * (0.35 + hash01(i * 3 + r) * 0.4);
        p.circle(rx, ry, 3.5);
      }

      if (tile === TILE_TYPE.GOAL) {
        const pulse = 0.5 + 0.5 * Math.sin(p.millis() * 0.004);
        const cx = x + this.tile / 2;
        p.stroke(61, 220, 132, 180);
        p.strokeWeight(3);
        p.line(cx, this.groundY, cx, this.groundY - this.tile * 1.6);
        p.noStroke();
        p.fill(61, 220, 132, 60 + pulse * 80);
        p.circle(cx, this.groundY - this.tile * 1.6, 14 + pulse * 6);
        p.fill(61, 220, 132);
        p.circle(cx, this.groundY - this.tile * 1.6, 7);
      }
    });
  }

  _drawPlayer() {
    const p = this.p;
    const pos = this.playerPos();
    if (pos.falling && pos.y > this.groundY + this.tile * 3) return;

    const shadowScale = pos.falling ? 0 : clamp(1 - (this.groundY - this.tile / 2 - pos.y) / 140, 0.15, 1);
    p.noStroke();
    p.fill(0, 0, 0, 90 * shadowScale);
    p.ellipse(pos.x, this.groundY + 2, this.tile * 0.5 * shadowScale, this.tile * 0.16 * shadowScale);

    p.push();
    p.translate(pos.x, pos.y);
    if (pos.falling) p.rotate(Math.min(this.fallElapsed * 2, 1.4));

    const legSwing = pos.jumping || pos.falling ? 0 : Math.sin(pos.walkT * Math.PI * 2) * 7;
    p.stroke(210, 220, 235);
    p.strokeWeight(3);
    p.line(-4, 10, -4 + legSwing * 0.4, 18);
    p.line(4, 10, 4 - legSwing * 0.4, 18);

    p.noStroke();
    p.fill(224, 168, 64);
    p.rect(-9, -12, 18, 22, 5);

    p.fill(30, 34, 44);
    p.rect(-7, -8, 14, 8, 3);
    const glow = 0.6 + 0.4 * Math.sin(p.millis() * 0.006);
    p.fill(90, 220, 255, 180 + glow * 60);
    p.rect(-5, -6.5, 10, 4, 2);

    p.pop();
  }
}

// --- top-down grid maze (World 2 onward) ---------------------------------
//
// Same simulate-then-replay contract as the side-scroller. The one new
// idea is a Scanner enemy: its position is a deterministic function of the
// tick number (it patrols a fixed, precomputed path and repeats), so it can
// still be fully resolved at simulate time — no live/reactive execution
// needed yet. See DESIGN.md's open question about when that changes.

const GRID_STEP_TIME = 0.3; // seconds per tick, movement or wait alike

function scannerPositionAt(scanner, tick) {
  if (!scanner) return null;
  return scanner.path[tick % scanner.path.length];
}

// Runs `userCode` against a grid level and returns a trace of every tick.
function simulateGridMaze(levelConfig, userCode) {
  const { grid, start, goal, scanner } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const state = { row: start.row, col: start.col, alive: true, won: false };
  const trace = [{ row: state.row, col: state.col, event: 'start', tick: 0 }];
  let error = null;
  let steps = 0;

  function isFloor(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
  }

  function guard() {
    steps++;
    if (steps > MAX_STEPS) {
      throw new Error('Too many moves — check for an infinite loop.');
    }
  }

  function step(newRow, newCol, action) {
    guard();
    if (!state.alive || state.won) return;
    const tick = trace.length;
    if (!isFloor(newRow, newCol)) {
      state.alive = false;
      trace.push({ row: newRow, col: newCol, event: 'blocked', action, tick });
      return;
    }
    state.row = newRow;
    state.col = newCol;
    const scanPos = scannerPositionAt(scanner, tick);
    if (scanPos && scanPos.row === newRow && scanPos.col === newCol) {
      state.alive = false;
      trace.push({ row: newRow, col: newCol, event: 'caught', action, tick });
      return;
    }
    const atGoal = newRow === goal.row && newCol === goal.col;
    trace.push({ row: newRow, col: newCol, event: atGoal ? 'goal' : 'move', action, tick });
    if (atGoal) state.won = true;
  }

  const api = {
    moveRight: () => step(state.row, state.col + 1, 'moveRight'),
    moveLeft: () => step(state.row, state.col - 1, 'moveLeft'),
    moveUp: () => step(state.row - 1, state.col, 'moveUp'),
    moveDown: () => step(state.row + 1, state.col, 'moveDown'),
    wait: () => step(state.row, state.col, 'wait'),
  };

  try {
    const fn = new Function('moveRight', 'moveLeft', 'moveUp', 'moveDown', 'wait', userCode);
    fn(api.moveRight, api.moveLeft, api.moveUp, api.moveDown, api.wait);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error };
}

// True minimum ticks to clear a grid level, including any Scanner. State is
// (row, col, tick mod scanner period) since the scanner's future is fully
// determined by the tick number modulo its patrol length — that keeps the
// search space finite even though the scanner never actually stops moving.
function computeMinMovesGrid(levelConfig) {
  const { grid, start, goal, scanner } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const period = scanner ? scanner.path.length : 1;

  function isFloor(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
  }
  function hits(r, c, tick) {
    const s = scannerPositionAt(scanner, tick);
    return s && s.row === r && s.col === c;
  }

  const visited = new Set([`${start.row},${start.col},0`]);
  const queue = [{ row: start.row, col: start.col, tickMod: 0, dist: 0 }];
  const deltas = [[0, 1], [0, -1], [-1, 0], [1, 0], [0, 0]];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (cur.row === goal.row && cur.col === goal.col) return cur.dist;
    if (cur.dist > MAX_STEPS) continue;
    for (const [dr, dc] of deltas) {
      const nr = cur.row + dr;
      const nc = cur.col + dc;
      if (!isFloor(nr, nc)) continue;
      const nextDist = cur.dist + 1;
      if (hits(nr, nc, nextDist)) continue;
      const nextTickMod = (cur.tickMod + 1) % period;
      const key = `${nr},${nc},${nextTickMod}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ row: nr, col: nc, tickMod: nextTickMod, dist: nextDist });
    }
  }
  return Infinity;
}

// Carves a perfect maze (recursive backtracker) into a wall/floor tile grid
// sized (2*mazeRows+1) x (2*mazeCols+1) — the standard trick of giving every
// maze "cell" its own row/col plus a wall row/col between neighbors, so a
// carved passage is just clearing the wall tile between two cell tiles.
// Shared by World 2 (a plain maze) and World 3 (a maze with a chaser).
function generateMaze(mazeRows, mazeCols, rng) {
  const rows = mazeRows * 2 + 1;
  const cols = mazeCols * 2 + 1;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill('wall'));
  const visited = Array.from({ length: mazeRows }, () => new Array(mazeCols).fill(false));

  function carve(cr, cc) {
    visited[cr][cc] = true;
    grid[cr * 2 + 1][cc * 2 + 1] = 'floor';
    const dirs = shuffleWithRng([[0, 1], [0, -1], [1, 0], [-1, 0]], rng);
    for (const [dr, dc] of dirs) {
      const nr = cr + dr;
      const nc = cc + dc;
      if (nr < 0 || nr >= mazeRows || nc < 0 || nc >= mazeCols || visited[nr][nc]) continue;
      grid[cr * 2 + 1 + dr][cc * 2 + 1 + dc] = 'floor';
      carve(nr, nc);
    }
  }
  carve(0, 0);
  return grid;
}

// The one shortest-path rule a chaser needs: given its own cell and the
// cell it's chasing, take one step toward it. Recomputing a full BFS from
// the target every call is wasteful but these mazes are tiny, so it's not
// worth caching against how much simpler this stays.
function bfsDistanceMap(grid, target) {
  const rows = grid.length;
  const cols = grid[0].length;
  const dist = Array.from({ length: rows }, () => new Array(cols).fill(Infinity));
  dist[target.row][target.col] = 0;
  const queue = [[target.row, target.col]];
  let qi = 0;
  const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  while (qi < queue.length) {
    const [r, c] = queue[qi++];
    for (const [dr, dc] of deltas) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (grid[nr][nc] === 'wall') continue;
      if (dist[nr][nc] > dist[r][c] + 1) {
        dist[nr][nc] = dist[r][c] + 1;
        queue.push([nr, nc]);
      }
    }
  }
  return dist;
}

function chaseStep(grid, from, to) {
  if (from.row === to.row && from.col === to.col) return from;
  const dist = bfsDistanceMap(grid, to);
  const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  let best = from;
  let bestDist = dist[from.row][from.col];
  for (const [dr, dc] of deltas) {
    const nr = from.row + dr;
    const nc = from.col + dc;
    if (nr < 0 || nr >= grid.length || nc < 0 || nc >= grid[0].length) continue;
    if (grid[nr][nc] === 'wall') continue;
    if (dist[nr][nc] < bestDist) {
      bestDist = dist[nr][nc];
      best = { row: nr, col: nc };
    }
  }
  return best;
}

// Same simulate-then-replay contract as simulateGridMaze, but the enemy
// isn't on a fixed patrol — it takes one greedy step toward the player's
// new position after every player action. Still fully deterministic (and
// so still resolvable at simulate time, no live execution needed) because
// it only ever reacts to moves the player has already committed to in
// their code, never to real-time state the simulator doesn't have.
function simulateGridMazeChase(levelConfig, userCode) {
  const { grid, start, goal, octopusStart } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const state = { row: start.row, col: start.col, octo: { ...octopusStart }, alive: true, won: false };
  const trace = [{ row: state.row, col: state.col, octoRow: state.octo.row, octoCol: state.octo.col, event: 'start', tick: 0 }];
  let error = null;
  let steps = 0;

  function isFloor(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
  }
  function guard() {
    steps++;
    if (steps > MAX_STEPS) {
      throw new Error('Too many moves — check for an infinite loop.');
    }
  }
  function pushTrace(event, action) {
    trace.push({ row: state.row, col: state.col, octoRow: state.octo.row, octoCol: state.octo.col, event, action, tick: trace.length });
  }

  function step(newRow, newCol, action) {
    guard();
    if (!state.alive || state.won) return;
    const tick = trace.length;
    if (!isFloor(newRow, newCol)) {
      state.alive = false;
      state.row = newRow;
      state.col = newCol;
      pushTrace('blocked', action);
      return;
    }
    state.row = newRow;
    state.col = newCol;

    if (state.row === state.octo.row && state.col === state.octo.col) {
      state.alive = false;
      pushTrace('caught', action);
      return;
    }

    // Half the player's speed (moves on even ticks only) — at full speed a
    // same-speed shortest-path chaser can corner the player with no escape
    // in a loopless maze (there's only ever one route, so there's no way to
    // juke around it); half speed guarantees the player can always outrun
    // a direct path while still punishing dawdling near it.
    const atGoal = state.row === goal.row && state.col === goal.col;
    if (!atGoal && tick % 2 === 0) {
      state.octo = chaseStep(grid, state.octo, { row: state.row, col: state.col });
      if (state.octo.row === state.row && state.octo.col === state.col) {
        state.alive = false;
        pushTrace('caught', action);
        return;
      }
    }

    pushTrace(atGoal ? 'goal' : 'move', action);
    if (atGoal) state.won = true;
  }

  const api = {
    moveRight: () => step(state.row, state.col + 1, 'moveRight'),
    moveLeft: () => step(state.row, state.col - 1, 'moveLeft'),
    moveUp: () => step(state.row - 1, state.col, 'moveUp'),
    moveDown: () => step(state.row + 1, state.col, 'moveDown'),
    wait: () => step(state.row, state.col, 'wait'),
    octopusNear: () => Math.abs(state.row - state.octo.row) + Math.abs(state.col - state.octo.col) <= 2,
  };

  try {
    const fn = new Function('moveRight', 'moveLeft', 'moveUp', 'moveDown', 'wait', 'octopusNear', userCode);
    fn(api.moveRight, api.moveLeft, api.moveUp, api.moveDown, api.wait, api.octopusNear);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error };
}

// True minimum ticks against a chaser: BFS over (row, col, octoRow, octoCol)
// — no periodic shortcut like the Scanner's, since the chaser's future
// depends on the player's whole path, not just the tick number. Fine for
// mazes this size.
function computeMinMovesGridChase(levelConfig) {
  const { grid, start, goal, octopusStart } = levelConfig;
  function isFloor(r, c) {
    return r >= 0 && r < grid.length && c >= 0 && c < grid[0].length && grid[r][c] !== 'wall';
  }
  const startKey = `${start.row},${start.col},${octopusStart.row},${octopusStart.col}`;
  const visited = new Set([startKey]);
  const queue = [{ row: start.row, col: start.col, octo: octopusStart, dist: 0 }];
  const deltas = [[0, 1], [0, -1], [-1, 0], [1, 0], [0, 0]];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (cur.row === goal.row && cur.col === goal.col) return cur.dist;
    if (cur.dist > MAX_STEPS) continue;
    for (const [dr, dc] of deltas) {
      const nr = cur.row + dr;
      const nc = cur.col + dc;
      if (!isFloor(nr, nc)) continue;
      if (nr === cur.octo.row && nc === cur.octo.col) continue;
      const nextDist = cur.dist + 1;
      let nextOcto = cur.octo;
      if (!(nr === goal.row && nc === goal.col) && nextDist % 2 === 0) {
        nextOcto = chaseStep(grid, cur.octo, { row: nr, col: nc });
      }
      if (nextOcto.row === nr && nextOcto.col === nc) continue;
      const key = `${nr},${nc},${nextOcto.row},${nextOcto.col}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ row: nr, col: nc, octo: nextOcto, dist: cur.dist + 1 });
    }
  }
  return Infinity;
}

// Plays a grid-maze trace back on a p5 canvas.
class GridMazeRunner {
  constructor(p, levelConfig, opts = {}) {
    this.p = p;
    this.level = levelConfig;
    this.tile = opts.tile || 48;
    this.viewportW = opts.viewportW || levelConfig.grid[0].length * this.tile;
    this.viewportH = opts.viewportH || levelConfig.grid.length * this.tile;
    this.cameraX = 0;
    this.cameraY = 0;
    this.trace = [{ row: levelConfig.start.row, col: levelConfig.start.col, event: 'start', tick: 0 }];
    this.stepIndex = 0;
    this.stepElapsed = 0;
    this.playing = false;
    this.status = 'idle';
  }

  levelWidthPx() {
    return this.level.grid[0].length * this.tile;
  }

  levelHeightPx() {
    return this.level.grid.length * this.tile;
  }

  loadTrace(trace, success, errorMessage) {
    this.trace = trace;
    this.stepIndex = 0;
    this.stepElapsed = 0;
    this.playing = trace.length > 1;
    this.finalSuccess = success;
    this.errorMessage = errorMessage;
    this.status = this.playing ? 'playing' : (errorMessage ? 'error' : 'idle');
  }

  update(dt) {
    if (this.playing) {
      this.stepElapsed += dt;
      if (this.stepElapsed >= GRID_STEP_TIME) {
        this.stepElapsed = 0;
        this.stepIndex++;
        if (this.stepIndex >= this.trace.length - 1) {
          this.playing = false;
          const last = this.trace[this.trace.length - 1];
          if (this.errorMessage) this.status = 'error';
          else if (last.event === 'goal') this.status = 'won';
          else if (last.event === 'blocked') this.status = 'blocked';
          else if (last.event === 'caught') this.status = 'caught';
          else this.status = 'idle';
        }
      }
    }

    const pos = this.playerPos();
    const targetCamX = clamp(pos.x - this.viewportW / 2, 0, Math.max(0, this.levelWidthPx() - this.viewportW));
    const targetCamY = clamp(pos.y - this.viewportH / 2, 0, Math.max(0, this.levelHeightPx() - this.viewportH));
    const smoothing = 1 - Math.exp(-dt * 8);
    this.cameraX += (targetCamX - this.cameraX) * smoothing;
    this.cameraY += (targetCamY - this.cameraY) * smoothing;
  }

  _tickFloat() {
    const idx = this.stepIndex + (this.playing ? this.stepElapsed / GRID_STEP_TIME : 0);
    return Math.min(idx, this.trace.length - 1);
  }

  playerPos() {
    const from = this.trace[this.stepIndex];
    const to = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const t = this.playing ? clamp(this.stepElapsed / GRID_STEP_TIME, 0, 1) : 1;
    const te = easeInOutQuad(t);
    return {
      x: lerp(from.col, to.col, te) * this.tile + this.tile / 2,
      y: lerp(from.row, to.row, te) * this.tile + this.tile / 2,
    };
  }

  scannerPos() {
    const scanner = this.level.scanner;
    if (!scanner) return null;
    const tf = this._tickFloat();
    const i0 = Math.floor(tf);
    const t = tf - i0;
    const a = scannerPositionAt(scanner, i0);
    const b = scannerPositionAt(scanner, i0 + 1);
    return {
      x: lerp(a.col, b.col, t) * this.tile + this.tile / 2,
      y: lerp(a.row, b.row, t) * this.tile + this.tile / 2,
    };
  }

  // The chaser's position isn't a formula like the drone's — it's baked
  // into each trace entry (octoRow/octoCol) since it depends on the whole
  // path so far, so we just interpolate between consecutive trace entries.
  octopusPos() {
    const from = this.trace[this.stepIndex];
    if (from.octoRow === undefined) return null;
    const to = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const t = this.playing ? clamp(this.stepElapsed / GRID_STEP_TIME, 0, 1) : 1;
    const te = easeInOutQuad(t);
    return {
      x: lerp(from.octoCol, to.octoCol, te) * this.tile + this.tile / 2,
      y: lerp(from.octoRow, to.octoRow, te) * this.tile + this.tile / 2,
    };
  }

  draw() {
    const p = this.p;
    p.background(10, 14, 20);
    p.push();
    p.translate(-Math.round(this.cameraX), -Math.round(this.cameraY));
    this._drawGrid();
    this._drawScanner();
    this._drawOctopus();
    this._drawPlayer();
    p.pop();
  }

  // BFS distance-to-goal for every floor cell, used to draw a faint arrow
  // along the corridor so it's never ambiguous which way is forward.
  _distanceField() {
    if (this._distField) return this._distField;
    const { grid, goal } = this.level;
    const rows = grid.length;
    const cols = grid[0].length;
    const dist = Array.from({ length: rows }, () => new Array(cols).fill(Infinity));
    dist[goal.row][goal.col] = 0;
    const queue = [[goal.row, goal.col]];
    let qi = 0;
    const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    while (qi < queue.length) {
      const [r, c] = queue[qi++];
      for (const [dr, dc] of deltas) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (grid[nr][nc] === 'wall') continue;
        if (dist[nr][nc] > dist[r][c] + 1) {
          dist[nr][nc] = dist[r][c] + 1;
          queue.push([nr, nc]);
        }
      }
    }
    this._distField = dist;
    return dist;
  }

  _drawGrid() {
    const p = this.p;
    const { grid, goal } = this.level;
    const rows = grid.length;
    const cols = grid[0].length;
    const dist = this._distanceField();
    const isFloor = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!isFloor(r, c)) continue;
        const x = c * this.tile;
        const y = r * this.tile;
        const isGoal = r === goal.row && c === goal.col;

        p.noStroke();
        p.fill(isGoal ? p.color(32, 58, 48) : p.color(46, 56, 76));
        p.rect(x + 1, y + 1, this.tile - 2, this.tile - 2, 3);

        // Perimeter glow: a bright edge everywhere the walkable grate meets
        // the void, so it's unmistakable which tiles you can stand on.
        p.stroke(90, 200, 230, 170);
        p.strokeWeight(2);
        if (!isFloor(r - 1, c)) p.line(x + 2, y + 1, x + this.tile - 2, y + 1);
        if (!isFloor(r + 1, c)) p.line(x + 2, y + this.tile - 1, x + this.tile - 2, y + this.tile - 1);
        if (!isFloor(r, c - 1)) p.line(x + 1, y + 2, x + 1, y + this.tile - 2);
        if (!isFloor(r, c + 1)) p.line(x + this.tile - 1, y + 2, x + this.tile - 1, y + this.tile - 2);

        p.noStroke();
        p.fill(12, 16, 22, 140);
        p.circle(x + this.tile * 0.25, y + this.tile * 0.25, 3);
        p.circle(x + this.tile * 0.75, y + this.tile * 0.75, 3);

        if (isGoal) {
          const pulse = 0.5 + 0.5 * Math.sin(p.millis() * 0.004);
          p.fill(61, 220, 132, 80 + pulse * 100);
          p.circle(x + this.tile / 2, y + this.tile / 2, this.tile * 0.4 + pulse * 4);
          continue;
        }

        let bestDir = null;
        let bestDist = dist[r][c];
        for (const [dr, dc] of [[0, 1], [0, -1], [-1, 0], [1, 0]]) {
          if (isFloor(r + dr, c + dc) && dist[r + dr][c + dc] < bestDist) {
            bestDist = dist[r + dr][c + dc];
            bestDir = [dr, dc];
          }
        }
        if (bestDir) {
          p.push();
          p.translate(x + this.tile / 2, y + this.tile / 2);
          p.rotate(Math.atan2(bestDir[0], bestDir[1]));
          p.noStroke();
          p.fill(255, 255, 255, 35);
          p.triangle(-4, -6, 7, 0, -4, 6);
          p.pop();
        }
      }
    }
  }

  // A small patrol drone: quad rotor arms with blurred props, a blinking
  // light, and a faint downward scan cone.
  _drawScanner() {
    const pos = this.scannerPos();
    if (!pos) return;
    const p = this.p;
    const t = p.millis() * 0.006;
    const spin = p.millis() * 0.03;
    p.push();
    p.translate(pos.x, pos.y);

    const pulse = 0.5 + 0.5 * Math.sin(t * 2);
    p.noStroke();
    p.fill(224, 70, 80, 25 + pulse * 20);
    p.triangle(-2, 3, 2, 3, 0, this.tile * 0.55);

    const armLen = this.tile * 0.32;
    [45, 135, 225, 315].forEach((deg) => {
      const a = (deg * Math.PI) / 180;
      const ex = Math.cos(a) * armLen;
      const ey = Math.sin(a) * armLen;
      p.stroke(70, 78, 96);
      p.strokeWeight(2);
      p.line(0, 0, ex, ey);
      p.noStroke();
      p.fill(200, 210, 225, 100);
      p.push();
      p.translate(ex, ey);
      p.rotate(spin);
      p.ellipse(0, 0, this.tile * 0.3, this.tile * 0.08);
      p.pop();
    });

    p.noStroke();
    p.fill(58, 66, 82);
    p.ellipse(0, 0, this.tile * 0.4, this.tile * 0.26);
    const blink = Math.sin(t * 6) > 0.6;
    p.fill(blink ? p.color(255, 90, 100) : p.color(120, 30, 35));
    p.circle(0, 0, 6);
    p.pop();
  }

  // World 3's chaser: a tiny, cartoonish octopus (not the later game's
  // monster) so it reads as an early, still-approachable threat.
  _drawOctopus() {
    const pos = this.octopusPos();
    if (!pos) return;
    const p = this.p;
    const t = p.millis() * 0.006;
    p.push();
    p.translate(pos.x, pos.y);

    p.noFill();
    p.stroke(175, 85, 205, 210);
    p.strokeWeight(3);
    const legCount = 5;
    for (let i = 0; i < legCount; i++) {
      const baseAngle = (Math.PI * 2 * i) / legCount + Math.PI / 2;
      const bx = Math.cos(baseAngle) * this.tile * 0.14;
      const by = Math.sin(baseAngle) * this.tile * 0.08 + this.tile * 0.08;
      const wave = Math.sin(t * 3 + i) * 4;
      p.beginShape();
      p.curveVertex(bx, by);
      p.curveVertex(bx, by);
      p.curveVertex(bx + wave, by + this.tile * 0.16);
      p.curveVertex(bx - wave * 0.6, by + this.tile * 0.26);
      p.curveVertex(bx - wave * 0.6, by + this.tile * 0.26);
      p.endShape();
    }

    p.noStroke();
    p.fill(175, 85, 205);
    p.ellipse(0, 0, this.tile * 0.5, this.tile * 0.4);
    p.fill(255);
    p.circle(-6, -3, 8);
    p.circle(6, -3, 8);
    p.fill(20, 10, 25);
    p.circle(-6, -3, 4);
    p.circle(6, -3, 4);
    p.pop();
  }

  _drawPlayer() {
    const pos = this.playerPos();
    const p = this.p;
    p.noStroke();
    p.fill(0, 0, 0, 90);
    p.ellipse(pos.x, pos.y + this.tile * 0.28, this.tile * 0.4, this.tile * 0.14);
    p.fill(224, 168, 64);
    p.rect(pos.x - 9, pos.y - 12, 18, 22, 5);
    p.fill(30, 34, 44);
    p.rect(pos.x - 7, pos.y - 8, 14, 8, 3);
    const glow = 0.6 + 0.4 * Math.sin(p.millis() * 0.006);
    p.fill(90, 220, 255, 180 + glow * 60);
    p.rect(pos.x - 5, pos.y - 6.5, 10, 4, 2);
  }
}
