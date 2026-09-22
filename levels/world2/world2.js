// World 2 — The Vents. Loops. A real generated maze with a patrol drone.
const WORLD_ID = 'world2';

function bfsPath(grid, start, goal) {
  const rows = grid.length;
  const cols = grid[0].length;
  const prev = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
  visited[start.row][start.col] = true;
  const queue = [start];
  let qi = 0;
  const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (cur.row === goal.row && cur.col === goal.col) break;
    for (const [dr, dc] of deltas) {
      const nr = cur.row + dr;
      const nc = cur.col + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (grid[nr][nc] === 'wall' || visited[nr][nc]) continue;
      visited[nr][nc] = true;
      prev[nr][nc] = cur;
      queue.push({ row: nr, col: nc });
    }
  }
  const path = [];
  let cur = goal;
  while (cur) { path.unshift(cur); cur = prev[cur.row][cur.col]; }
  return path;
}

function generateLevel(seed) {
  const rng = mulberry32(seed);
  const mazeRows = 3 + Math.floor(rng() * 2); // 3..4 cells
  const mazeCols = 6 + Math.floor(rng() * 3); // 6..8 cells
  const grid = generateMaze(mazeRows, mazeCols, rng);
  const start = { row: grid.length - 2, col: 1 };
  const goal = { row: 1, col: grid[0].length - 2 };
  const solutionPath = bfsPath(grid, start, goal);

  const patrolLen = 3 + Math.floor(rng() * 3); // 3..5 cells
  const maxStart = Math.max(1, solutionPath.length - patrolLen - 2);
  let best = null;
  const tryOrder = shuffleWithRng([...Array(Math.max(1, maxStart)).keys()], rng);
  for (const windowStart of tryOrder) {
    const window = solutionPath.slice(windowStart + 1, windowStart + 1 + patrolLen);
    if (window.length < 2) continue;
    const forward = window;
    const backward = window.slice(1, -1).reverse();
    const bounce = forward.concat(backward);
    for (const phase of shuffleWithRng([...Array(bounce.length).keys()], rng)) {
      const rotated = bounce.slice(phase).concat(bounce.slice(0, phase));
      const level = { grid, start, goal, scanner: { path: rotated } };
      const par = computeMinMovesGrid(level);
      if (par === Infinity) continue;
      const collides = solutionPath.some((cell, i) => {
        if (i === 0) return false;
        const s = scannerPositionAt(level.scanner, i);
        return s.row === cell.row && s.col === cell.col;
      });
      if (collides) { level.parMoves = par; best = level; break; }
      if (!best) { level.parMoves = par; best = level; }
    }
    if (best && best.parMoves !== undefined) break;
  }
  return best;
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

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(480, 384);
    canvas.parent('level-canvas-holder');
    runner = new GridMazeRunner(p, LEVEL, { tile: 40, viewportW: 480, viewportH: 384 });
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
    renderStatus();
  };
}

function renderWorldMeta() {
  const el = document.getElementById('world-meta');
  const state = Progress.getWorld(WORLD_ID);
  if (!state.cleared) {
    el.textContent = `Par: ${LEVEL.parMoves} moves — the fewest moves anyone's found to clear this. Match it for a star.`;
    return;
  }
  const starred = state.bestMoves <= LEVEL.parMoves;
  el.innerHTML = `Best: ${state.bestMoves} moves (par ${LEVEL.parMoves})` +
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
    resultCache = { moves, bestMoves: updated.bestMoves, starred: updated.bestMoves <= LEVEL.parMoves };
    renderWorldMeta();
    renderNextWorldLink(WORLD_ID);
    checkAchievements();
  }
  lastStatus = runner.status;

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      statusEl.textContent = `Made it to the grate in ${r.moves} moves — best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves}).`;
      break;
    }
    case 'blocked': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Move ${last.tick}: that's not part of the grate — you hit a wall (row ${last.row}, col ${last.col}). Edit your code and run again.`;
      break;
    }
    case 'caught': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Move ${last.tick}: the drone caught you at (row ${last.row}, col ${last.col}). Try changing when you start moving, not just how — a wait() shifts your timing by one tick.`;
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
  const { trace, success, error } = simulateGridMaze(LEVEL, code);
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
  const result = simulateGridMaze(LEVEL, code);
  stepping = true;
  document.getElementById('step-controls').style.display = '';
  stepController.start(result);
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('level-hint').textContent =
    `Stay on the lit grate panels — that's the only surface here. It's a real maze this time (par is ${LEVEL.parMoves} moves), so you may need to explore before you find the way through.`;

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
