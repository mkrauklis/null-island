// World 7 — The Frozen Caves (bonus, unlocked after clearing The Core).
// Recursion. A big generated maze (generateMaze is already a perfect
// maze — a spanning tree, no loops) with no hazards at all: the challenge
// is purely that it's too large to solve by hand-tracing a specific path.
// openDirections() (engine.js, simulateGridMaze) returns which of
// up/down/left/right are open right now, as plain strings — nothing about
// the maze's shape, so the natural solution is a generic recursive
// backtracker (explore every direction except the one you arrived from,
// undoing each move before trying the next) rather than a hardcoded route
// that only works for this one generated layout.
const WORLD_ID = 'world7';

function generateLevel(seed) {
  const rng = mulberry32(seed);
  // Capped so a full DFS-with-backtracking traversal (worst case: every
  // edge crossed twice, if the goal happens to be the very last cell
  // visited) can never exceed MAX_STEPS — verified against a real
  // recursive solve, not just eyeballed. Still meaningfully bigger than
  // the Vault's maze (5-6 x 9-11 cells).
  const mazeRows = 7 + Math.floor(rng() * 2); // 7..8 cells
  const mazeCols = 10 + Math.floor(rng() * 3); // 10..12 cells
  const grid = generateMaze(mazeRows, mazeCols, rng);
  const start = { row: grid.length - 2, col: 1 };
  const goal = { row: 1, col: grid[0].length - 2 };
  const level = { grid, start, goal };
  // Exact, not approximate — generateMaze is a perfect maze (a spanning
  // tree), so there's exactly one route and computeMinMovesGrid's BFS
  // finds its true length, same as Areas 1-4's par.
  level.parMoves = computeMinMovesGrid(level);
  return level;
}

const LEVEL = generateLevel(Progress.getSeed(WORLD_ID));
Progress.setWorldPar(WORLD_ID, LEVEL.parMoves);

const COMMANDS = [
  { id: 'moveRight', label: 'moveRight()', insert: 'moveRight();\n', pattern: /moveRight\s*\(/ },
  { id: 'moveLeft', label: 'moveLeft()', insert: 'moveLeft();\n', pattern: /moveLeft\s*\(/ },
  { id: 'moveUp', label: 'moveUp()', insert: 'moveUp();\n', pattern: /moveUp\s*\(/ },
  { id: 'moveDown', label: 'moveDown()', insert: 'moveDown();\n', pattern: /moveDown\s*\(/ },
  { id: 'openDirections', label: 'openDirections()', insert: 'openDirections()', pattern: /openDirections\s*\(/ },
  { id: 'atGoal', label: 'atGoal()', insert: 'atGoal()', pattern: /atGoal\s*\(/ },
  { id: 'funcDecl', label: 'function ...() {}', insert: 'function explore() {\n  \n}\n', pattern: /function\s+\w+\s*\(/ },
];

let runner;
let editor;
let lastFrameMs;
let lastStatus = null;
let resultCache = null;
let errorLine = null;
let stepController;
let stepping = false;
let exploring = false;
// Starts on the first Run/Step click on this page load, not page open —
// reading the instructions shouldn't count against your time. Exploring
// doesn't start the clock; it's scouting, not an attempt.
let firstRunMs = null;

// One-time intro on the very first visit to this world: the helicopter
// that escaped with in The Core's ending comes back down, this time over
// ice. Purely a cosmetic overlay drawn before the maze itself ever shows
// — same "doesn't touch saved progress" spirit as Explore mode, just a
// single boolean (Progress.markIntroSeen) instead of nothing at all,
// since unlike exploring this only ever needs to happen once per slot.
let introDone = Progress.getSeenIntros().includes(WORLD_ID);
let introStart = null;
const INTRO_DURATION = 3.6;

function finishIntro() {
  if (introDone) return;
  introDone = true;
  Progress.markIntroSeen(WORLD_ID);
}

function drawCrashHelicopter(p, x, y, angle, alpha) {
  p.push();
  p.translate(x, y);
  p.rotate(angle);
  p.noStroke();
  p.fill(70, 75, 85, alpha);
  p.rect(2, -4, 34, 8, 3);
  p.fill(90, 95, 105, alpha);
  p.ellipse(-4, 0, 40, 22);
  p.fill(150, 60, 60, alpha * 0.9);
  p.ellipse(-8, -2, 14, 10);
  p.stroke(40, 40, 45, alpha);
  p.strokeWeight(2);
  p.line(-20, 12, 10, 12);
  p.noStroke();
  p.fill(200, 200, 210, alpha * 0.6);
  p.ellipse(-4, -14, 70, 5);
  p.pop();
}

// Phase 1 (0-2.0s): spiraling down through the storm. Phase 2 (2.0-2.3s):
// impact flash. Phase 3 (2.3s-end): the character stands up out of the
// wreck, settling into the same view the maze itself will use.
function drawCrashIntro(p, elapsed) {
  const w = 480;
  const h = 384;
  p.push();
  p.background(9, 15, 24);

  p.noStroke();
  p.fill(255, 255, 255, 130);
  for (let i = 0; i < 36; i++) {
    const sx = (i * 53.7 + elapsed * 12) % w;
    const sy = (i * 91.3 + elapsed * 130) % h;
    p.circle(sx, sy, 2);
  }

  if (elapsed < 2.0) {
    const t1 = elapsed / 2.0;
    const x = w * 0.5 + Math.sin(t1 * 9) * 16;
    const y = -30 + t1 * (h * 0.6 + 30);
    const angle = Math.sin(t1 * 11) * 0.3 + t1 * 0.5;
    p.fill(120, 120, 130, 70);
    p.circle(x - Math.cos(angle) * 22, y - Math.sin(angle) * 22 + 8, 10 + t1 * 14);
    drawCrashHelicopter(p, x, y, angle, 255);
  } else if (elapsed < 2.3) {
    const t2 = (elapsed - 2.0) / 0.3;
    p.fill(230, 240, 250, (1 - t2) * 210);
    p.rect(0, 0, w, h);
    p.fill(200, 210, 220, 150);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      p.circle(w * 0.5 + Math.cos(a) * t2 * 90, h * 0.62 + Math.sin(a) * t2 * 45, 6);
    }
  } else {
    const t3 = Math.min((elapsed - 2.3) / 1.3, 1);
    p.fill(40, 34, 30, 200);
    p.ellipse(w * 0.5, h * 0.7, 100, 22);
    drawCrashHelicopter(p, w * 0.62, h * 0.66, 1.3, 180);
    p.push();
    p.translate(w * 0.45, h * 0.64 - t3 * 8);
    drawCharacter(p, 52, {});
    p.pop();
    if (t3 >= 1) {
      p.fill(220, 230, 240, 230);
      p.textAlign(p.CENTER);
      p.textSize(14);
      p.text('...the ground is real, at least.', w * 0.5, h * 0.9);
    }
  }

  p.noStroke();
  p.fill(200, 220, 235, 150);
  p.textAlign(p.RIGHT);
  p.textSize(11);
  p.text('click to skip', w - 10, h - 10);
  p.pop();
}

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(480, 384);
    canvas.parent('level-canvas-holder');
    runner = new GridMazeRunner(p, LEVEL, { tile: 32, viewportW: 480, viewportH: 384, theme: 'ice' });
    lastFrameMs = performance.now();
    stepController = createStepController({
      editor,
      runner,
      statusEl: document.getElementById('step-status'),
      nextBtn: document.getElementById('step-next-btn'),
    });
  };

  p.mousePressed = () => finishIntro();

  p.draw = () => {
    const now = performance.now();
    const dt = (now - lastFrameMs) / 1000;
    lastFrameMs = now;
    if (!introDone) {
      if (introStart === null) introStart = now;
      const elapsed = (now - introStart) / 1000;
      drawCrashIntro(p, elapsed);
      if (elapsed >= INTRO_DURATION) finishIntro();
      return;
    }
    runner.update(dt);
    runner.draw();
    renderStatus();
  };
}

// Arrow-key scouting: walking the maze by hand to get a feel for its
// shape before committing to code. Reuses the runner's own trace/playback
// machinery rather than a separate rendering path — each key press just
// appends one more 'move' event and lets the existing update() loop
// animate it, same as a real run would. Never marks a 'goal' event (even
// if you walk onto the exit tile by hand), so exploring can never itself
// trigger a win or touch saved progress — it's scouting only.
function isFloorAt(r, c) {
  const grid = LEVEL.grid;
  return r >= 0 && r < grid.length && c >= 0 && c < grid[0].length && grid[r][c] !== 'wall';
}

function setExploring(next) {
  exploring = next;
  const btn = document.getElementById('explore-btn');
  btn.textContent = exploring ? 'Stop Exploring' : 'Explore';
  btn.className = 'button secondary' + (exploring ? ' selected' : '');
  if (exploring) {
    stepping = false;
    document.getElementById('step-controls').style.display = 'none';
    runner.loadTrace([{ row: LEVEL.start.row, col: LEVEL.start.col, event: 'start', tick: 0 }], false, null);
  }
}

document.addEventListener('keydown', (e) => {
  if (!exploring || !runner) return;
  const deltas = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  const d = deltas[e.key];
  if (!d) return;
  e.preventDefault();
  const last = runner.trace[runner.trace.length - 1];
  const nr = last.row + d[0];
  const nc = last.col + d[1];
  if (!isFloorAt(nr, nc)) return;
  runner.trace.push({ row: nr, col: nc, event: 'move', action: 'explore', tick: runner.trace.length });
  runner.stepIndex = runner.trace.length - 2;
  runner.stepElapsed = 0;
  runner.playing = true;
});

function renderWorldMeta() {
  const el = document.getElementById('world-meta');
  const state = Progress.getWorld(WORLD_ID);
  if (!state.cleared) {
    el.textContent = `Par: ${LEVEL.parMoves} moves — the true minimum (the cave is a perfect maze, exactly one route, no loops). Match it for a star.`;
    return;
  }
  const starred = state.bestMoves <= LEVEL.parMoves;
  el.innerHTML = `Best: ${state.bestMoves} moves (par ${LEVEL.parMoves})` +
    (starred ? ' <span class="star">&#9733;</span>' : '') +
    (state.bestTimeMs != null ? ` &middot; fastest ${formatDuration(state.bestTimeMs)}` : '');
}

function renderStatus() {
  const statusEl = document.getElementById('status');
  if (!runner) return;
  statusEl.className = runner.status;
  syncCodeHighlight(editor, runner);

  if (stepping && !runner.stepModeActive) {
    stepping = false;
    document.getElementById('step-controls').style.display = 'none';
  }

  if (runner.status === 'won' && lastStatus !== 'won') {
    const moves = runner.trace.length - 1;
    const timeMs = firstRunMs !== null ? performance.now() - firstRunMs : null;
    const updated = Progress.recordClear(WORLD_ID, moves, timeMs);
    resultCache = { moves, bestMoves: updated.bestMoves, starred: updated.bestMoves <= LEVEL.parMoves, timeMs, bestTimeMs: updated.bestTimeMs };
    renderWorldMeta();
    renderNextWorldLink(WORLD_ID);
    checkAchievements();
  }
  lastStatus = runner.status;

  if (exploring) {
    statusEl.textContent = 'Exploring — use the arrow keys to look around. Click "Stop Exploring" when you\'re ready to code.';
    return;
  }

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      const timeNote = r.timeMs != null ? ` in ${formatDuration(r.timeMs)} (best ${formatDuration(r.bestTimeMs)})` : '';
      statusEl.textContent = `Found the way out in ${r.moves} moves — best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves})${timeNote}.`;
      break;
    }
    case 'blocked': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Move ${last.tick}: that's solid ice (row ${last.row}, col ${last.col}) — check openDirections() before you commit to a direction. Edit your code and run again.`;
      break;
    }
    case 'error':
      statusEl.textContent = errorLine
        ? `Syntax error on line ${errorLine}: ${runner.errorMessage}`
        : 'Error: ' + runner.errorMessage;
      break;
    case 'playing':
      statusEl.textContent = 'Running...';
      break;
    default:
      statusEl.textContent = 'Write your moves, then press Run.';
  }
}

function renderCommandPalette() {
  const unlocked = Progress.getUnlockedSnippets();
  const listEl = document.getElementById('command-list');
  listEl.innerHTML = '';
  COMMANDS.forEach((cmd) => {
    const isUnlocked = unlocked.includes(cmd.id);
    const el = document.createElement(isUnlocked ? 'button' : 'span');
    el.className = 'command-chip ' + (isUnlocked ? 'unlocked' : 'locked');
    el.textContent = cmd.label;
    if (isUnlocked) {
      el.type = 'button';
      el.title = 'Insert ' + cmd.label;
      el.addEventListener('click', () => insertSnippet(cmd.insert));
    }
    listEl.appendChild(el);
  });
}

function insertSnippet(text) {
  const cursor = editor.getCursor();
  editor.replaceRange(text, cursor);
  editor.focus();
  editor.setCursor({ line: cursor.line + 1, ch: 0 });
}

function checkForNewlyTypedCommands() {
  const code = stripComments(editor.getValue());
  let changed = false;
  COMMANDS.forEach((cmd) => {
    const unlockedNow = Progress.getUnlockedSnippets();
    if (!unlockedNow.includes(cmd.id) && cmd.pattern.test(code)) {
      Progress.unlockSnippet(cmd.id);
      changed = true;
    }
  });
  if (changed) renderCommandPalette();
}

// AST-based (not regex — nesting makes "does this function call itself"
// hard to get right with text patterns) walk for a FunctionDeclaration
// whose own body contains a CallExpression naming that same function.
// Reuses the generic "recurse into every object/array property" trick
// instrumentForLoops/computeControlLines already use, so it doesn't need
// its own hardcoded set of node shapes.
function usesRecursion(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2020 });
  } catch (e) {
    return false;
  }
  let found = false;
  (function walk(node, currentFnName) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, currentFnName)); return; }
    let nextName = currentFnName;
    if (node.type === 'FunctionDeclaration' && node.id) nextName = node.id.name;
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === currentFnName) {
      found = true;
      return;
    }
    Object.keys(node).forEach((key) => {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') return;
      walk(node[key], nextName);
    });
  })(ast, null);
  return found;
}

function checkAchievements() {
  const code = stripComments(editor.getValue());
  const newly = [];
  const record = (id) => {
    const { isNew } = Progress.unlockAchievement(id);
    if (isNew) newly.push(id);
  };
  if (/moveLeft\s*\(|moveDown\s*\(/.test(code)) record('backtracker');
  const actionsUsed = new Set(runner.trace.map((t) => t.action));
  if (['moveUp', 'moveDown', 'moveLeft', 'moveRight'].every((a) => actionsUsed.has(a))) {
    record('compass');
  }
  if (usesRecursion(code)) record('recursive');
  if (resultCache.starred) record('perfectionist');
  const escapee = checkEscapeeAchievement(WORLDS);
  if (escapee.isNew) newly.push('escapee');
  announceAchievements(newly);
}

let errorMark = null;
function clearSyntaxHighlight() {
  if (errorMark) { errorMark.clear(); errorMark = null; }
  if (errorLine !== null) { editor.removeLineClass(errorLine - 1, 'background', 'cm-error-line'); }
  errorLine = null;
}

function highlightSyntaxError(err) {
  clearSyntaxHighlight();
  const line = Math.max(0, err.line - 1);
  const lineText = editor.getLine(line) || '';
  const from = { line, ch: Math.min(err.column, lineText.length) };
  const to = { line, ch: lineText.length };
  errorMark = editor.markText(from, to, { className: 'cm-error-text' });
  editor.addLineClass(line, 'background', 'cm-error-line');
  errorLine = line + 1;
}

function runCode() {
  if (exploring) setExploring(false);
  if (firstRunMs === null) firstRunMs = performance.now();
  const code = editor.getValue();
  clearSyntaxHighlight();
  const syntaxErr = findSyntaxError(code);
  if (syntaxErr) {
    highlightSyntaxError(syntaxErr);
    runner.loadTrace([{ row: LEVEL.start.row, col: LEVEL.start.col, event: 'start', tick: 0 }], false, syntaxErr.message);
    return;
  }
  const { trace, success, error } = simulateGridMaze(LEVEL, code);
  runner.loadTrace(trace, success, error);
}

// Step mode: same syntax check + simulate as Run, but hands the result to
// the shared step controller (engine.js) instead of auto-playing it — one
// click of Next advances one move OR one for-loop init/test/update phase.
function stepCode() {
  if (exploring) setExploring(false);
  if (firstRunMs === null) firstRunMs = performance.now();
  const code = editor.getValue();
  clearSyntaxHighlight();
  const syntaxErr = findSyntaxError(code);
  if (syntaxErr) {
    highlightSyntaxError(syntaxErr);
    runner.loadTrace([{ row: LEVEL.start.row, col: LEVEL.start.col, event: 'start', tick: 0 }], false, syntaxErr.message);
    return;
  }
  const result = simulateGridMaze(LEVEL, code);
  stepping = true;
  document.getElementById('step-controls').style.display = '';
  stepController.start(result);
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('level-hint').textContent =
    `Par is ${LEVEL.parMoves} moves. The cave is generated fresh for you — there's no map to memorize, ` +
    `just openDirections() telling you what's around you right now.`;

  editor = CodeMirror.fromTextArea(document.getElementById('code'), {
    mode: 'javascript',
    theme: 'dracula',
    lineNumbers: true,
    tabSize: 2,
  });
  editor.on('change', () => {
    clearSyntaxHighlight();
    checkForNewlyTypedCommands();
  });
  checkForNewlyTypedCommands();
  renderCommandPalette();
  renderWorldMeta();
  document.getElementById('run-btn').addEventListener('click', runCode);
  document.getElementById('step-btn').addEventListener('click', stepCode);
  document.getElementById('step-next-btn').addEventListener('click', () => stepController.next());
  document.getElementById('explore-btn').addEventListener('click', () => setExploring(!exploring));
  new p5(sketch);
});
