// World 6 — The Core. The boss camps in a chamber at the center of a real
// maze, five tentacles fanned rigidly around it and rotating together
// (coreIsCellDangerous, engine.js) — touch a swept cell, on a move OR a
// wait(), and you're caught, same immediate-death contract as every other
// hazard. Five scanner stations are scattered through the maze; reaching
// one auto-destroys its tentacle (same physicality as the Vault's
// switches). The door back to the exit is a real wall tile until all five
// are gone — not a "goal-incomplete" message, a physical barrier
// (isFloorNow in simulateCore). Reaching the exit plays a short scripted
// escape: up a ladder, into a waiting helicopter.
const WORLD_ID = 'world6';
const TENTACLE_COUNT = 5;
const SCANNER_COUNT = 5;
const MAZE_SIZE = 7; // medium — bigger than Areas 2/3, smaller than the Vault

// One attempt at a layout, or null if it didn't pan out — see
// generateLevel for why this can fail and how often it actually does.
function buildCoreAttempt(seed) {
  const rng = mulberry32(seed);
  const grid = generateMaze(MAZE_SIZE, MAZE_SIZE, rng);
  const rows = grid.length;
  const cols = grid[0].length;
  const centerR = Math.floor(rows / 2);
  const centerC = Math.floor(cols / 2);

  // Carve the boss's chamber: an open room around the center. The exact
  // center tile stays a permanent wall — the boss's own body, standing
  // where nothing else can. This step only ever adds floor, so it can
  // never disconnect anything that was connected before it.
  for (let r = centerR - 2; r <= centerR + 2; r++) {
    for (let c = centerC - 2; c <= centerC + 2; c++) {
      grid[r][c] = (r === centerR && c === centerC) ? 'wall' : 'floor';
    }
  }

  // The door + exit spur, poking two cells out of the chamber's own top
  // edge. Forced explicitly (overwriting whatever the raw maze carved
  // there) so the exit is reachable ONLY through the door. Unlike the
  // chamber carve, THIS step can disconnect the maze — a perfect maze is a
  // spanning tree, so forcing any one of these cells to 'wall' has a
  // chance of severing the one existing path through it. Caught by the
  // verification pass below rather than solved by cleverer placement.
  const exit = { row: centerR - 4, col: centerC };
  const doorPos = { row: centerR - 3, col: centerC };
  grid[exit.row][exit.col] = 'floor';
  grid[doorPos.row][doorPos.col] = 'wall'; // dynamic — see simulateCore's isFloorNow
  grid[exit.row - 1][exit.col] = 'wall';
  grid[exit.row][exit.col - 1] = 'wall';
  grid[exit.row][exit.col + 1] = 'wall';
  grid[doorPos.row][doorPos.col - 1] = 'wall';
  grid[doorPos.row][doorPos.col + 1] = 'wall';

  const center = { row: centerR, col: centerC };
  const start = { row: 1, col: 1 };

  // Verify no accidental side connection snuck past the forced walls above
  // — with the door locked, the exit should be reachable from nowhere at
  // all (a plain maze BFS, ignoring tentacles entirely). Whether the REST
  // of the maze stayed connected is checked below instead, per scanner,
  // together with whether each one is reachable without ever being caught
  // — a strictly stronger requirement anyway.
  if (bfsDistanceMap(grid, start)[exit.row][exit.col] !== Infinity) return null;

  const tentacles = [];
  for (let i = 0; i < TENTACLE_COUNT; i++) {
    tentacles.push({ baseAngle: (i / TENTACLE_COUNT) * Math.PI * 2 + rng() * 0.3 });
  }

  // Scanner stations, one per tentacle, scattered through the maze's own
  // cells — never inside the boss chamber, never on the exit tile itself,
  // never right next to the start.
  const roomCells = [];
  for (let r = 1; r < rows; r += 2) {
    for (let c = 1; c < cols; c += 2) {
      if (grid[r][c] !== 'floor') continue;
      if (Math.abs(r - centerR) <= 2 && Math.abs(c - centerC) <= 2) continue;
      if (r === exit.row && c === exit.col) continue;
      if (Math.abs(r - start.row) + Math.abs(c - start.col) < 3) continue;
      roomCells.push({ row: r, col: c });
    }
  }
  const shuffled = shuffleWithRng(roomCells, rng);
  const scanners = [];
  for (const cell of shuffled) {
    if (scanners.length >= SCANNER_COUNT) break;
    const tooClose = scanners.some((s) => Math.abs(s.row - cell.row) + Math.abs(s.col - cell.col) < 4);
    if (tooClose) continue;
    scanners.push({ id: scanners.length, tentacleId: scanners.length, row: cell.row, col: cell.col });
  }
  for (const cell of shuffled) {
    if (scanners.length >= SCANNER_COUNT) break;
    if (scanners.some((s) => s.row === cell.row && s.col === cell.col)) continue;
    scanners.push({ id: scanners.length, tentacleId: scanners.length, row: cell.row, col: cell.col });
  }
  if (scanners.length < SCANNER_COUNT) return null;

  // goal is an alias for exit — the shared GridMazeRunner rendering code
  // (goal-tile pulse, distance-field arrows) reads level.goal directly, and
  // aliasing it here is simpler than teaching that generic code about a
  // second name for the same idea.
  const level = { grid, start, exit, goal: exit, doorPos, center, tentacles, scanners };

  // Accept the layout only if a real route through it actually exists —
  // see solveCoreLevel. Its result becomes par directly: unlike every
  // other world's par, this one is a route that's PROVEN achievable (it's
  // literally how it was found), not a separate estimate that might not
  // account for something the real game does.
  const solved = solveCoreLevel(level);
  if (!solved) return null;
  level.parMoves = solved.ticks;
  return level;
}

// A single leg: shortest number of ticks from `from` to `to` while never
// landing on a cell any live tentacle is sweeping at that exact tick — a
// state-space BFS over (row, col, tick mod rotationPeriod), same "extend
// the state with the hazard's own period" trick computeMinMovesGrid
// already uses for the scanner/squid. `startTick` lets legs chain (a later
// leg starts wherever the fan's rotation left off, not back at tick 0).
// Returns null if there's no safe route at all.
function findCoreLeg(level, from, to, destroyed, startTick, doorOpen) {
  const period = Math.round((Math.PI * 2) / CORE_ROTATION_SPEED);
  const grid = level.grid;
  function isFloor(r, c) {
    if (doorOpen && level.doorPos && r === level.doorPos.row && c === level.doorPos.col) return true;
    return r >= 0 && r < grid.length && c >= 0 && c < grid[0].length && grid[r][c] !== 'wall';
  }
  const startKey = `${from.row},${from.col},${startTick % period}`;
  const parent = new Map([[startKey, null]]);
  const actionOf = new Map();
  const queue = [{ row: from.row, col: from.col, tick: startTick, key: startKey }];
  const dirs = [['moveRight', 0, 1], ['moveLeft', 0, -1], ['moveDown', 1, 0], ['moveUp', -1, 0], ['wait', 0, 0]];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (cur.row === to.row && cur.col === to.col) {
      const actions = [];
      let k = cur.key;
      while (parent.get(k) !== null && parent.has(k)) {
        actions.push(actionOf.get(k));
        k = parent.get(k);
      }
      actions.reverse();
      return { actions, endTick: cur.tick };
    }
    if (cur.tick - startTick > MAX_STEPS * 2) continue;
    for (const [action, dr, dc] of dirs) {
      const nr = cur.row + dr;
      const nc = cur.col + dc;
      if (!isFloor(nr, nc)) continue;
      const nextTick = cur.tick + 1;
      if (coreIsCellDangerous(level, destroyed, nr, nc, nextTick)) continue;
      const key = `${nr},${nc},${nextTick % period}`;
      if (parent.has(key)) continue;
      parent.set(key, cur.key);
      actionOf.set(key, action);
      queue.push({ row: nr, col: nc, tick: nextTick, key });
    }
  }
  return null;
}

// Builds one full route: nearest-unvisited-scanner each step (same greedy
// TSP tradeoff as the Vault's greedyVaultPar — visiting order has no cheap
// exact solution), then the exit, each leg dodging whichever tentacles are
// still alive at that point. Returns null (rather than throwing) if any
// leg has no safe route, so the caller can just try a different layout —
// same "generate, verify, regenerate" convention as every other world's
// maze, just extended to cover the hazard, not only wall connectivity.
function solveCoreLevel(level) {
  const destroyed = level.tentacles.map(() => false);
  let pos = level.start;
  let tick = 0;
  const allActions = [];
  let remaining = level.scanners.slice();
  while (remaining.length) {
    let best = null;
    for (const s of remaining) {
      const leg = findCoreLeg(level, pos, s, destroyed, tick, false);
      if (leg && (!best || leg.actions.length < best.leg.actions.length)) best = { s, leg };
    }
    if (!best) return null;
    allActions.push(...best.leg.actions);
    tick = best.leg.endTick;
    pos = { row: best.s.row, col: best.s.col };
    destroyed[best.s.tentacleId] = true;
    remaining = remaining.filter((s) => s !== best.s);
  }
  const toExit = findCoreLeg(level, pos, level.exit, destroyed, tick, true);
  if (!toExit) return null;
  allActions.push(...toExit.actions);
  return { actions: allActions, ticks: toExit.endTick };
}

// Same "generate, verify, regenerate on failure" convention as every other
// world's maze (see DESIGN.md) — here the failure mode is either the
// door/exit spur severing the one path through a cell it overwrote, or a
// layout where no route through all five scanners can dodge the fan.
function generateLevel(seed) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const level = buildCoreAttempt(seed + attempt * 104729);
    if (level) return level;
  }
  throw new Error('Could not generate a solvable Core layout — this should not happen.');
}

const LEVEL = generateLevel(Progress.getSeed(WORLD_ID));
Progress.setWorldPar(WORLD_ID, LEVEL.parMoves);

const COMMANDS = [
  { id: 'moveRight', label: 'moveRight()', insert: 'moveRight();\n', pattern: /moveRight\s*\(/ },
  { id: 'moveLeft', label: 'moveLeft()', insert: 'moveLeft();\n', pattern: /moveLeft\s*\(/ },
  { id: 'moveUp', label: 'moveUp()', insert: 'moveUp();\n', pattern: /moveUp\s*\(/ },
  { id: 'moveDown', label: 'moveDown()', insert: 'moveDown();\n', pattern: /moveDown\s*\(/ },
  { id: 'wait', label: 'wait()', insert: 'wait();\n', pattern: /wait\s*\(/ },
  { id: 'forLoop', label: 'for loop', insert: 'for (let i = 0; i < 3; i++) {\n  \n}\n', pattern: /for\s*\(/ },
];

let runner;
let editor;
let lastFrameMs;
let lastStatus = null;
let resultCache = null;
let errorLine = null;
let stepController;
let stepping = false;
let cutsceneStart = null;
const CUTSCENE_DURATION = 3.4;

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(480, 420);
    canvas.parent('level-canvas-holder');
    runner = new GridMazeRunner(p, LEVEL, { tile: 40, viewportW: 480, viewportH: 420, theme: 'core' });
    lastFrameMs = performance.now();
    stepController = createStepController({
      editor,
      runner,
      statusEl: document.getElementById('step-status'),
      nextBtn: document.getElementById('step-next-btn'),
    });
  };

  p.draw = () => {
    const now = performance.now();
    const dt = (now - lastFrameMs) / 1000;
    lastFrameMs = now;
    runner.update(dt);
    runner.draw();
    drawExitLadder(p);
    if (runner.status === 'won') {
      if (cutsceneStart === null) cutsceneStart = now;
      const elapsed = (now - cutsceneStart) / 1000;
      if (elapsed < CUTSCENE_DURATION) drawEscapeCutscene(p, elapsed);
    } else {
      cutsceneStart = null;
    }
    renderStatus();
  };
}

function exitScreenPos() {
  return {
    x: LEVEL.exit.col * runner.tile + runner.tile / 2 - runner.cameraX,
    y: LEVEL.exit.row * runner.tile + runner.tile / 2 - runner.cameraY,
  };
}

// A ladder waiting at the exit, visible the moment the door's open — set
// dressing that tells you what "the exit" actually is before you ever
// reach it.
function drawExitLadder(p) {
  const destroyed = runner.trace[Math.min(runner.stepIndex + 1, runner.trace.length - 1)].tentacleDestroyed || [];
  if (!(destroyed.length > 0 && destroyed.every(Boolean))) return;
  const { x, y } = exitScreenPos();
  p.push();
  p.stroke(150, 150, 160);
  p.strokeWeight(2);
  p.line(x - 8, y + 16, x - 8, y - 20);
  p.line(x + 8, y + 16, x + 8, y - 20);
  for (let ry = y + 10; ry > y - 20; ry -= 9) p.line(x - 8, ry, x + 8, ry);
  p.pop();
}

function drawHelicopter(p, x, y, alpha) {
  p.push();
  p.translate(x, y);
  p.noStroke();
  p.fill(60, 65, 75, alpha);
  p.rect(2, -4, 34, 8, 3);
  p.fill(200, 200, 210, alpha * 0.5);
  p.ellipse(36, -2, 4, 18);
  p.fill(80, 90, 105, alpha);
  p.ellipse(-4, 0, 40, 22);
  p.fill(140, 190, 220, alpha * 0.8);
  p.ellipse(-8, -2, 14, 10);
  p.stroke(50, 50, 55, alpha);
  p.strokeWeight(2);
  p.line(-20, 12, 10, 12);
  p.line(-16, 8, -16, 14);
  p.line(4, 8, 4, 14);
  p.noStroke();
  p.fill(210, 210, 220, alpha * 0.55);
  p.ellipse(-4, -14, 76, 5);
  p.fill(60, 65, 75, alpha);
  p.rect(-6, -16, 4, 5);
  p.pop();
}

// Phase 1 (0-1.3s): climb the ladder. Phase 2 (1.3s-end): a helicopter
// lifts off and drifts away, fading out near the end.
function drawEscapeCutscene(p, elapsed) {
  const { x: exitX, y: exitY } = exitScreenPos();
  p.push();
  p.noStroke();
  p.fill(5, 5, 10, 140);
  p.rect(0, 0, runner.viewportW, runner.viewportH);

  p.stroke(150, 150, 160);
  p.strokeWeight(2);
  p.line(exitX - 8, exitY + 16, exitX - 8, exitY - 60);
  p.line(exitX + 8, exitY + 16, exitX + 8, exitY - 60);
  for (let ry = exitY + 10; ry > exitY - 60; ry -= 9) p.line(exitX - 8, ry, exitX + 8, ry);

  if (elapsed < 1.3) {
    const t = elapsed / 1.3;
    const climbY = exitY + 6 - t * 66;
    const wobble = Math.sin(elapsed * 14) * 2;
    p.push();
    p.translate(exitX + wobble, climbY);
    drawCharacter(p, runner.tile, {});
    p.pop();
  } else {
    const t2 = Math.min((elapsed - 1.3) / 1.9, 1);
    const heliY = (exitY - 60) - t2 * 170;
    const alpha = t2 > 0.8 ? p.map(t2, 0.8, 1, 255, 0) : 255;
    drawHelicopter(p, exitX, heliY, alpha);
  }
  p.pop();
}

function renderWorldMeta() {
  const el = document.getElementById('world-meta');
  const state = Progress.getWorld(WORLD_ID);
  if (!state.cleared) {
    el.textContent = `Par: ${LEVEL.parMoves} ticks — a real route through all five scanners, dodging the fan the whole way, not a proven global minimum (visiting order isn't cheap to search exactly). Match it for a star.`;
    return;
  }
  const starred = state.bestMoves <= LEVEL.parMoves;
  el.innerHTML = `Best: ${state.bestMoves} ticks (par ${LEVEL.parMoves})` +
    (starred ? ' <span class="star">&#9733;</span>' : '');
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
    const updated = Progress.recordClear(WORLD_ID, moves);
    const usedWait = runner.trace.some((t) => t.action === 'wait');
    resultCache = { moves, bestMoves: updated.bestMoves, starred: updated.bestMoves <= LEVEL.parMoves, usedWait };
    renderWorldMeta();
    renderNextWorldLink(WORLD_ID);
    checkAchievements();
  }
  lastStatus = runner.status;

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      statusEl.textContent = `Every tentacle down, door open, and you're out — climbing the ladder to the helicopter. ` +
        `${r.moves} ticks, best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves}).`;
      break;
    }
    case 'caught': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Tick ${last.tick}: a tentacle swept through (row ${last.row}, col ${last.col}) — caught. ` +
        `They rotate together on a fixed cycle; wait() doesn't protect you if one sweeps through where you're standing.`;
      break;
    }
    case 'blocked': {
      const last = runner.trace[runner.trace.length - 1];
      const atDoor = last.row === LEVEL.doorPos.row && last.col === LEVEL.doorPos.col;
      if (atDoor) {
        const remaining = last.tentacleDestroyed.filter((d) => !d).length;
        statusEl.textContent = `Tick ${last.tick}: the door won't budge — ${remaining} tentacle${remaining === 1 ? '' : 's'} still active.`;
      } else {
        statusEl.textContent = `Tick ${last.tick}: that's a wall (row ${last.row}, col ${last.col}). Edit your code and run again.`;
      }
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

function checkAchievements() {
  const code = stripComments(editor.getValue());
  const newly = [];
  const record = (id) => {
    const { isNew } = Progress.unlockAchievement(id);
    if (isNew) newly.push(id);
  };
  if (/for\s*\(|while\s*\(/.test(code)) record('looper');
  if (/wait\s*\(/.test(code)) record('patient');
  if (/moveLeft\s*\(/.test(code)) record('backtracker');
  const actionsUsed = new Set(runner.trace.map((t) => t.action));
  if (['moveUp', 'moveDown', 'moveLeft', 'moveRight'].every((a) => actionsUsed.has(a))) {
    record('compass');
  }
  if (!resultCache.usedWait) record('fearless');
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
  const code = editor.getValue();
  clearSyntaxHighlight();
  const syntaxErr = findSyntaxError(code);
  if (syntaxErr) {
    highlightSyntaxError(syntaxErr);
    runner.loadTrace([{ row: LEVEL.start.row, col: LEVEL.start.col, event: 'start', tick: 0 }], false, syntaxErr.message);
    return;
  }
  const { trace, success, error } = simulateCore(LEVEL, code);
  runner.loadTrace(trace, success, error);
}

// Step mode: same syntax check + simulate as Run, but hands the result to
// the shared step controller (engine.js) instead of auto-playing it — one
// click of Next advances one move OR one for-loop init/test/update phase.
function stepCode() {
  const code = editor.getValue();
  clearSyntaxHighlight();
  const syntaxErr = findSyntaxError(code);
  if (syntaxErr) {
    highlightSyntaxError(syntaxErr);
    runner.loadTrace([{ row: LEVEL.start.row, col: LEVEL.start.col, event: 'start', tick: 0 }], false, syntaxErr.message);
    return;
  }
  const result = simulateCore(LEVEL, code);
  stepping = true;
  document.getElementById('step-controls').style.display = '';
  stepController.start(result);
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('level-hint').textContent =
    `Par is ${LEVEL.parMoves} ticks — a real, dodging-included route, not a guaranteed global minimum. Five scanners ` +
    `are scattered through the maze; each one you reach destroys a tentacle. All five gone opens the door north of ` +
    `the boss chamber.`;

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
  new p5(sketch);
});
