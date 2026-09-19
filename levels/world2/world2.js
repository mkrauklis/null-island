// World 2 — The Vents. Loops. A grid maze with a patrolling Scanner.
const WORLD_ID = 'world2';
const ROWS = 6;
const COLS = 10;

const grid = [];
for (let r = 0; r < ROWS; r++) {
  const row = [];
  for (let c = 0; c < COLS; c++) {
    row.push((r === ROWS - 1 || c === COLS - 1) ? 'floor' : 'wall');
  }
  grid.push(row);
}

const LEVEL = {
  grid,
  start: { row: ROWS - 1, col: 0 },
  goal: { row: 0, col: COLS - 1 },
  scanner: {
    path: [6, 5, 4, 3, 4, 5].map((c) => ({ row: ROWS - 1, col: c })),
  },
};
LEVEL.parMoves = computeMinMovesGrid(LEVEL);

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

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(COLS * 48, ROWS * 48);
    canvas.parent('level-canvas-holder');
    runner = new GridMazeRunner(p, LEVEL, { tile: 48 });
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
    el.textContent = `Par: ${LEVEL.parMoves} moves.`;
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
  }
  lastStatus = runner.status;

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      statusEl.textContent = `Made it to the grate in ${r.moves} moves — best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves}).`;
      break;
    }
    case 'blocked':
      statusEl.textContent = 'That vent panel is solid. Edit your code and run again.';
      break;
    case 'caught':
      statusEl.textContent = 'The Scanner caught you. Edit your code and run again.';
      break;
    case 'error':
      statusEl.textContent = 'Error: ' + runner.errorMessage;
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

function runCode() {
  const code = editor.getValue();
  const { trace, success, error } = simulateGridMaze(LEVEL, code);
  runner.loadTrace(trace, success, error);
}

window.addEventListener('DOMContentLoaded', () => {
  editor = CodeMirror.fromTextArea(document.getElementById('code'), {
    mode: 'javascript',
    theme: 'dracula',
    lineNumbers: true,
    tabSize: 2,
  });
  editor.on('change', checkForNewlyTypedCommands);
  checkForNewlyTypedCommands();
  renderCommandPalette();
  renderWorldMeta();
  document.getElementById('run-btn').addEventListener('click', runCode);
  new p5(sketch);
});
