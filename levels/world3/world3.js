// World 3 — The Dungeon Halls (MVP slice). Conditionals. A generated maze
// with a small octopus that chases you — greedy shortest-path toward your
// current position, recomputed after every move you make. Still fully
// deterministic and simulate-at-build-time, same as every other world: see
// DESIGN.md.
const WORLD_ID = 'world3';

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
  const mazeRows = 3;
  const mazeCols = 5 + Math.floor(rng() * 2); // 5..6 cells — a bit more room for dead ends
  const grid = generateMaze(mazeRows, mazeCols, rng);
  const start = { row: grid.length - 2, col: 1 };
  const goal = { row: 1, col: grid[0].length - 2 };
  const solutionPath = bfsPath(grid, start, goal);
  const onPath = new Set(solutionPath.map((c) => `${c.row},${c.col}`));

  // A perfect maze (recursive backtracker) has exactly one route between
  // any two points, so an octopus that starts ON that route can simply
  // walk straight at the player with no way for them to get around it —
  // that's the "Par: Infinity" bug this fixes. Starting it in a dead-end
  // branch instead means the player only has to worry about it near that
  // branch's junction, not the whole route.
  const offPathCells = [];
  for (let r = 1; r < grid.length; r += 2) {
    for (let c = 1; c < grid[0].length; c += 2) {
      if (grid[r][c] === 'floor' && !onPath.has(`${r},${c}`)) offPathCells.push({ row: r, col: c });
    }
  }

  const candidates = shuffleWithRng(offPathCells.length ? offPathCells : solutionPath.slice(1, -1), rng);
  for (const octopusStart of candidates) {
    const level = { grid, start, goal, octopusStart };
    const par = computeMinMovesGridChase(level);
    if (par !== Infinity) {
      level.parMoves = par;
      return level;
    }
  }
  // Last resort (shouldn't normally hit this): tuck it in the corner
  // farthest from both start and goal.
  const level = { grid, start, goal, octopusStart: { row: grid.length - 2, col: grid[0].length - 2 } };
  level.parMoves = computeMinMovesGridChase(level);
  return level;
}

const LEVEL = generateLevel(Progress.getSeed(WORLD_ID));
Progress.setWorldPar(WORLD_ID, LEVEL.parMoves);

const COMMANDS = [
  { id: 'moveRight', label: 'moveRight()', insert: 'moveRight();\n', pattern: /moveRight\s*\(/ },
  { id: 'moveLeft', label: 'moveLeft()', insert: 'moveLeft();\n', pattern: /moveLeft\s*\(/ },
  { id: 'moveUp', label: 'moveUp()', insert: 'moveUp();\n', pattern: /moveUp\s*\(/ },
  { id: 'moveDown', label: 'moveDown()', insert: 'moveDown();\n', pattern: /moveDown\s*\(/ },
  { id: 'wait', label: 'wait()', insert: 'wait();\n', pattern: /wait\s*\(/ },
  { id: 'ifStatement', label: 'if (...)', insert: 'if (octopusNear()) {\n  \n}\n', pattern: /if\s*\(/ },
  { id: 'octopusNear', label: 'octopusNear()', insert: 'octopusNear()', pattern: /octopusNear\s*\(/ },
];

let runner;
let editor;
let lastFrameMs;
let lastStatus = null;
let resultCache = null;
let errorLine = null;

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(440, 360);
    canvas.parent('level-canvas-holder');
    runner = new GridMazeRunner(p, LEVEL, { tile: 40, viewportW: 440, viewportH: 360 });
    lastFrameMs = performance.now();
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
      statusEl.textContent = `Escaped the hall in ${r.moves} moves — best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves}).`;
      break;
    }
    case 'blocked': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Move ${last.tick}: that's a wall (row ${last.row}, col ${last.col}). Edit your code and run again.`;
      break;
    }
    case 'caught': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Move ${last.tick}: the octopus got you at (row ${last.row}, col ${last.col}). It always takes the shortest path toward wherever you just moved — try checking octopusNear() before you commit to a move.`;
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
  if (/if\s*\(/.test(code)) record('decider');
  if (/wait\s*\(/.test(code)) record('patient');
  if (/moveLeft\s*\(/.test(code)) record('backtracker');
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
  const { trace, success, error } = simulateGridMazeChase(LEVEL, code);
  runner.loadTrace(trace, success, error);
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('level-hint').textContent =
    `Par is ${LEVEL.parMoves} moves. octopusNear() tells you if it's within 2 tiles right now — use it to decide your next move instead of committing to a fixed script.`;

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
  new p5(sketch);
});
