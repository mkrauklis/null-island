// World 5 — The Vault. Arrays & objects. A bigger generated maze scattered
// with switch terminals; stepping on one lights it, and the exit only
// counts once every terminal is lit. switches() hands back the whole list
// as an array of {row, col, on} objects — the natural way to check "are we
// done yet" is to loop over it, not track four separate booleans by hand.
const WORLD_ID = 'world5';
const SWITCH_COUNT = 4;

function bfsDistances(grid, from) {
  const rows = grid.length;
  const cols = grid[0].length;
  const dist = Array.from({ length: rows }, () => new Array(cols).fill(Infinity));
  dist[from.row][from.col] = 0;
  const queue = [from];
  let qi = 0;
  const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  while (qi < queue.length) {
    const cur = queue[qi++];
    for (const [dr, dc] of deltas) {
      const nr = cur.row + dr;
      const nc = cur.col + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (grid[nr][nc] === 'wall') continue;
      if (dist[nr][nc] > dist[cur.row][cur.col] + 1) {
        dist[nr][nc] = dist[cur.row][cur.col] + 1;
        queue.push({ row: nr, col: nc });
      }
    }
  }
  return dist;
}

// Visiting-order TSP over 4+ points has no cheap exact solution, so — same
// tradeoff as World 3's findGreedySolution — this constructs *a* working
// route (nearest unvisited switch each time, then the goal) and reports its
// length as par. A working solution, not a proven minimum.
function greedyVaultPar(level) {
  const { grid, start, goal, switches } = level;
  let current = start;
  let remaining = switches.slice();
  let total = 0;
  while (remaining.length) {
    const dist = bfsDistances(grid, current);
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = dist[s.row][s.col];
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    total += bestDist;
    current = remaining[bestIdx];
    remaining = remaining.filter((_, i) => i !== bestIdx);
  }
  total += bfsDistances(grid, current)[goal.row][goal.col];
  return total;
}

function generateLevel(seed) {
  const rng = mulberry32(seed);
  const mazeRows = 5 + Math.floor(rng() * 2); // 5..6
  const mazeCols = 9 + Math.floor(rng() * 3); // 9..11
  const grid = generateMaze(mazeRows, mazeCols, rng);
  const start = { row: grid.length - 2, col: 1 };
  const goal = { row: 1, col: grid[0].length - 2 };

  const roomCells = [];
  for (let r = 1; r < grid.length; r += 2) {
    for (let c = 1; c < grid[0].length; c += 2) {
      if (grid[r][c] !== 'floor') continue;
      if ((r === start.row && c === start.col) || (r === goal.row && c === goal.col)) continue;
      roomCells.push({ row: r, col: c });
    }
  }

  const shuffled = shuffleWithRng(roomCells, rng);
  const switches = [];
  for (const cell of shuffled) {
    if (switches.length >= SWITCH_COUNT) break;
    const tooClose = switches.some((s) => Math.abs(s.row - cell.row) + Math.abs(s.col - cell.col) < 4)
      || Math.abs(cell.row - start.row) + Math.abs(cell.col - start.col) < 2
      || Math.abs(cell.row - goal.row) + Math.abs(cell.col - goal.col) < 2;
    if (tooClose) continue;
    switches.push({ id: switches.length, row: cell.row, col: cell.col });
  }
  // Fallback if spacing was too strict to fill every slot: just take
  // whatever's left, in order — still connected, still solvable.
  for (const cell of shuffled) {
    if (switches.length >= SWITCH_COUNT) break;
    if (switches.some((s) => s.row === cell.row && s.col === cell.col)) continue;
    switches.push({ id: switches.length, row: cell.row, col: cell.col });
  }

  const level = { grid, start, goal, switches };
  level.parMoves = greedyVaultPar(level);
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
  { id: 'forLoop', label: 'for loop', insert: 'for (let i = 0; i < 3; i++) {\n  \n}\n', pattern: /for\s*\(/ },
  { id: 'switchesCall', label: 'switches()', insert: 'switches()', pattern: /switches\s*\(/ },
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
    runner = new GridMazeRunner(p, LEVEL, { tile: 40, viewportW: 480, viewportH: 384, theme: 'vault' });
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
    el.textContent = `Par: ${LEVEL.parMoves} moves (a working solution, not a proven minimum — visiting order isn't cheap to search exactly). Match it for a star.`;
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
    checkGameWinAndAnnounce();
  }
  lastStatus = runner.status;

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      statusEl.textContent = `Every terminal lit, vault open — ${r.moves} moves, best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves}).`;
      break;
    }
    case 'goal-incomplete': {
      const last = runner.trace[runner.trace.length - 1];
      const remaining = last.switchesOn.filter((on) => !on).length;
      statusEl.textContent = `Move ${last.tick}: reached the exit, but ${remaining} terminal${remaining === 1 ? "'s" : 's'} still dark — it won't open yet.`;
      break;
    }
    case 'blocked': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Move ${last.tick}: that's a wall (row ${last.row}, col ${last.col}). Edit your code and run again.`;
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

// "Used the array" means referencing switches() alongside a loop or array
// method — not just calling it once out of curiosity.
function usesSwitchesArray(code) {
  if (!/switches\s*\(/.test(code)) return false;
  return /for\s*\(|\.(forEach|map|filter|every|some|find|length)\b/.test(code);
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
  if (usesSwitchesArray(code)) record('lister');
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
  const { trace, success, error } = simulateVault(LEVEL, code);
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
  const result = simulateVault(LEVEL, code);
  stepping = true;
  document.getElementById('step-controls').style.display = '';
  stepController.start(result);
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('level-hint').textContent =
    `Par is ${LEVEL.parMoves} moves. There are ${SWITCH_COUNT} terminals scattered through the maze — all four have to be lit before the exit does anything.`;

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
