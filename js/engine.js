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
    btn.textContent = next ? 'More areas coming soon →' : 'Back to Area Select →';
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
// Every simulate function calls its api (moveRight, wait, ...) as an arrow
// function one level inside `step()`, which itself is called directly from
// the player's own code (compiled via `new Function`). That fixed call
// shape means the stack frame holding the player's source line is always
// the same distance up from here — calibrated empirically against V8
// (this game's target browsers), not derived from spec. Used to highlight
// the line currently executing during trace playback; on an engine where
// the stack shape doesn't match (non-V8), this just quietly returns null
// and playback simply skips the highlight.
function getCallerLine() {
  const stack = (new Error()).stack || '';
  const frame = stack.split('\n')[4] || '';
  const match = frame.match(/:(\d+):(\d+)\)?$/);
  return match ? parseInt(match[1], 10) - 2 : null;
}

// Inserts `__mark(line)` calls into every `for(init;test;update){body}`'s
// header ONLY — init gets a mark statement immediately before the `for`;
// test and update each get wrapped in-place as `(__mark(line), (EXPR))`
// (the comma operator runs __mark for its side effect, then evaluates to
// EXPR's own value, so the for-loop's own semantics are untouched). The
// body is never touched, sliced, or moved — every edit is a small in-place
// insertion at a precise character offset, so nothing about the body's
// line numbers ever shifts. That matters a lot: getCallerLine() (used for
// the ordinary per-move highlight) reports line numbers against whatever
// code actually ran, so if a for-loop's body got relocated or reflowed by
// this rewrite, every move/wait call's reported line would silently drift
// off the body's real source lines. Keeping the body byte-for-byte in
// place, and only ever inserting (never deleting or reordering) text
// elsewhere, guarantees line numbers stay correct everywhere outside the
// handful of characters added to a header line itself. Because of that,
// this can safely instrument for-loops at any nesting depth, including
// nested inside another for-loop's body — nothing about one for-loop's
// edits can ever overlap another's, nested or not, since only their
// headers are touched and headers never contain another loop.
function instrumentForLoops(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2020, locations: true, ranges: true });
  } catch (e) {
    return null;
  }
  const edits = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'ForStatement') {
      const initLine = node.init ? node.init.loc.start.line : node.loc.start.line;
      edits.push({ at: node.start, text: `__mark(${initLine}); ` });
      if (node.test) {
        const testLine = node.test.loc.start.line;
        edits.push({ at: node.test.start, text: `(__mark(${testLine}), (` });
        edits.push({ at: node.test.end, text: '))' });
      }
      if (node.update) {
        const updateLine = node.update.loc.start.line;
        edits.push({ at: node.update.start, text: `(__mark(${updateLine}), (` });
        edits.push({ at: node.update.end, text: '))' });
      }
    }
    Object.keys(node).forEach((key) => {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') return;
      visit(node[key]);
    });
  })(ast);
  if (!edits.length) return code;

  // Pure insertions (never a range replacement), so applying them in
  // descending-offset order against the original string is always safe —
  // each edit only ever affects text at-or-after its own offset, and every
  // not-yet-applied edit's offset is strictly smaller.
  edits.sort((a, b) => b.at - a.at);
  let out = code;
  edits.forEach((e) => {
    out = out.slice(0, e.at) + e.text + out.slice(e.at);
  });
  return out;
}

// Builds the merged, ordered sequence of "interesting moments" step mode
// walks through one click at a time: every phase event (for-loop init/
// test/update, from __mark) interleaved with every real move/wait, in the
// order they actually happened. phaseEvents are recorded with
// `beforeMoveIndex` = trace.length at the moment __mark fired, i.e. "this
// happened just before movement-trace index N exists" — so merging is
// just walking movement indices 1..end and flushing any phase events due
// before each one, then any left over (e.g. a final failing test after
// the last move) at the end.
function buildStepSequence(trace, phaseEvents) {
  const steps = [];
  let pi = 0;
  for (let i = 1; i < trace.length; i++) {
    while (pi < phaseEvents.length && phaseEvents[pi].beforeMoveIndex <= i) {
      steps.push({ kind: 'phase', line: phaseEvents[pi].line });
      pi++;
    }
    steps.push({ kind: 'move', traceIndex: i });
  }
  while (pi < phaseEvents.length) {
    steps.push({ kind: 'phase', line: phaseEvents[pi].line });
    pi++;
  }
  return steps;
}

function simulateSideScroller(levelConfig, userCode) {
  const { columns, startCol } = levelConfig;
  const state = { col: startCol, alive: true, won: false };
  const trace = [{ col: state.col, event: 'start' }];
  const phaseEvents = [];
  let error = null;
  let steps = 0;
  let markCount = 0;

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
    const line = getCallerLine();
    const tile = tileAt(newCol);
    if (tile === null || tile === TILE_TYPE.GAP) {
      state.alive = false;
      state.col = newCol;
      trace.push({ col: newCol, event: 'fell', action, line });
      return;
    }
    state.col = newCol;
    trace.push({ col: newCol, event: tile === TILE_TYPE.GOAL ? 'goal' : 'move', action, line });
    if (tile === TILE_TYPE.GOAL) state.won = true;
  }

  const api = {
    moveRight: () => step(state.col + 1, 'moveRight'),
    moveLeft: () => step(state.col - 1, 'moveLeft'),
    jump: () => step(state.col + 2, 'jump'),
    __mark: (line) => {
      markCount++;
      if (markCount > 3000) throw new Error('Loop is running too long — check your loop condition.');
      phaseEvents.push({ line, beforeMoveIndex: trace.length });
    },
  };

  try {
    const instrumented = instrumentForLoops(userCode);
    const fn = new Function('moveRight', 'moveLeft', 'jump', '__mark', instrumented !== null ? instrumented : userCode);
    fn(api.moveRight, api.moveLeft, api.jump, api.__mark);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error, phaseEvents };
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

// The player character: customizable species ("skin"), color, and one
// cosmetic, from the splash screen (Progress.getCharacter). Drawn
// identically everywhere it appears — the splash preview and both runners
// all call this one function, so a choice made once shows up consistently
// in every world.
const CHARACTER_COLORS = {
  red: [214, 69, 69],
  orange: [224, 142, 62],
  yellow: [224, 197, 68],
  green: [96, 189, 110],
  blue: [78, 146, 219],
  purple: [161, 96, 204],
  black: [46, 44, 50],
  white: [232, 232, 232],
  slate: [108, 122, 137],
};

function drawCharacter(p, tile, opts = {}) {
  const fallback = { color: 'orange', accessory: 'none', skin: 'capuchin' };
  const character = (typeof Progress !== 'undefined' && Progress.getCharacter) ? Progress.getCharacter() : fallback;
  const color = opts.color || character.color || 'orange';
  const accessory = opts.accessory !== undefined ? opts.accessory : character.accessory;
  const skin = opts.skin || character.skin || 'capuchin';
  const [fr, fg, fb] = CHARACTER_COLORS[color] || CHARACTER_COLORS.orange;
  const s = tile / 48;
  const legSwing = opts.legSwing || 0;

  // Wings sprout from the back, so they need to be drawn before the body
  // (behind it), unlike hats which sit on top of an already-drawn head.
  if (accessory === 'wings') drawWings(p, s);

  if (skin === 'gorilla') drawGorillaBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'manatee') drawManateeBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'proboscis') drawProboscisBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'spiderMonkey') drawSpiderMonkeyBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'narwhal') drawNarwhalBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'catfish') drawCatfishBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'koi') drawKoiBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'shark') drawSharkBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'barracuda') drawBarracudaBody(p, s, fr, fg, fb, legSwing);
  else if (skin === 'chimpanzee') drawChimpanzeeBody(p, s, fr, fg, fb, legSwing);
  else drawCapuchinBody(p, s, fr, fg, fb, legSwing);

  drawAccessory(p, s, accessory);
}

function drawWings(p, s) {
  p.noStroke();
  p.fill(255, 255, 255, 235);
  [-1, 1].forEach((side) => {
    p.push();
    p.translate(side * 9 * s, 1 * s);
    p.rotate(side * -0.5);
    p.ellipse(0, 0, 8 * s, 19 * s);
    p.ellipse(0, 5 * s, 6 * s, 11 * s);
    p.pop();
  });
}

function drawCapuchinBody(p, s, fr, fg, fb, legSwing) {
  // tail
  p.noFill();
  p.stroke(fr, fg, fb);
  p.strokeWeight(2.5 * s);
  p.beginShape();
  p.curveVertex(6 * s, 8 * s);
  p.curveVertex(6 * s, 8 * s);
  p.curveVertex(13 * s, 3 * s);
  p.curveVertex(13 * s, -5 * s);
  p.curveVertex(8 * s, -9 * s);
  p.curveVertex(8 * s, -9 * s);
  p.endShape();

  // legs
  p.stroke(fr * 0.65, fg * 0.65, fb * 0.65);
  p.strokeWeight(3 * s);
  p.line(-4 * s, 10 * s, -4 * s + legSwing * 0.4, 18 * s);
  p.line(4 * s, 10 * s, 4 * s - legSwing * 0.4, 18 * s);

  // arms
  p.stroke(fr, fg, fb);
  p.strokeWeight(3 * s);
  p.line(-8 * s, 2 * s, -11 * s, 9 * s);
  p.line(8 * s, 2 * s, 11 * s, 9 * s);

  // body
  p.noStroke();
  p.fill(fr, fg, fb);
  p.ellipse(0, 4 * s, 15 * s, 17 * s);

  // head + ears
  p.circle(-9 * s, -10 * s, 6 * s);
  p.circle(9 * s, -10 * s, 6 * s);
  p.circle(0, -10 * s, 17 * s);

  // face patch (capuchins have a pale face/chest regardless of fur color)
  p.fill(240, 226, 196);
  p.ellipse(0, -7 * s, 11 * s, 10 * s);

  // eyes + muzzle
  p.fill(35, 24, 18);
  p.circle(-3 * s, -9 * s, 2.2 * s);
  p.circle(3 * s, -9 * s, 2.2 * s);
  p.noFill();
  p.stroke(35, 24, 18);
  p.strokeWeight(1.2 * s);
  p.arc(0, -4 * s, 4 * s, 3 * s, 0, Math.PI);
}

function drawGorillaBody(p, s, fr, fg, fb, legSwing) {
  // legs: short and thick
  p.stroke(fr * 0.6, fg * 0.6, fb * 0.6);
  p.strokeWeight(5 * s);
  p.line(-5 * s, 9 * s, -5 * s + legSwing * 0.3, 16 * s);
  p.line(5 * s, 9 * s, 5 * s - legSwing * 0.3, 16 * s);

  // arms: long, thick, hanging low — the gorilla silhouette
  p.stroke(fr, fg, fb);
  p.strokeWeight(5 * s);
  p.line(-10 * s, -2 * s, -13 * s, 13 * s);
  p.line(10 * s, -2 * s, 13 * s, 13 * s);

  // barrel chest
  p.noStroke();
  p.fill(fr, fg, fb);
  p.ellipse(0, 2 * s, 22 * s, 18 * s);

  // small ears close to a big head
  p.circle(-9 * s, -10 * s, 5 * s);
  p.circle(9 * s, -10 * s, 5 * s);
  p.fill(fr * 0.9, fg * 0.9, fb * 0.9);
  p.ellipse(0, -11 * s, 19 * s, 16 * s);

  // flat dark face + brow ridge
  p.fill(40, 32, 30);
  p.ellipse(0, -8 * s, 12 * s, 10 * s);
  p.fill(fr * 0.7, fg * 0.7, fb * 0.7);
  p.rect(-6 * s, -14 * s, 12 * s, 3 * s, 2);

  p.fill(20, 15, 12);
  p.circle(-3 * s, -9 * s, 2 * s);
  p.circle(3 * s, -9 * s, 2 * s);
}

function drawManateeBody(p, s, fr, fg, fb, legSwing) {
  const wobble = legSwing * 0.015;
  p.push();
  p.rotate(wobble);

  // flippers + tail fluke instead of legs
  p.noStroke();
  p.fill(fr * 0.75, fg * 0.75, fb * 0.75);
  p.ellipse(-13 * s, 6 * s, 10 * s, 6 * s);
  p.ellipse(13 * s, 6 * s, 10 * s, 6 * s);
  p.ellipse(0, 15 * s, 18 * s, 7 * s);

  // big rounded blob body — no neck, no ears
  p.fill(fr, fg, fb);
  p.ellipse(0, -1 * s, 26 * s, 23 * s);

  // snout
  p.fill(fr * 0.9, fg * 0.9, fb * 0.9);
  p.ellipse(0, -10 * s, 15 * s, 11 * s);

  // whiskers
  p.stroke(0, 0, 0, 90);
  p.strokeWeight(1 * s);
  [[-6, -8], [-7, -6], [6, -8], [7, -6]].forEach(([dx, dy]) => {
    p.line(dx * s, dy * s, dx * s + (dx > 0 ? 4 * s : -4 * s), dy * s + 1 * s);
  });

  // small eyes, nostrils
  p.noStroke();
  p.fill(20, 15, 12);
  p.circle(-4 * s, -11 * s, 1.8 * s);
  p.circle(4 * s, -11 * s, 1.8 * s);
  p.fill(fr * 0.6, fg * 0.6, fb * 0.6);
  p.circle(-2 * s, -15 * s, 1.5 * s);
  p.circle(2 * s, -15 * s, 1.5 * s);
  p.pop();
}

function drawNarwhalBody(p, s, fr, fg, fb, legSwing) {
  const wobble = legSwing * 0.015;
  p.push();
  p.rotate(wobble);

  // flippers + a horizontal tail fluke instead of legs — same swim-plan
  // idea as the manatee, just a leaner torpedo body
  p.noStroke();
  p.fill(fr * 0.75, fg * 0.75, fb * 0.75);
  p.ellipse(-11 * s, 5 * s, 9 * s, 5 * s);
  p.ellipse(11 * s, 5 * s, 9 * s, 5 * s);
  p.ellipse(0, 15 * s, 20 * s, 6 * s);

  // long torpedo body
  p.fill(fr, fg, fb);
  p.ellipse(0, 0, 20 * s, 24 * s);

  // rounded head, narrower than the body
  p.fill(fr * 0.95, fg * 0.95, fb * 0.95);
  p.ellipse(0, -12 * s, 13 * s, 13 * s);

  // mottled skin patches — narwhals are blotchy grey, not a flat color,
  // regardless of which fur color the player picked
  p.fill(fr * 1.2, fg * 1.2, fb * 1.2, 140);
  p.ellipse(-4 * s, 2 * s, 6 * s, 4 * s);
  p.ellipse(5 * s, 6 * s, 5 * s, 3 * s);
  p.ellipse(3 * s, -4 * s, 5 * s, 4 * s);

  // the signature spiral tusk, jutting up from the head
  p.stroke(235, 228, 210);
  p.strokeWeight(2 * s);
  p.line(2 * s, -17 * s, 8 * s, -32 * s);
  p.stroke(195, 185, 165);
  p.strokeWeight(1 * s);
  for (let i = 1; i < 5; i++) {
    const t = i / 5;
    const x = lerp(2 * s, 8 * s, t);
    const y = lerp(-17 * s, -32 * s, t);
    p.line(x - 1.2 * s, y, x + 1.2 * s, y - 0.6 * s);
  }

  // small eyes
  p.noStroke();
  p.fill(20, 15, 12);
  p.circle(-4 * s, -13 * s, 1.8 * s);
  p.circle(4 * s, -13 * s, 1.8 * s);
  p.pop();
}

function drawCatfishBody(p, s, fr, fg, fb, legSwing) {
  const wobble = legSwing * 0.015;
  p.push();
  p.rotate(wobble);

  // angled pectoral fins + a forked tail instead of legs
  p.noStroke();
  p.fill(fr * 0.7, fg * 0.7, fb * 0.7);
  p.triangle(-9 * s, 3 * s, -17 * s, 8 * s, -8 * s, 10 * s);
  p.triangle(9 * s, 3 * s, 17 * s, 8 * s, 8 * s, 10 * s);
  p.triangle(-3 * s, 14 * s, -9 * s, 24 * s, 0, 17 * s);
  p.triangle(3 * s, 14 * s, 9 * s, 24 * s, 0, 17 * s);

  // long body
  p.fill(fr, fg, fb);
  p.ellipse(0, 0, 18 * s, 22 * s);

  // dorsal fin ridge
  p.fill(fr * 0.8, fg * 0.8, fb * 0.8);
  p.triangle(-2 * s, -4 * s, 0, -12 * s, 4 * s, -3 * s);

  // wide, flat head
  p.fill(fr * 0.95, fg * 0.95, fb * 0.95);
  p.ellipse(0, -9 * s, 16 * s, 11 * s);

  // long trailing whiskers (barbels) from the corners of the mouth —
  // catfish are named for these regardless of body color
  p.stroke(fr * 0.6, fg * 0.6, fb * 0.6);
  p.strokeWeight(1 * s);
  p.noFill();
  [-1, 1].forEach((side) => {
    p.beginShape();
    p.curveVertex(side * 7 * s, -6 * s);
    p.curveVertex(side * 7 * s, -6 * s);
    p.curveVertex(side * 11 * s, -2 * s);
    p.curveVertex(side * 13 * s, 4 * s);
    p.curveVertex(side * 13 * s, 4 * s);
    p.endShape();
  });

  // small eyes near the top of the head
  p.noStroke();
  p.fill(20, 15, 12);
  p.circle(-4 * s, -12 * s, 1.8 * s);
  p.circle(4 * s, -12 * s, 1.8 * s);
  p.pop();
}

function drawKoiBody(p, s, fr, fg, fb, legSwing) {
  const wobble = legSwing * 0.015;
  p.push();
  p.rotate(wobble);

  // long, translucent flowing pectoral fins + a big forked tail fin with
  // visible rays — the trailing fins that read as "koi" at a glance
  p.noStroke();
  p.fill(255, 255, 255, 90);
  p.ellipse(-11 * s, 3 * s, 10 * s, 5 * s);
  p.ellipse(11 * s, 3 * s, 10 * s, 5 * s);
  p.fill(255, 255, 255, 130);
  p.beginShape();
  p.vertex(-6 * s, 13 * s);
  p.vertex(-16 * s, 30 * s);
  p.vertex(-4 * s, 21 * s);
  p.vertex(0, 30 * s);
  p.vertex(4 * s, 21 * s);
  p.vertex(16 * s, 30 * s);
  p.vertex(6 * s, 13 * s);
  p.endShape(p.CLOSE);
  p.stroke(220, 220, 220, 150);
  p.strokeWeight(0.6 * s);
  for (let i = -2; i <= 2; i++) p.line(i * 2.2 * s, 15 * s, i * 5 * s, 28 * s);
  p.noStroke();

  // long cylindrical body — pale/white base is the koi's signature, not
  // the flat fur color (that instead drives the patches below)
  p.fill(250, 248, 240);
  p.ellipse(0, -1 * s, 15 * s, 26 * s);

  // long, low dorsal fin ridge running down the spine
  p.fill(255, 255, 255, 200);
  p.beginShape();
  p.vertex(-2 * s, 2 * s);
  p.vertex(0, -10 * s);
  p.vertex(3 * s, 3 * s);
  p.endShape(p.CLOSE);

  // bold kohaku-style color patches in the player's chosen color
  p.fill(fr, fg, fb);
  p.ellipse(-2 * s, -8 * s, 9 * s, 8 * s);
  p.ellipse(3 * s, 1 * s, 10 * s, 9 * s);
  p.ellipse(-3 * s, 9 * s, 8 * s, 7 * s);

  // black sumi accent markings
  p.fill(25, 22, 22, 200);
  p.ellipse(4 * s, -4 * s, 4 * s, 3 * s);
  p.ellipse(-4 * s, 4 * s, 3.5 * s, 3 * s);

  // rounded head, blunt snout
  p.fill(250, 248, 240);
  p.ellipse(0, -12 * s, 12 * s, 11 * s);

  // trailing whisker barbels from the corners of the mouth
  p.stroke(240, 235, 220);
  p.strokeWeight(1 * s);
  p.noFill();
  [-1, 1].forEach((side) => {
    p.beginShape();
    p.curveVertex(side * 4 * s, -8 * s);
    p.curveVertex(side * 4 * s, -8 * s);
    p.curveVertex(side * 6 * s, -4 * s);
    p.curveVertex(side * 6 * s, 0 * s);
    p.curveVertex(side * 6 * s, 0 * s);
    p.endShape();
  });

  // small downward pucker mouth
  p.stroke(90, 60, 55);
  p.strokeWeight(1 * s);
  p.arc(0, -7 * s, 3 * s, 2 * s, 0, Math.PI);

  // round eyes
  p.noStroke();
  p.fill(20, 15, 12);
  p.circle(-4 * s, -14 * s, 2 * s);
  p.circle(4 * s, -14 * s, 2 * s);
  p.pop();
}

function drawSharkBody(p, s, fr, fg, fb, legSwing) {
  const wobble = legSwing * 0.015;
  p.push();
  p.rotate(wobble);

  // pectoral fins, swept back, + a tail fin instead of legs
  p.noStroke();
  p.fill(fr * 0.7, fg * 0.7, fb * 0.7);
  p.triangle(-6 * s, 2 * s, -16 * s, 9 * s, -5 * s, 10 * s);
  p.triangle(6 * s, 2 * s, 16 * s, 9 * s, 5 * s, 10 * s);
  p.triangle(-2 * s, 13 * s, -3 * s, 25 * s, 3 * s, 16 * s);
  p.triangle(2 * s, 13 * s, 8 * s, 21 * s, 3 * s, 16 * s);

  // torpedo body tapering to a pointed snout
  p.fill(fr, fg, fb);
  p.beginShape();
  p.vertex(0, -20 * s);
  p.bezierVertex(9 * s, -16 * s, 10 * s, 4 * s, 5 * s, 13 * s);
  p.vertex(-5 * s, 13 * s);
  p.bezierVertex(-10 * s, 4 * s, -9 * s, -16 * s, 0, -20 * s);
  p.endShape(p.CLOSE);

  // pale underside
  p.fill(fr * 1.3, fg * 1.3, fb * 1.3, 160);
  p.ellipse(0, 6 * s, 8 * s, 12 * s);

  // tall triangular dorsal fin — the signature shark silhouette
  p.fill(fr * 0.85, fg * 0.85, fb * 0.85);
  p.triangle(-3 * s, -2 * s, 1 * s, -15 * s, 5 * s, 0);

  // gill slits
  p.stroke(fr * 0.5, fg * 0.5, fb * 0.5);
  p.strokeWeight(1 * s);
  p.noFill();
  for (let i = 0; i < 3; i++) {
    const y = -8 * s + i * 2.5 * s;
    p.arc(7 * s, y, 4 * s, 3 * s, Math.PI * 0.15, Math.PI * 0.75);
  }

  // small eyes
  p.noStroke();
  p.fill(20, 15, 12);
  p.circle(-3 * s, -14 * s, 1.6 * s);
  p.circle(3 * s, -14 * s, 1.6 * s);
  p.pop();
}

function drawBarracudaBody(p, s, fr, fg, fb, legSwing) {
  const wobble = legSwing * 0.015;
  p.push();
  p.rotate(wobble);

  // small fins set far back + a forked tail instead of legs
  p.noStroke();
  p.fill(fr * 0.7, fg * 0.7, fb * 0.7);
  p.triangle(-4 * s, 10 * s, -10 * s, 14 * s, -3 * s, 16 * s);
  p.triangle(4 * s, 10 * s, 10 * s, 14 * s, 3 * s, 16 * s);
  p.triangle(-2 * s, 20 * s, -8 * s, 30 * s, 0, 23 * s);
  p.triangle(2 * s, 20 * s, 8 * s, 30 * s, 0, 23 * s);

  // very long, slender torpedo body
  p.fill(fr, fg, fb);
  p.beginShape();
  p.vertex(0, -22 * s);
  p.bezierVertex(5 * s, -15 * s, 6 * s, 6 * s, 3 * s, 18 * s);
  p.vertex(-3 * s, 18 * s);
  p.bezierVertex(-6 * s, 6 * s, -5 * s, -15 * s, 0, -22 * s);
  p.endShape(p.CLOSE);

  // silvery streaked flank
  p.stroke(fr * 1.4, fg * 1.4, fb * 1.4, 130);
  p.strokeWeight(0.8 * s);
  for (let i = 0; i < 4; i++) {
    const y = -14 * s + i * 8 * s;
    p.line(-4 * s, y, 4 * s, y + 2 * s);
  }
  p.noStroke();

  // low dorsal fin, set well back toward the tail
  p.fill(fr * 0.8, fg * 0.8, fb * 0.8);
  p.triangle(-1 * s, 4 * s, 1 * s, -3 * s, 3 * s, 5 * s);

  // long, pointed, underslung jaw — the barracuda's signature profile
  p.fill(fr * 0.95, fg * 0.95, fb * 0.95);
  p.beginShape();
  p.vertex(-3 * s, -18 * s);
  p.vertex(0, -27 * s);
  p.vertex(3 * s, -18 * s);
  p.endShape(p.CLOSE);

  // visible sharp teeth along the jaw line
  p.fill(250, 250, 245);
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    const x = lerp(-2 * s, 2 * s, t);
    p.triangle(x - 0.8 * s, -19 * s, x + 0.8 * s, -19 * s, x, -22 * s);
  }

  // small eyes
  p.noStroke();
  p.fill(20, 15, 12);
  p.circle(-2.5 * s, -18 * s, 1.6 * s);
  p.circle(2.5 * s, -18 * s, 1.6 * s);
  p.pop();
}

function drawChimpanzeeBody(p, s, fr, fg, fb, legSwing) {
  // legs — no tail, unlike the monkey skins (chimps are apes)
  p.stroke(fr * 0.6, fg * 0.6, fb * 0.6);
  p.strokeWeight(4 * s);
  p.line(-4 * s, 9 * s, -4 * s + legSwing * 0.35, 17 * s);
  p.line(4 * s, 9 * s, 4 * s - legSwing * 0.35, 17 * s);

  // long arms
  p.stroke(fr, fg, fb);
  p.strokeWeight(4 * s);
  p.line(-9 * s, 0, -12 * s, 12 * s);
  p.line(9 * s, 0, 12 * s, 12 * s);

  // dark hands and feet
  p.noStroke();
  p.fill(35, 28, 26);
  p.circle(-12 * s, 12 * s, 3 * s);
  p.circle(12 * s, 12 * s, 3 * s);
  p.circle(-4 * s + legSwing * 0.35, 17 * s, 3 * s);
  p.circle(4 * s - legSwing * 0.35, 17 * s, 3 * s);

  // body
  p.fill(fr, fg, fb);
  p.ellipse(0, 3 * s, 17 * s, 18 * s);

  // large ears, sticking out to the sides
  p.fill(fr * 0.85, fg * 0.85, fb * 0.85);
  p.ellipse(-11 * s, -8 * s, 6 * s, 7 * s);
  p.ellipse(11 * s, -8 * s, 6 * s, 7 * s);
  p.fill(50, 40, 38);
  p.ellipse(-11 * s, -8 * s, 3 * s, 4 * s);
  p.ellipse(11 * s, -8 * s, 3 * s, 4 * s);

  // head
  p.fill(fr, fg, fb);
  p.circle(0, -10 * s, 16 * s);

  // bare black face with a brow ridge — chimps have no fur on the face,
  // unlike the pale face patches on the other monkey skins
  p.fill(45, 38, 36);
  p.ellipse(0, -8 * s, 12 * s, 11 * s);
  p.fill(fr * 0.9, fg * 0.9, fb * 0.9);
  p.rect(-6 * s, -14 * s, 12 * s, 2.5 * s, 2);

  // eyes
  p.fill(230, 225, 210);
  p.circle(-3.5 * s, -9 * s, 2.2 * s);
  p.circle(3.5 * s, -9 * s, 2.2 * s);
  p.fill(20, 15, 12);
  p.circle(-3.5 * s, -9 * s, 1 * s);
  p.circle(3.5 * s, -9 * s, 1 * s);

  // muzzle / mouth
  p.noFill();
  p.stroke(20, 15, 12);
  p.strokeWeight(1 * s);
  p.arc(0, -3 * s, 5 * s, 3 * s, 0, Math.PI);
}

function drawProboscisBody(p, s, fr, fg, fb, legSwing) {
  // tail
  p.noFill();
  p.stroke(fr, fg, fb);
  p.strokeWeight(2.5 * s);
  p.beginShape();
  p.curveVertex(6 * s, 8 * s);
  p.curveVertex(6 * s, 8 * s);
  p.curveVertex(13 * s, 3 * s);
  p.curveVertex(13 * s, -5 * s);
  p.curveVertex(8 * s, -9 * s);
  p.curveVertex(8 * s, -9 * s);
  p.endShape();

  // legs + arms
  p.stroke(fr * 0.65, fg * 0.65, fb * 0.65);
  p.strokeWeight(3 * s);
  p.line(-4 * s, 10 * s, -4 * s + legSwing * 0.4, 18 * s);
  p.line(4 * s, 10 * s, 4 * s - legSwing * 0.4, 18 * s);
  p.stroke(fr, fg, fb);
  p.line(-8 * s, 3 * s, -11 * s, 10 * s);
  p.line(8 * s, 3 * s, 11 * s, 10 * s);

  // potbelly
  p.noStroke();
  p.fill(fr, fg, fb);
  p.ellipse(0, 5 * s, 18 * s, 19 * s);

  // head + small ears
  p.circle(-8 * s, -10 * s, 4 * s);
  p.circle(8 * s, -10 * s, 4 * s);
  p.circle(0, -10 * s, 16 * s);

  // face patch
  p.fill(230, 205, 190);
  p.ellipse(0, -7 * s, 12 * s, 10 * s);

  p.fill(35, 24, 18);
  p.circle(-4 * s, -10 * s, 2 * s);
  p.circle(4 * s, -10 * s, 2 * s);

  // the signature giant nose
  p.fill(225, 160, 150);
  p.ellipse(0, -2 * s, 6 * s, 13 * s);
}

function drawSpiderMonkeyBody(p, s, fr, fg, fb, legSwing) {
  // long prehensile tail, curled at the tip
  p.noFill();
  p.stroke(fr, fg, fb);
  p.strokeWeight(2.2 * s);
  p.beginShape();
  p.curveVertex(6 * s, 6 * s);
  p.curveVertex(6 * s, 6 * s);
  p.curveVertex(15 * s, 2 * s);
  p.curveVertex(17 * s, -6 * s);
  p.curveVertex(12 * s, -11 * s);
  p.curveVertex(7 * s, -9 * s);
  p.curveVertex(7 * s, -9 * s);
  p.endShape();

  // long thin legs — spider monkeys are built for reach, not bulk
  p.stroke(fr * 0.65, fg * 0.65, fb * 0.65);
  p.strokeWeight(2.3 * s);
  p.line(-4 * s, 8 * s, -7 * s + legSwing * 0.5, 20 * s);
  p.line(4 * s, 8 * s, 7 * s - legSwing * 0.5, 20 * s);

  // long thin arms
  p.stroke(fr, fg, fb);
  p.strokeWeight(2.3 * s);
  p.line(-7 * s, 0, -13 * s, 11 * s);
  p.line(7 * s, 0, 13 * s, 11 * s);

  // slender body
  p.noStroke();
  p.fill(fr, fg, fb);
  p.ellipse(0, 3 * s, 12 * s, 15 * s);

  // small round head, no visible ears
  p.circle(0, -10 * s, 13 * s);

  // bare dark face (spider monkeys have distinctive black faces)
  p.fill(45, 38, 40);
  p.ellipse(0, -9 * s, 9 * s, 8 * s);

  // eyes
  p.fill(255, 255, 255, 220);
  p.circle(-2.5 * s, -10 * s, 2 * s);
  p.circle(2.5 * s, -10 * s, 2 * s);
  p.fill(20, 15, 15);
  p.circle(-2.5 * s, -10 * s, 1 * s);
  p.circle(2.5 * s, -10 * s, 1 * s);
}

function drawAccessory(p, s, accessory) {
  p.noStroke();
  if (accessory === 'partyHat') {
    p.fill(230, 70, 130);
    p.triangle(-6 * s, -17 * s, 6 * s, -17 * s, 0, -31 * s);
    p.fill(120, 200, 230);
    p.circle(-3 * s, -20 * s, 2.5 * s);
    p.circle(2 * s, -24 * s, 2.5 * s);
    p.fill(255, 220, 80);
    p.circle(0, -31 * s, 4 * s);
  } else if (accessory === 'topHat') {
    p.fill(22, 22, 26);
    p.rect(-7 * s, -27 * s, 14 * s, 11 * s, 1);
    p.rect(-10 * s, -17 * s, 20 * s, 3 * s, 1);
    p.fill(180, 40, 60);
    p.rect(-7 * s, -19 * s, 14 * s, 2.5 * s);
  } else if (accessory === 'leprechaunHat') {
    p.fill(30, 120, 60);
    p.rect(-6 * s, -25 * s, 12 * s, 9 * s, 1);
    p.rect(-10 * s, -17 * s, 20 * s, 3 * s, 1);
    p.fill(20, 20, 24);
    p.rect(-6 * s, -18 * s, 12 * s, 2.5 * s);
    p.fill(230, 195, 60);
    p.rect(-2 * s, -18.5 * s, 4 * s, 3.5 * s, 1);
  } else if (accessory === 'torchHat') {
    const flicker = 0.6 + 0.4 * Math.sin((typeof window !== 'undefined' ? Date.now() : 0) * 0.012);
    p.fill(255, 140, 40, 45 * flicker);
    p.circle(0, -24 * s, 15 * s * flicker);
    p.fill(90, 60, 30);
    p.rect(-2 * s, -26 * s, 4 * s, 11 * s, 1);
    p.fill(255, 170, 60, 220);
    p.ellipse(0, -30 * s - flicker * 2, 6 * s, 10 * s + flicker * 6);
    p.fill(255, 220, 120, 200);
    p.ellipse(0, -30 * s - flicker * 2, 3 * s, 5 * s + flicker * 3);
  } else if (accessory === 'santaHat') {
    p.fill(200, 40, 50);
    p.triangle(-7 * s, -17 * s, 7 * s, -17 * s, 4 * s, -30 * s);
    p.fill(255, 255, 255);
    p.rect(-9 * s, -18 * s, 18 * s, 4 * s, 2);
    p.circle(4 * s, -30 * s, 5.5 * s);
  } else if (accessory === 'tutu') {
    p.fill(255, 150, 210, 230);
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI - Math.PI / 2;
      p.push();
      p.translate(Math.sin(a) * 9 * s, 9 * s + Math.cos(a) * 2.5 * s);
      p.ellipse(0, 0, 5.5 * s, 6.5 * s);
      p.pop();
    }
    p.fill(230, 100, 180, 230);
    p.ellipse(0, 9 * s, 18 * s, 5 * s);
  } else if (accessory === 'overalls') {
    p.fill(70, 100, 150);
    p.rect(-7 * s, 0, 14 * s, 10 * s, 2);
    p.stroke(70, 100, 150);
    p.strokeWeight(2.5 * s);
    p.line(-5 * s, 0, -7 * s, -9 * s);
    p.line(5 * s, 0, 7 * s, -9 * s);
    p.noStroke();
    p.fill(50, 75, 120);
    p.rect(-2 * s, 2 * s, 4 * s, 4 * s, 1);
    p.fill(220, 200, 80);
    p.circle(-6 * s, -8 * s, 1.8 * s);
    p.circle(6 * s, -8 * s, 1.8 * s);
  } else if (accessory === 'beard') {
    p.fill(212, 206, 196);
    p.beginShape();
    p.vertex(-5 * s, -6 * s);
    p.vertex(5 * s, -6 * s);
    p.vertex(4 * s, 2 * s);
    p.vertex(0, 6 * s);
    p.vertex(-4 * s, 2 * s);
    p.endShape(p.CLOSE);
    p.fill(190, 184, 174);
    p.triangle(-2 * s, 0, 2 * s, 0, 0, 5 * s);
  }
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
    this.stepModeActive = false;
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
    if (this.stepModeActive) return;
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
    drawCharacter(p, this.tile, { legSwing });

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

// Which for/while/if a given (1-indexed) line sits inside, so playback can
// show a loop or conditional as "active" for as long as execution stays
// somewhere in its body — not just the one leaf line with the actual
// moveX()/wait() call, which is all the trace's `.line` data captures on
// its own (those are the only calls we get a stack-trace hook into; a
// `for(...)` header itself never calls any of our injected api functions).
// Parsed with Acorn (already loaded on every world page for syntax-error
// detection) and cached by source text so a 60fps render loop isn't
// re-parsing the same code every frame.
let _controlLinesCache = { code: null, nodes: [] };
const CONTROL_NODE_TYPES = new Set([
  'ForStatement', 'ForOfStatement', 'ForInStatement',
  'WhileStatement', 'DoWhileStatement', 'IfStatement',
]);
function computeControlLines(code) {
  if (_controlLinesCache.code === code) return _controlLinesCache.nodes;
  let nodes = [];
  try {
    const ast = acorn.parse(code, { ecmaVersion: 2020, locations: true });
    (function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node.type === 'string' && node.loc && CONTROL_NODE_TYPES.has(node.type)) {
        nodes.push({ headerLine: node.loc.start.line, bodyStartLine: node.loc.start.line, bodyEndLine: node.loc.end.line });
      }
      Object.keys(node).forEach((key) => {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') return;
        visit(node[key]);
      });
    })(ast);
  } catch (e) {
    nodes = []; // unparsable mid-edit code just means no outer-highlight, not a crash
  }
  _controlLinesCache = { code, nodes };
  return nodes;
}

// Line-pointer during trace playback: highlights the CodeMirror line whose
// call produced the step currently animating (bright), plus any enclosing
// for/while/if header line(s) (dim), cleared once playback stops. Shared
// across all five worlds' render loops (called once per frame from each
// world's own renderStatus()) since the sync logic is identical regardless
// of which simulate function produced the trace's `.line` data.
let _highlightedLine = null; // 0-indexed CodeMirror line currently marked, or null
let _highlightedOuterLines = []; // 0-indexed lines marked with the dim "enclosing" style
function syncCodeHighlight(editor, runner) {
  let target = null;
  if (runner && runner.stepModeActive) {
    // Step mode sets stepModeLine explicitly for both move steps and
    // for-loop phase steps (init/test/update) — there's no trace index to
    // derive a phase step's line from, so this bypasses the lookup below
    // entirely rather than special-casing phase vs. move here too.
    if (runner.stepModeLine !== null && runner.stepModeLine !== undefined) target = runner.stepModeLine - 1;
  } else if (runner && runner.playing) {
    const entry = runner.trace[Math.min(runner.stepIndex + 1, runner.trace.length - 1)];
    if (entry && entry.line !== null && entry.line !== undefined) target = entry.line - 1;
  }

  let outerTargets = [];
  if (target !== null && typeof acorn !== 'undefined') {
    const lineNum = target + 1;
    const nodes = computeControlLines(editor.getValue());
    outerTargets = nodes
      .filter((n) => lineNum >= n.bodyStartLine && lineNum <= n.bodyEndLine && n.headerLine !== lineNum)
      .map((n) => n.headerLine - 1);
  }

  if (_highlightedLine !== null && _highlightedLine !== target) {
    editor.removeLineClass(_highlightedLine, 'background', 'cm-current-line');
  }
  if (target !== null && target !== _highlightedLine) {
    editor.addLineClass(target, 'background', 'cm-current-line');
  }
  _highlightedLine = target;

  _highlightedOuterLines.forEach((l) => {
    if (!outerTargets.includes(l)) editor.removeLineClass(l, 'background', 'cm-current-line-outer');
  });
  outerTargets.forEach((l) => {
    if (!_highlightedOuterLines.includes(l)) editor.addLineClass(l, 'background', 'cm-current-line-outer');
  });
  _highlightedOuterLines = outerTargets;
}

// Step mode: instead of auto-playing a trace on a timer, walk the merged
// move+phase sequence (buildStepSequence) one click at a time — the
// "pause for a click and show init/test/update as they happen" view.
// Shared by every world's own stepCode()/Next-button wiring, the same way
// runCode()/renderStatus() stay per-world but lean on shared engine
// pieces. `runner.stepModeActive` (checked by update() and
// syncCodeHighlight) is how the rest of the engine knows to stop
// auto-advancing and stop deriving the highlighted line from trace/
// stepIndex the normal way while this is running.
function createStepController({ editor, runner, statusEl, nextBtn }) {
  let fullTrace = [];
  let steps = [];
  let idx = -1;
  // Which real trace index the player is actually standing at, updated
  // only by move steps — a phase step (init/test/update) never moves the
  // player, so it has to keep showing wherever the most recent move (or
  // the start, if none yet) left them, not silently jump ahead to
  // wherever the *next* move will land. runner.trace itself is truncated
  // to exactly that prefix for each render (restored to the full trace in
  // finish()) — playerPos()'s own formula always looks at
  // trace[stepIndex+1], so showing "nothing has moved past the start yet"
  // needs trace to end exactly at the start for that to resolve correctly
  // (stepIndex can't go negative to fake it: playerPos() reads
  // trace[stepIndex] unconditionally, even though its value is only
  // mathematically relevant while a move is actually interpolating).
  let lastMoveTraceIndex = 0;

  function render() {
    const s = steps[idx];
    if (s.kind === 'phase') {
      runner.stepModeLine = s.line;
    } else {
      lastMoveTraceIndex = s.traceIndex;
      runner.stepModeLine = fullTrace[s.traceIndex].line;
    }
    runner.trace = fullTrace.slice(0, lastMoveTraceIndex + 1);
    runner.stepIndex = Math.max(0, lastMoveTraceIndex - 1);
    runner.stepElapsed = 0;
    const lineNum = runner.stepModeLine;
    const lineText = lineNum ? (editor.getLine(lineNum - 1) || '').trim() : '';
    statusEl.textContent = `Step ${idx + 1} of ${steps.length}` + (lineText ? `: ${lineText}` : '');
  }

  function finish() {
    runner.stepModeActive = false;
    runner.stepModeLine = null;
    nextBtn.disabled = true;
    // Hand off to the normal auto-play completion path (one more forced
    // tick) so status/win-handling fires exactly the way a full Run
    // would, instead of duplicating that branch's logic here too. Restore
    // the untruncated trace first — render() above only ever showed a
    // growing prefix of it.
    runner.trace = fullTrace;
    runner.stepIndex = Math.max(0, fullTrace.length - 2);
    runner.stepElapsed = 9999;
    runner.playing = true;
  }

  return {
    start(result) {
      fullTrace = result.trace;
      steps = buildStepSequence(result.trace, result.phaseEvents);
      idx = -1;
      lastMoveTraceIndex = 0;
      runner.stepModeActive = true;
      runner.status = 'playing';
      runner.trace = fullTrace.slice(0, 1);
      runner.stepIndex = 0;
      runner.stepElapsed = 0;
      runner.finalSuccess = result.success;
      runner.errorMessage = result.error;
      nextBtn.disabled = false;
      this.next();
    },
    next() {
      if (idx >= steps.length - 1) { finish(); return; }
      idx++;
      render();
    },
  };
}

function scannerPositionAt(scanner, tick) {
  if (!scanner) return null;
  return scanner.path[tick % scanner.path.length];
}

// A squid's "watching" state is, like the scanner, a deterministic function
// of the tick number — a repeating true/false pattern (true = red eye, must
// not move). Unlike the scanner it isn't a position to collide with; it's a
// whole-room hazard, so the check lives in the move path, not isFloor.
function squidWatchAt(squid, tick) {
  if (!squid) return false;
  return squid.pattern[tick % squid.pattern.length];
}

// World 6's boss: five tentacles rigidly fanned around a central pivot,
// rotating together at a fixed rate — same "deterministic function of the
// tick number" trick as the scanner/squid, just expressed as an angle
// instead of a position or a boolean. Whether a given cell is currently
// swept is a pure function of (cell, tick), so — like every other hazard
// in this game — the whole fight still resolves in one synchronous
// simulate pass, no live execution needed.
const CORE_ROTATION_SPEED = Math.PI / 18; // radians per tick (10°) — "slowly swinging"
const CORE_HALF_WIDTH = Math.PI / 15; // radians (12°) — each blade is ~24° wide
// A tentacle is a physical appendage, not an infinite death-ray — it only
// reaches this many tiles from the boss's own center. Without a cap, a
// 24°-wide blade sweeps an arc many tiles across way out at the maze's
// edges, which turned out to make ordinary corridors far from the boss
// entirely un-threadable (verified empirically: generation kept failing
// every attempt). Capping the reach keeps the danger concentrated near
// the chamber, where it's meant to be, and leaves the rest of the maze —
// including the start — genuinely safe to walk.
const CORE_REACH = 6; // tiles

function coreAngleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function coreCellAngle(center, row, col) {
  return Math.atan2(row - center.row, col - center.col);
}
function coreCellRadius(center, row, col) {
  return Math.hypot(row - center.row, col - center.col);
}
function coreTentacleAngleAt(tentacle, tick) {
  return tentacle.baseAngle + tick * CORE_ROTATION_SPEED;
}
// destroyed[i] is a plain boolean array (which of the five tentacles have
// already been exploded by their matching scanner) — a dead tentacle no
// longer sweeps, which is the whole payoff of reaching a scanner.
function coreIsCellDangerous(level, destroyed, row, col, tick) {
  if (coreCellRadius(level.center, row, col) > CORE_REACH) return false;
  const ang = coreCellAngle(level.center, row, col);
  return level.tentacles.some((t, i) => {
    if (destroyed[i]) return false;
    return Math.abs(coreAngleDiff(ang, coreTentacleAngleAt(t, tick))) <= CORE_HALF_WIDTH;
  });
}

// Runs `userCode` against a grid level and returns a trace of every tick.
function simulateGridMaze(levelConfig, userCode) {
  const { grid, start, goal, scanner, squid } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const state = { row: start.row, col: start.col, alive: true, won: false };
  const trace = [{ row: state.row, col: state.col, event: 'start', tick: 0 }];
  const phaseEvents = [];
  let error = null;
  let steps = 0;
  let markCount = 0;

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
    const line = getCallerLine();
    if (!isFloor(newRow, newCol)) {
      state.alive = false;
      trace.push({ row: newRow, col: newCol, event: 'blocked', action, tick, line });
      return;
    }
    if (action !== 'wait' && squidWatchAt(squid, tick)) {
      state.row = newRow;
      state.col = newCol;
      state.alive = false;
      trace.push({ row: newRow, col: newCol, event: 'caught', action, tick, line });
      return;
    }
    state.row = newRow;
    state.col = newCol;
    const scanPos = scannerPositionAt(scanner, tick);
    if (scanPos && scanPos.row === newRow && scanPos.col === newCol) {
      state.alive = false;
      trace.push({ row: newRow, col: newCol, event: 'caught', action, tick, line });
      return;
    }
    const atGoal = newRow === goal.row && newCol === goal.col;
    trace.push({ row: newRow, col: newCol, event: atGoal ? 'goal' : 'move', action, tick, line });
    if (atGoal) state.won = true;
  }

  const api = {
    moveRight: () => step(state.row, state.col + 1, 'moveRight'),
    moveLeft: () => step(state.row, state.col - 1, 'moveLeft'),
    moveUp: () => step(state.row - 1, state.col, 'moveUp'),
    moveDown: () => step(state.row + 1, state.col, 'moveDown'),
    wait: () => step(state.row, state.col, 'wait'),
    __mark: (line) => {
      markCount++;
      if (markCount > 3000) throw new Error('Loop is running too long — check your loop condition.');
      phaseEvents.push({ line, beforeMoveIndex: trace.length });
    },
  };

  try {
    const instrumented = instrumentForLoops(userCode);
    const fn = new Function('moveRight', 'moveLeft', 'moveUp', 'moveDown', 'wait', '__mark', instrumented !== null ? instrumented : userCode);
    fn(api.moveRight, api.moveLeft, api.moveUp, api.moveDown, api.wait, api.__mark);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error, phaseEvents };
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function lcm(a, b) { return (a * b) / gcd(a, b); }

// True minimum ticks to clear a grid level, including any Scanner and/or
// Squid. State is (row, col, tick mod combined period) since both hazards'
// futures are fully determined by the tick number modulo their own patrol/
// watch-cycle length — using the LCM of both as the combined period keeps
// that still true even with both present, and keeps the search space finite.
function computeMinMovesGrid(levelConfig) {
  const { grid, start, goal, scanner, squid } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const scannerPeriod = scanner ? scanner.path.length : 1;
  const squidPeriod = squid ? squid.pattern.length : 1;
  const period = lcm(scannerPeriod, squidPeriod);

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
      const isMove = dr !== 0 || dc !== 0;
      if (isMove && squidWatchAt(squid, nextDist)) continue;
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
// aren't on a fixed patrol — each takes one greedy step toward the player's
// new position after every player action. Still fully deterministic (and
// so still resolvable at simulate time, no live execution needed) because
// they only ever react to moves the player has already committed to in
// their code, never to real-time state the simulator doesn't have.
//
// Winning also requires the code to have called octopusNear() at least
// once. The engine can't make the level truly *impossible* to beat blind —
// everything here is deterministic, so a hardcoded sequence that happens to
// replicate a working path would behave identically to a reactive one, and
// there's no way to tell them apart from outside. Refusing to count a goal
// reached without ever checking octopusNear() is an enforced rule, not a
// physical impossibility — same mechanism as achievement detection.
function simulateGridMazeChase(levelConfig, userCode) {
  const { grid, start, goal, octopi } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const state = {
    row: start.row,
    col: start.col,
    octopi: octopi.map((o) => ({ ...o })),
    alive: true,
    won: false,
    finished: false,
    usedOctopusNear: false,
  };
  const trace = [{ row: state.row, col: state.col, octoPositions: octopi.map((o) => ({ ...o })), event: 'start', tick: 0 }];
  const phaseEvents = [];
  let error = null;
  let steps = 0;
  let markCount = 0;

  function isFloor(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
  }
  function guard() {
    steps++;
    if (steps > MAX_STEPS) {
      throw new Error('Too many moves — check for an infinite loop.');
    }
  }
  function pushTrace(event, action, line) {
    trace.push({ row: state.row, col: state.col, octoPositions: state.octopi.map((o) => ({ ...o })), event, action, tick: trace.length, line });
  }
  function onOctopus(r, c) {
    return state.octopi.some((o) => o.row === r && o.col === c);
  }

  function step(newRow, newCol, action) {
    guard();
    if (state.finished) return;
    const tick = trace.length;
    const line = getCallerLine();
    if (!isFloor(newRow, newCol)) {
      state.finished = true;
      state.row = newRow;
      state.col = newCol;
      pushTrace('blocked', action, line);
      return;
    }
    state.row = newRow;
    state.col = newCol;

    if (onOctopus(state.row, state.col)) {
      state.finished = true;
      pushTrace('caught', action, line);
      return;
    }

    // Half the player's speed (moves on even ticks only) — at full speed a
    // same-speed shortest-path chaser can corner the player with no escape
    // in a loopless maze (there's only ever one route, so there's no way to
    // juke around it); half speed guarantees the player can always outrun
    // a direct path while still punishing dawdling near it.
    const atGoal = state.row === goal.row && state.col === goal.col;
    if (!atGoal && tick % 2 === 0) {
      state.octopi = state.octopi.map((o) => chaseStep(grid, o, { row: state.row, col: state.col }));
      if (onOctopus(state.row, state.col)) {
        state.finished = true;
        pushTrace('caught', action, line);
        return;
      }
    }

    if (atGoal) {
      state.finished = true;
      if (state.usedOctopusNear) {
        state.won = true;
        pushTrace('goal', action, line);
      } else {
        pushTrace('goal-unearned', action, line);
      }
      return;
    }

    pushTrace('move', action, line);
  }

  const api = {
    moveRight: () => step(state.row, state.col + 1, 'moveRight'),
    moveLeft: () => step(state.row, state.col - 1, 'moveLeft'),
    moveUp: () => step(state.row - 1, state.col, 'moveUp'),
    moveDown: () => step(state.row + 1, state.col, 'moveDown'),
    wait: () => step(state.row, state.col, 'wait'),
    octopusNear: () => {
      state.usedOctopusNear = true;
      return state.octopi.some((o) => Math.abs(state.row - o.row) + Math.abs(state.col - o.col) <= 2);
    },
    __mark: (line) => {
      markCount++;
      if (markCount > 3000) throw new Error('Loop is running too long — check your loop condition.');
      phaseEvents.push({ line, beforeMoveIndex: trace.length });
    },
  };

  try {
    const instrumented = instrumentForLoops(userCode);
    const fn = new Function('moveRight', 'moveLeft', 'moveUp', 'moveDown', 'wait', 'octopusNear', '__mark', instrumented !== null ? instrumented : userCode);
    fn(api.moveRight, api.moveLeft, api.moveUp, api.moveDown, api.wait, api.octopusNear, api.__mark);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error, phaseEvents };
}

// World 5 — a maze scattered with switch terminals. Each is activated
// automatically just by standing on its tile (same physicality as the
// goal — no separate "activate" action), and reaching the goal only counts
// once every switch is on; otherwise it's 'goal-incomplete' so the player
// knows exactly how many are left, same honesty principle as World 3's
// 'goal-unearned'. switches() is a read-only query (doesn't consume a
// tick, same contract as octopusNear()) returning a snapshot array of
// {row, col, on} objects — the array-of-objects hook this world teaches.
function simulateVault(levelConfig, userCode) {
  const { grid, start, goal, switches } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const state = {
    row: start.row,
    col: start.col,
    switches: switches.map((s) => ({ ...s, on: false })),
    finished: false,
    won: false,
  };
  const trace = [{ row: state.row, col: state.col, switchesOn: state.switches.map((s) => s.on), event: 'start', tick: 0 }];
  const phaseEvents = [];
  let error = null;
  let steps = 0;
  let markCount = 0;

  function isFloor(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
  }
  function guard() {
    steps++;
    if (steps > MAX_STEPS) throw new Error('Too many moves — check for an infinite loop.');
  }
  function activateHere() {
    state.switches.forEach((s) => {
      if (s.row === state.row && s.col === state.col) s.on = true;
    });
  }

  function step(newRow, newCol, action) {
    guard();
    if (state.finished) return;
    const tick = trace.length;
    const line = getCallerLine();
    if (!isFloor(newRow, newCol)) {
      state.finished = true;
      trace.push({ row: newRow, col: newCol, switchesOn: state.switches.map((s) => s.on), event: 'blocked', action, tick, line });
      return;
    }
    state.row = newRow;
    state.col = newCol;
    activateHere();
    const atGoal = newRow === goal.row && newCol === goal.col;
    if (atGoal) {
      state.finished = true;
      const allOn = state.switches.every((s) => s.on);
      if (allOn) state.won = true;
      trace.push({ row: newRow, col: newCol, switchesOn: state.switches.map((s) => s.on), event: allOn ? 'goal' : 'goal-incomplete', action, tick, line });
      return;
    }
    trace.push({ row: newRow, col: newCol, switchesOn: state.switches.map((s) => s.on), event: 'move', action, tick, line });
  }

  const api = {
    moveRight: () => step(state.row, state.col + 1, 'moveRight'),
    moveLeft: () => step(state.row, state.col - 1, 'moveLeft'),
    moveUp: () => step(state.row - 1, state.col, 'moveUp'),
    moveDown: () => step(state.row + 1, state.col, 'moveDown'),
    wait: () => step(state.row, state.col, 'wait'),
    switches: () => state.switches.map((s) => ({ row: s.row, col: s.col, on: s.on })),
    __mark: (line) => {
      markCount++;
      if (markCount > 3000) throw new Error('Loop is running too long — check your loop condition.');
      phaseEvents.push({ line, beforeMoveIndex: trace.length });
    },
  };

  try {
    const instrumented = instrumentForLoops(userCode);
    const fn = new Function('moveRight', 'moveLeft', 'moveUp', 'moveDown', 'wait', 'switches', '__mark', instrumented !== null ? instrumented : userCode);
    fn(api.moveRight, api.moveLeft, api.moveUp, api.moveDown, api.wait, api.switches, api.__mark);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error, phaseEvents };
}

// World 6 — the boss. A real maze with the boss camped in a chamber at its
// center, five tentacles rigidly fanned out and rotating together
// (coreIsCellDangerous, engine-level so both the simulator and the
// renderer share one definition of "dangerous right now"). Touching a
// swept cell — on a move OR a wait(), a rotating blade doesn't care
// whether you held still — ends the run, same immediate-death contract as
// the scanner/octopus. Five scanner stations are scattered through the
// maze, each wired to one tentacle; stepping onto one destroys its
// tentacle automatically (same physicality as the Vault's switches — no
// separate "activate" action). The door back to the exit is a real wall
// tile until every tentacle is gone, so — unlike every earlier world's
// 'goal-incomplete' — reaching the exit early isn't just discouraged, it's
// physically impossible: `isFloorNow` only opens that one tile once
// `tentacleDestroyed` is all true.
function simulateCore(levelConfig, userCode) {
  const { grid, start, exit, doorPos, scanners } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  const state = {
    row: start.row,
    col: start.col,
    tentacleDestroyed: levelConfig.tentacles.map(() => false),
    finished: false,
    won: false,
  };
  const snapshot = () => state.tentacleDestroyed.slice();
  const trace = [{ row: state.row, col: state.col, tentacleDestroyed: snapshot(), event: 'start', tick: 0 }];
  const phaseEvents = [];
  let error = null;
  let steps = 0;
  let markCount = 0;

  function isFloorStatic(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
  }
  function isFloorNow(r, c) {
    if (doorPos && r === doorPos.row && c === doorPos.col) {
      return state.tentacleDestroyed.every(Boolean);
    }
    return isFloorStatic(r, c);
  }
  function guard() {
    steps++;
    if (steps > MAX_STEPS) throw new Error('Too many moves — check for an infinite loop.');
  }
  function activateScannerHere() {
    const s = scanners.find((sc) => sc.row === state.row && sc.col === state.col);
    if (s) state.tentacleDestroyed[s.tentacleId] = true;
  }

  function step(newRow, newCol, action) {
    guard();
    if (state.finished) return;
    const tick = trace.length;
    const line = getCallerLine();
    if (!isFloorNow(newRow, newCol)) {
      state.finished = true;
      trace.push({ row: newRow, col: newCol, tentacleDestroyed: snapshot(), event: 'blocked', action, tick, line });
      return;
    }
    if (coreIsCellDangerous(levelConfig, state.tentacleDestroyed, newRow, newCol, tick)) {
      state.finished = true;
      state.row = newRow;
      state.col = newCol;
      trace.push({ row: newRow, col: newCol, tentacleDestroyed: snapshot(), event: 'caught', action, tick, line });
      return;
    }
    state.row = newRow;
    state.col = newCol;
    activateScannerHere();
    if (newRow === exit.row && newCol === exit.col) {
      state.finished = true;
      state.won = true;
      trace.push({ row: newRow, col: newCol, tentacleDestroyed: snapshot(), event: 'goal', action, tick, line });
      return;
    }
    trace.push({ row: newRow, col: newCol, tentacleDestroyed: snapshot(), event: 'move', action, tick, line });
  }

  const api = {
    moveRight: () => step(state.row, state.col + 1, 'moveRight'),
    moveLeft: () => step(state.row, state.col - 1, 'moveLeft'),
    moveUp: () => step(state.row - 1, state.col, 'moveUp'),
    moveDown: () => step(state.row + 1, state.col, 'moveDown'),
    wait: () => step(state.row, state.col, 'wait'),
    __mark: (line) => {
      markCount++;
      if (markCount > 3000) throw new Error('Loop is running too long — check your loop condition.');
      phaseEvents.push({ line, beforeMoveIndex: trace.length });
    },
  };

  try {
    const instrumented = instrumentForLoops(userCode);
    const fn = new Function('moveRight', 'moveLeft', 'moveUp', 'moveDown', 'wait', '__mark', instrumented !== null ? instrumented : userCode);
    fn(api.moveRight, api.moveLeft, api.moveUp, api.moveDown, api.wait, api.__mark);
  } catch (e) {
    error = e.message;
  }

  return { trace, success: state.won, error, phaseEvents };
}

// Exhaustive joint BFS over every octopus's position is exponential in the
// number of octopi, so with 3+ chasers it's intractable. Instead this
// constructs *a* working solution with a greedy reactive policy (prefer
// moves that don't get caught, then moves that reduce goal-distance, then
// moves that maximize distance from the nearest octopus) and reports its
// length. That proves solvability but is not guaranteed to be the true
// minimum, unlike every other par number in this game — see DESIGN.md.
function findGreedySolution(levelConfig) {
  const { grid, start, goal, octopi } = levelConfig;
  const rows = grid.length;
  const cols = grid[0].length;
  function isFloor(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
  }
  const goalDist = bfsDistanceMap(grid, goal);

  let player = { ...start };
  let octoPos = octopi.map((o) => ({ ...o }));
  const path = [];
  const deltas = [[0, 1], [0, -1], [-1, 0], [1, 0], [0, 0]];

  for (let tick = 0; tick < MAX_STEPS; tick++) {
    if (player.row === goal.row && player.col === goal.col) return { success: true, moves: path.length };

    let best = null;
    for (const [dr, dc] of deltas) {
      const nr = player.row + dr;
      const nc = player.col + dc;
      if (!isFloor(nr, nc)) continue;
      if (octoPos.some((o) => o.row === nr && o.col === nc)) continue;
      const atGoal = nr === goal.row && nc === goal.col;
      const nextOcto = atGoal || tick % 2 !== 0 ? octoPos : octoPos.map((o) => chaseStep(grid, o, { row: nr, col: nc }));
      if (nextOcto.some((o) => o.row === nr && o.col === nc)) continue;
      const minOctoDist = Math.min(...nextOcto.map((o) => Math.abs(o.row - nr) + Math.abs(o.col - nc)));
      const score = { goalDist: goalDist[nr][nc], minOctoDist, nr, nc, nextOcto };
      if (!best
        || score.goalDist < best.goalDist
        || (score.goalDist === best.goalDist && score.minOctoDist > best.minOctoDist)) {
        best = score;
      }
    }
    if (!best) return { success: false, moves: null };
    player = { row: best.nr, col: best.nc };
    octoPos = best.nextOcto;
    path.push(true);
  }
  return { success: false, moves: null };
  return Infinity;
}

// Plays a grid-maze trace back on a p5 canvas.
class GridMazeRunner {
  constructor(p, levelConfig, opts = {}) {
    this.p = p;
    this.level = levelConfig;
    this.theme = opts.theme || 'vents';
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
    this.stepModeActive = false;
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
    if (this.stepModeActive) return;
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
          else if (last.event === 'goal-unearned') this.status = 'goal-unearned';
          else if (last.event === 'goal-incomplete') this.status = 'goal-incomplete';
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

  // The chasers' positions aren't a formula like the drone's — they're
  // baked into each trace entry (octoPositions) since they depend on the
  // whole path so far, so we just interpolate between trace entries.
  octopusPositions() {
    const from = this.trace[this.stepIndex];
    if (!from.octoPositions) return [];
    const to = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const t = this.playing ? clamp(this.stepElapsed / GRID_STEP_TIME, 0, 1) : 1;
    const te = easeInOutQuad(t);
    return from.octoPositions.map((a, i) => {
      const b = to.octoPositions[i];
      return {
        x: lerp(a.col, b.col, te) * this.tile + this.tile / 2,
        y: lerp(a.row, b.row, te) * this.tile + this.tile / 2,
      };
    });
  }

  draw() {
    const p = this.p;
    p.background(
      this.theme === 'dungeon' ? this.p.color(14, 9, 8) :
      this.theme === 'foundry' ? this.p.color(20, 12, 7) :
      this.theme === 'vault' ? this.p.color(8, 11, 16) :
      this.theme === 'core' ? this.p.color(16, 6, 10) :
      this.p.color(10, 14, 20)
    );
    p.push();
    p.translate(-Math.round(this.cameraX), -Math.round(this.cameraY));
    this._drawGrid();
    this._drawSwitches();
    this._drawCoreDoor();
    this._drawScanner();
    this._drawOctopus();
    this._drawCoreScanners();
    this._drawCoreBoss();
    this._drawPlayer();
    this._drawDarkness();
    p.pop();
    // The squid is a fixed HUD overseer, not part of the level — drawn
    // after the pop so it never scrolls with the camera and stays visible
    // even through the darkness mask above. World 6's boss, by contrast,
    // physically sits at a spot in its maze (level.center), so it's drawn
    // above in camera space with everything else, not here.
    this._drawSquid();
  }

  // Dungeon theme: torches (plus a small radius around the player, for
  // playability) are the only light. Foundry theme: no torches at all, just
  // a tight radius around the player — "nearly pitch black." Everything
  // else gets masked to near-black either way. Implemented as an offscreen
  // buffer filled opaque, then punched through with radial-gradient
  // "destination-out" circles at each light source, so the reveal falls off
  // softly instead of a hard-edged circle.
  _torchCells() {
    if (this._torchCellsCache) return this._torchCellsCache;
    const { grid, goal } = this.level;
    const rows = grid.length;
    const cols = grid[0].length;
    const isFloor = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== 'wall';
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!isFloor(r, c)) continue;
        const isGoal = r === goal.row && c === goal.col;
        const torchRoll = hash01(r * 37 + c * 91 + 5);
        const wallAdjacent = !isFloor(r - 1, c) || !isFloor(r + 1, c) || !isFloor(r, c - 1) || !isFloor(r, c + 1);
        if (wallAdjacent && !isGoal && torchRoll < 0.16) cells.push({ row: r, col: c });
      }
    }
    this._torchCellsCache = cells;
    return cells;
  }

  _drawDarkness() {
    const dungeon = this.theme === 'dungeon';
    const foundry = this.theme === 'foundry';
    if (!dungeon && !foundry) return;
    const p = this.p;
    if (!this._darkBuf) this._darkBuf = p.createGraphics(this.levelWidthPx(), this.levelHeightPx());
    const buf = this._darkBuf;
    buf.clear();
    // Foundry has no torches at all — just a tight ring around the player —
    // so it reads as noticeably darker than the dungeon's torch-lit halls.
    buf.background(foundry ? p.color(3, 2, 1, 250) : p.color(8, 5, 5, 242));
    const ctx = buf.drawingContext;
    ctx.globalCompositeOperation = 'destination-out';

    const playerPos = this.playerPos();
    const lights = dungeon ? this._torchCells().map((cell) => ({
      x: cell.col * this.tile + this.tile / 2,
      y: cell.row * this.tile + this.tile / 2,
      radius: this.tile * 2.6,
    })) : [];
    lights.push({ x: playerPos.x, y: playerPos.y, radius: this.tile * (foundry ? 1.5 : 1.9) });

    lights.forEach(({ x, y, radius }) => {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.6, 'rgba(255,255,255,0.55)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
    p.image(buf, 0, 0);
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
    const dungeon = this.theme === 'dungeon';
    const foundry = this.theme === 'foundry';
    const vault = this.theme === 'vault';
    const core = this.theme === 'core';

    if (core) {
      // Corrupted-flesh-and-metal backdrop — deep red-black with faint
      // vertical seams, distinct from every earlier theme's cooler palette.
      p.noStroke();
      p.fill(20, 8, 14);
      p.rect(0, 0, cols * this.tile, rows * this.tile);
      p.stroke(50, 14, 26);
      p.strokeWeight(1);
      for (let x = 0; x < cols * this.tile; x += this.tile) p.line(x, 0, x, rows * this.tile);
    }

    if (vault) {
      // Plain steel-blue backdrop with a faint panel grid — reads as a bank
      // vault's server floor, not empty space.
      p.noStroke();
      p.fill(9, 13, 19);
      p.rect(0, 0, cols * this.tile, rows * this.tile);
      p.stroke(18, 26, 36);
      p.strokeWeight(1);
      for (let x = 0; x < cols * this.tile; x += this.tile) p.line(x, 0, x, rows * this.tile);
      for (let y = 0; y < rows * this.tile; y += this.tile) p.line(0, y, cols * this.tile, y);
    }

    if (foundry) {
      // Plain rust-metal backdrop with faint rivet seams — no brick lines,
      // just enough texture to read as factory floor rather than void.
      p.noStroke();
      p.fill(16, 10, 6);
      p.rect(0, 0, cols * this.tile, rows * this.tile);
      p.stroke(30, 19, 11);
      p.strokeWeight(1);
      for (let x = 0; x < cols * this.tile; x += this.tile) p.line(x, 0, x, rows * this.tile);
    }

    if (dungeon) {
      // Brick wall backdrop behind everything — void reads as stonework,
      // not empty space.
      p.noStroke();
      p.fill(20, 14, 12);
      p.rect(0, 0, cols * this.tile, rows * this.tile);
      const brickW = 16;
      const brickH = 8;
      p.stroke(12, 8, 7);
      p.strokeWeight(1);
      for (let y = 0; y < rows * this.tile; y += brickH) {
        const offset = (Math.floor(y / brickH) % 2) * (brickW / 2);
        for (let x = -brickW; x < cols * this.tile; x += brickW) {
          p.line(x + offset, y, x + offset, y + brickH);
        }
        p.line(0, y, cols * this.tile, y);
      }
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!isFloor(r, c)) continue;
        const x = c * this.tile;
        const y = r * this.tile;
        const isGoal = r === goal.row && c === goal.col;

        p.noStroke();
        if (dungeon) {
          p.fill(isGoal ? p.color(32, 58, 48) : p.color(42, 34, 28));
        } else if (foundry) {
          p.fill(isGoal ? p.color(32, 58, 48) : p.color(60, 40, 24));
        } else if (vault) {
          p.fill(isGoal ? p.color(32, 58, 48) : p.color(34, 42, 56));
        } else if (core) {
          p.fill(isGoal ? p.color(32, 58, 48) : p.color(54, 20, 30));
        } else {
          p.fill(isGoal ? p.color(32, 58, 48) : p.color(46, 56, 76));
        }
        p.rect(x + 1, y + 1, this.tile - 2, this.tile - 2, 3);

        // Perimeter glow: a bright edge everywhere the walkable floor meets
        // the void, so it's unmistakable which tiles you can stand on.
        p.stroke(dungeon ? p.color(210, 130, 50, 160) : foundry ? p.color(255, 140, 50, 170) : vault ? p.color(90, 170, 255, 170) : core ? p.color(220, 60, 90, 170) : p.color(90, 200, 230, 170));
        p.strokeWeight(2);
        if (!isFloor(r - 1, c)) p.line(x + 2, y + 1, x + this.tile - 2, y + 1);
        if (!isFloor(r + 1, c)) p.line(x + 2, y + this.tile - 1, x + this.tile - 2, y + this.tile - 1);
        if (!isFloor(r, c - 1)) p.line(x + 1, y + 2, x + 1, y + this.tile - 2);
        if (!isFloor(r, c + 1)) p.line(x + this.tile - 1, y + 2, x + this.tile - 1, y + this.tile - 2);

        if (dungeon) {
          // Sparse torches on wall-adjacent floor tiles, deterministic per
          // cell so they don't jump around frame to frame.
          const torchRoll = hash01(r * 37 + c * 91 + 5);
          const wallAdjacent = !isFloor(r - 1, c) || !isFloor(r + 1, c) || !isFloor(r, c - 1) || !isFloor(r, c + 1);
          if (wallAdjacent && !isGoal && torchRoll < 0.16) {
            const flicker = 0.6 + 0.4 * Math.sin(p.millis() * 0.012 + r * 3 + c * 7) + 0.15 * Math.sin(p.millis() * 0.05 + c);
            const cx = x + this.tile / 2;
            const cy = y + this.tile / 2;
            p.noStroke();
            p.fill(255, 140, 40, 40 * flicker);
            p.circle(cx, cy, this.tile * 1.6 * flicker);
            p.fill(90, 60, 30);
            p.rect(cx - 2, cy - 2, 4, 10, 1);
            p.fill(255, 170, 60, 220);
            p.ellipse(cx, cy - 6 - flicker * 2, 6, 10 + flicker * 6);
            p.fill(255, 220, 120, 200);
            p.ellipse(cx, cy - 6 - flicker * 2, 3, 5 + flicker * 3);
          }
        } else if (foundry) {
          p.noStroke();
          p.fill(20, 13, 8, 160);
          p.circle(x + this.tile * 0.25, y + this.tile * 0.25, 3);
          p.circle(x + this.tile * 0.75, y + this.tile * 0.75, 3);
        } else if (vault) {
          p.noStroke();
          p.fill(70, 130, 200, 90);
          p.circle(x + this.tile * 0.25, y + this.tile * 0.25, 3);
          p.circle(x + this.tile * 0.75, y + this.tile * 0.75, 3);
        } else if (core) {
          p.noStroke();
          p.fill(200, 60, 90, 100);
          p.circle(x + this.tile * 0.25, y + this.tile * 0.25, 3);
          p.circle(x + this.tile * 0.75, y + this.tile * 0.75, 3);
        } else {
          p.noStroke();
          p.fill(12, 16, 22, 140);
          p.circle(x + this.tile * 0.25, y + this.tile * 0.25, 3);
          p.circle(x + this.tile * 0.75, y + this.tile * 0.75, 3);
        }

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

  // Vault switches: small wall terminals, dim red until stepped on (see
  // simulateVault), then lit green for the rest of the run. State comes
  // straight off the trace's per-step `switchesOn` snapshot — same
  // simulate-then-replay contract as everything else, this just renders it.
  _drawSwitches() {
    const switches = this.level.switches;
    if (!switches) return;
    const p = this.p;
    const entry = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const states = entry.switchesOn || switches.map(() => false);
    const t = p.millis() * 0.001;
    switches.forEach((s, i) => {
      const on = states[i];
      const x = s.col * this.tile + this.tile / 2;
      const y = s.row * this.tile + this.tile / 2;
      p.push();
      p.translate(x, y);
      p.noStroke();
      p.fill(20, 22, 28);
      p.rect(-this.tile * 0.25, -this.tile * 0.04, this.tile * 0.5, this.tile * 0.32, 3);
      if (on) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 4 + i);
        p.fill(70, 230, 140, 120 + pulse * 80);
        p.circle(0, this.tile * 0.12, this.tile * 0.3 + pulse * 3);
        p.fill(70, 230, 140);
        p.circle(0, this.tile * 0.12, this.tile * 0.16);
      } else {
        const pulse = 0.5 + 0.5 * Math.sin(t * 2 + i);
        p.fill(210, 60, 60, 60 + pulse * 40);
        p.circle(0, this.tile * 0.12, this.tile * 0.2);
        p.fill(160, 40, 40);
        p.circle(0, this.tile * 0.12, this.tile * 0.1);
      }
      p.pop();
    });
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
    const positions = this.octopusPositions();
    if (!positions.length) return;
    const p = this.p;
    const t = p.millis() * 0.006;
    positions.forEach((pos, idx) => {
      const hueShift = idx * 40;
      p.push();
      p.translate(pos.x, pos.y);

      p.noFill();
      p.stroke(175 - hueShift * 0.3, 85 + hueShift * 0.4, 205 - hueShift * 0.2, 210);
      p.strokeWeight(3);
      const legCount = 5;
      for (let i = 0; i < legCount; i++) {
        const baseAngle = (Math.PI * 2 * i) / legCount + Math.PI / 2;
        const bx = Math.cos(baseAngle) * this.tile * 0.14;
        const by = Math.sin(baseAngle) * this.tile * 0.08 + this.tile * 0.08;
        const wave = Math.sin(t * 3 + i + idx) * 4;
        p.beginShape();
        p.curveVertex(bx, by);
        p.curveVertex(bx, by);
        p.curveVertex(bx + wave, by + this.tile * 0.16);
        p.curveVertex(bx - wave * 0.6, by + this.tile * 0.26);
        p.curveVertex(bx - wave * 0.6, by + this.tile * 0.26);
        p.endShape();
      }

      p.noStroke();
      p.fill(175 - hueShift * 0.3, 85 + hueShift * 0.4, 205 - hueShift * 0.2);
      p.ellipse(0, 0, this.tile * 0.5, this.tile * 0.4);
      p.fill(255);
      p.circle(-6, -3, 8);
      p.circle(6, -3, 8);
      p.fill(20, 10, 25);
      p.circle(-6, -3, 4);
      p.circle(6, -3, 4);
      p.pop();
    });
  }

  // The squid: a fixed overseer above the play area, not part of the level
  // grid — drawn in screen space (see draw()) so it never scrolls off with
  // the camera. Its "watching" state is read straight off the trace, same
  // simulate-then-replay contract as everything else; this just visualizes
  // it in sync with playback rather than deciding anything live.
  _drawSquid() {
    const squid = this.level.squid;
    if (!squid) return;
    const p = this.p;
    const entry = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const watching = squidWatchAt(squid, entry.tick);
    const t = p.millis() * 0.001;
    const eyeX = this.viewportW / 2;
    const eyeY = 30;

    // Persistent illustration of its "sight" — a cone from the eye down to
    // the whole visible floor. It's always faintly there (so you can see
    // what it's watching even when it's safe) and floods solid red when
    // watching. This is Red Light/Green Light, not a spatial cone you can
    // dodge by standing elsewhere — the cone covers the whole play area on
    // purpose, because that's the actual hitbox: anywhere, while it's red.
    p.noStroke();
    if (watching) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 10);
      p.fill(220, 30, 30, 55 + pulse * 30);
    } else {
      p.fill(120, 90, 150, 22);
    }
    p.triangle(eyeX, eyeY, 0, this.viewportH, this.viewportW, this.viewportH);

    if (watching) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 10);
      p.noStroke();
      p.fill(200, 20, 20, 35 + pulse * 20);
      p.rect(0, 0, this.viewportW, this.viewportH);
    }

    p.push();
    p.translate(eyeX, eyeY);

    p.noFill();
    p.stroke(90, 55, 110, 180);
    p.strokeWeight(3);
    [-16, -8, 8, 16].forEach((dx, i) => {
      const wave = Math.sin(t * 2 + i) * 4;
      p.beginShape();
      p.curveVertex(dx, 14);
      p.curveVertex(dx, 14);
      p.curveVertex(dx + wave, 24);
      p.curveVertex(dx - wave * 0.5, 32);
      p.curveVertex(dx - wave * 0.5, 32);
      p.endShape();
    });

    p.noStroke();
    p.fill(70, 40, 90);
    p.ellipse(0, 0, 46, 30);

    p.fill(20, 12, 22);
    p.circle(0, -2, 20);
    if (watching) {
      const glow = 0.6 + 0.4 * Math.sin(t * 14);
      p.fill(255, 40, 40, 60 * glow);
      p.circle(0, -2, 26 + glow * 6);
      p.fill(255, 30, 30);
      p.circle(0, -2, 13);
      p.fill(255, 160, 160);
      p.circle(0, -2, 5);
    } else {
      const sweep = Math.sin(t * 1.3) * 5;
      p.fill(160, 160, 170);
      p.circle(0, -2, 13);
      p.fill(30, 30, 35);
      p.circle(sweep, -2, 6);
    }
    p.pop();
  }

  _drawPlayer() {
    const pos = this.playerPos();
    const p = this.p;
    p.noStroke();
    p.fill(0, 0, 0, 90);
    p.ellipse(pos.x, pos.y + this.tile * 0.28, this.tile * 0.4, this.tile * 0.14);
    p.push();
    p.translate(pos.x, pos.y);
    drawCharacter(p, this.tile, {});
    p.pop();
  }

  // World 6's boss: sits at level.center, inside its maze (not a fixed HUD
  // like the squid — it physically occupies a spot the camera scrolls
  // past). Each live tentacle is drawn as a wide wedge from the center out
  // past the far edge of the maze, at exactly the angle coreIsCellDangerous
  // uses to decide what can kill you right now — what you see IS the
  // hitbox, nothing hidden. A destroyed tentacle simply isn't drawn.
  _drawCoreBoss() {
    const level = this.level;
    const tentacles = level.tentacles;
    if (!tentacles) return;
    const p = this.p;
    const entry = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const destroyed = entry.tentacleDestroyed || tentacles.map(() => false);
    const cx = level.center.col * this.tile + this.tile / 2;
    const cy = level.center.row * this.tile + this.tile / 2;
    const reach = CORE_REACH * this.tile;
    const t = p.millis() * 0.001;

    tentacles.forEach((def, i) => {
      if (destroyed[i]) return;
      const angle = coreTentacleAngleAt(def, entry.tick);
      const a0 = angle - CORE_HALF_WIDTH;
      const a1 = angle + CORE_HALF_WIDTH;
      const pulse = 0.5 + 0.5 * Math.sin(t * 5 + i);
      p.noStroke();
      p.fill(220, 40, 60, 55 + pulse * 30);
      p.beginShape();
      p.vertex(cx, cy);
      p.vertex(cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach);
      p.vertex(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
      p.vertex(cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach);
      p.endShape(p.CLOSE);
      p.stroke(255, 120, 140, 150 + pulse * 60);
      p.strokeWeight(2);
      p.line(cx, cy, cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach);
      p.line(cx, cy, cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach);
    });

    // the boss's own body, squatting on its permanently-walled center tile
    p.noStroke();
    const bodyPulse = 0.5 + 0.5 * Math.sin(t * 1.5);
    p.fill(150, 20, 70, 60 + bodyPulse * 20);
    p.circle(cx, cy, this.tile * 1.6 + bodyPulse * 6);
    p.fill(90, 22, 48);
    p.ellipse(cx, cy, this.tile * 1.1, this.tile * 0.85);
    p.fill(60, 14, 32);
    p.ellipse(cx, cy + this.tile * 0.1, this.tile * 0.8, this.tile * 0.5);
    const allDead = destroyed.length > 0 && destroyed.every(Boolean);
    p.fill(allDead ? p.color(120, 200, 160) : p.color(255, 60, 60));
    p.circle(cx - this.tile * 0.22, cy - this.tile * 0.08, this.tile * 0.16);
    p.circle(cx + this.tile * 0.22, cy - this.tile * 0.08, this.tile * 0.16);
    p.fill(10, 5, 8);
    p.circle(cx - this.tile * 0.22, cy - this.tile * 0.08, this.tile * 0.07);
    p.circle(cx + this.tile * 0.22, cy - this.tile * 0.08, this.tile * 0.07);
  }

  // Five wall-mounted consoles, one per tentacle. Grey and inert once its
  // tentacle is gone, otherwise a pulsing red waiting for the player to
  // physically reach it — stepping onto one auto-activates it (see
  // simulateCore's activateScannerHere), same physicality as the Vault's
  // switches.
  _drawCoreScanners() {
    const scanners = this.level.scanners;
    if (!scanners) return;
    const p = this.p;
    const entry = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const destroyed = entry.tentacleDestroyed || [];
    const t = p.millis() * 0.001;
    scanners.forEach((s) => {
      const done = destroyed[s.tentacleId];
      const x = s.col * this.tile + this.tile / 2;
      const y = s.row * this.tile + this.tile / 2;
      p.push();
      p.translate(x, y);
      p.noStroke();
      p.fill(20, 22, 28);
      p.rect(-this.tile * 0.26, -this.tile * 0.2, this.tile * 0.52, this.tile * 0.4, 4);
      if (done) {
        p.fill(90, 100, 110);
        p.circle(0, 0, this.tile * 0.22);
      } else {
        const pulse = 0.5 + 0.5 * Math.sin(t * 5);
        p.fill(230, 60, 60, 120 + pulse * 100);
        p.circle(0, 0, this.tile * 0.2 + pulse * 4);
        p.fill(230, 60, 60);
        p.circle(0, 0, this.tile * 0.12);
      }
      p.pop();
    });
  }

  // The door tile is a real wall in level.grid until every tentacle is
  // gone (isFloorNow in simulateCore) — this renders that same state
  // honestly: barred red while locked, an open glowing arch once the
  // trace shows every tentacle destroyed.
  _drawCoreDoor() {
    const doorPos = this.level.doorPos;
    if (!doorPos) return;
    const p = this.p;
    const entry = this.trace[Math.min(this.stepIndex + 1, this.trace.length - 1)];
    const destroyed = entry.tentacleDestroyed || [];
    const open = destroyed.length > 0 && destroyed.every(Boolean);
    const x = doorPos.col * this.tile;
    const y = doorPos.row * this.tile;
    p.noStroke();
    if (open) {
      const pulse = 0.5 + 0.5 * Math.sin(p.millis() * 0.003);
      p.fill(40, 60, 50);
      p.rect(x + 1, y + 1, this.tile - 2, this.tile - 2, 3);
      p.fill(70, 230, 140, 90 + pulse * 60);
      p.circle(x + this.tile / 2, y + this.tile / 2, this.tile * 0.5 + pulse * 4);
    } else {
      p.fill(50, 16, 20);
      p.rect(x + 1, y + 1, this.tile - 2, this.tile - 2, 3);
      p.stroke(200, 40, 50, 200);
      p.strokeWeight(2);
      for (let i = 1; i < 4; i++) {
        const lx = x + (this.tile / 4) * i;
        p.line(lx, y + 2, lx, y + this.tile - 2);
      }
    }
  }
}
