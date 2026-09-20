// World 4 — The Foundry. Functions. A catwalk with three identical gaps —
// each one needs the same four-move detour (up, over, over, down), so
// writing it once as a function and calling it three times is the natural
// solution, though nothing enforces that (same "teaches by fit, not force"
// choice already made for World 2's loops).
const WORLD_ID = 'world4';

// Unlike World 2/3's generated mazes, this layout is fully connected by
// construction (a straight catwalk with forced detours) — there's exactly
// one route, so no BFS-based solvability check is needed, only a par count.
function generateLevel(seed) {
  const rng = mulberry32(seed);
  const cols = 14 + Math.floor(rng() * 5); // 14..18
  const grid = [new Array(cols).fill('wall'), new Array(cols).fill('floor')];

  const minCol = 3;
  const maxCol = cols - 4;
  const gapCols = [];
  let attempts = 0;
  while (gapCols.length < 3 && attempts < 200) {
    attempts++;
    const c = minCol + Math.floor(rng() * (maxCol - minCol + 1));
    if (gapCols.some((g) => Math.abs(g - c) < 3)) continue;
    gapCols.push(c);
  }
  while (gapCols.length < 3) {
    gapCols.push(minCol + gapCols.length * 3);
  }
  gapCols.sort((a, b) => a - b);

  gapCols.forEach((g) => {
    grid[1][g] = 'wall';
    grid[0][g - 1] = 'floor';
    grid[0][g] = 'floor';
    grid[0][g + 1] = 'floor';
  });

  const start = { row: 1, col: 0 };
  const goal = { row: 1, col: cols - 1 };
  return { grid, start, goal };
}

const LEVEL = generateLevel(Progress.getSeed(WORLD_ID));
const PAR = computeMinMovesGrid(LEVEL);
Progress.setWorldPar(WORLD_ID, PAR);

const COMMANDS = [
  { id: 'moveRight', label: 'moveRight()', insert: 'moveRight();\n', pattern: /moveRight\s*\(/ },
  { id: 'moveLeft', label: 'moveLeft()', insert: 'moveLeft();\n', pattern: /moveLeft\s*\(/ },
  { id: 'moveUp', label: 'moveUp()', insert: 'moveUp();\n', pattern: /moveUp\s*\(/ },
  { id: 'moveDown', label: 'moveDown()', insert: 'moveDown();\n', pattern: /moveDown\s*\(/ },
  { id: 'wait', label: 'wait()', insert: 'wait();\n', pattern: /wait\s*\(/ },
  { id: 'funcDecl', label: 'function ...() {}', insert: 'function passGap() {\n  \n}\n', pattern: /function\s+\w+\s*\(/ },
];

let runner;
let editor;
let lastFrameMs;
let lastStatus = null;
let resultCache = null;
let errorLine = null;

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(480, 224);
    canvas.parent('level-canvas-holder');
    runner = new GridMazeRunner(p, LEVEL, { tile: 56, viewportW: 480, viewportH: 224, theme: 'foundry' });
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
    el.textContent = `Par: ${PAR} moves. Match it for a star.`;
    return;
  }
  const starred = state.bestMoves <= PAR;
  el.innerHTML = `Best: ${state.bestMoves} moves (par ${PAR})` +
    (starred ? ' <span class="star">&#9733;</span>' : '');
}

function renderStatus() {
  const statusEl = document.getElementById('status');
  if (!runner) return;
  statusEl.className = runner.status;

  if (runner.status === 'won' && lastStatus !== 'won') {
    const moves = runner.trace.length - 1;
    const updated = Progress.recordClear(WORLD_ID, moves);
    resultCache = { moves, bestMoves: updated.bestMoves, starred: updated.bestMoves <= PAR };
    renderWorldMeta();
    renderNextWorldLink(WORLD_ID);
    checkAchievements();
    checkGameWinAndAnnounce();
  }
  lastStatus = runner.status;

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      statusEl.textContent = `Crossed the catwalk in ${r.moves} moves — best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${PAR}).`;
      break;
    }
    case 'blocked': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Move ${last.tick}: that's a gap in the plating (row ${last.row}, col ${last.col}) — you need the detour there, not a straight line. Edit your code and run again.`;
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

// A function counts as "reused" if some declared name is also called at
// least twice beyond its own declaration line.
function usesReusableFunction(code) {
  const decls = [...code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  return decls.some(([, name]) => {
    const callPattern = new RegExp('\\b' + name + '\\s*\\(', 'g');
    const total = (code.match(callPattern) || []).length;
    return total - 1 >= 2;
  });
}

function checkAchievements() {
  const code = stripComments(editor.getValue());
  const newly = [];
  const record = (id) => {
    const { isNew } = Progress.unlockAchievement(id);
    if (isNew) newly.push(id);
  };
  if (/wait\s*\(/.test(code)) record('patient');
  if (/moveLeft\s*\(/.test(code)) record('backtracker');
  if (usesReusableFunction(code)) record('reuser');
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

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('level-hint').textContent =
    `Par is ${PAR} moves. There are three gaps in the catwalk, each needing the same detour — up, over, over, down.`;

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
