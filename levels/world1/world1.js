// World 1 — The Wreck. Sequential commands only: moveRight(), moveLeft(), jump().
// Layout is procedurally generated from a per-player seed (see Progress.getSeed)
// so it's randomized but stable for that player, and always solvable by
// construction: gaps are spaced >=3 apart, so a 2-tile jump can always clear
// exactly one of them without ever landing on another.
const WORLD_ID = 'world1';

function generateLevel(seed) {
  const rng = mulberry32(seed);
  const length = 10 + Math.floor(rng() * 7); // 10..16 columns
  const columns = new Array(length).fill('ground');
  const gapCount = 2 + Math.floor(rng() * 2); // 2..3 gaps
  const gapCols = [];
  let attempts = 0;
  while (gapCols.length < gapCount && attempts < 200) {
    attempts++;
    const c = 2 + Math.floor(rng() * (length - 4));
    if (gapCols.every((g) => Math.abs(g - c) >= 3)) gapCols.push(c);
  }
  gapCols.forEach((c) => { columns[c] = 'gap'; });
  columns[length - 1] = 'goal';
  const level = { startCol: 0, columns };
  level.parMoves = computeMinMoves(level);
  return level;
}

const LEVEL = generateLevel(Progress.getSeed(WORLD_ID));
Progress.setWorldPar(WORLD_ID, LEVEL.parMoves);

const COMMANDS = [
  { id: 'moveRight', label: 'moveRight()', insert: 'moveRight();\n', pattern: /moveRight\s*\(/ },
  { id: 'moveLeft', label: 'moveLeft()', insert: 'moveLeft();\n', pattern: /moveLeft\s*\(/ },
  { id: 'jump', label: 'jump()', insert: 'jump();\n', pattern: /jump\s*\(/ },
];

let runner;
let editor;
let lastFrameMs;
let lastStatus = null;
let resultCache = null;
let errorLine = null;
let stepController;
let stepping = false;
// Starts on the first Run/Step click on this page load, not page open —
// reading the instructions shouldn't count against your time. Stays null
// (no time recorded) if the player somehow wins without ever clicking
// either, which can't actually happen through the UI.
let firstRunMs = null;

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(480, 320);
    canvas.parent('level-canvas-holder');
    runner = new SideScrollerRunner(p, LEVEL, { viewportW: 480, viewportH: 320, groundY: 240 });
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

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      const timeNote = r.timeMs != null ? ` in ${formatDuration(r.timeMs)} (best ${formatDuration(r.bestTimeMs)})` : '';
      statusEl.textContent = `Reached the flag in ${r.moves} moves — best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves})${timeNote}.`;
      break;
    }
    case 'fell':
      statusEl.textContent = 'You fell in a gap. Edit your code and run again.';
      break;
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
  if (/jump\s*\(/.test(code)) record('jumper');
  if (/moveLeft\s*\(/.test(code)) record('backtracker');
  if (resultCache.starred) record('perfectionist');
  const escapee = checkEscapeeAchievement(WORLDS);
  if (escapee.isNew) newly.push('escapee');
  announceAchievements(newly);
}

let errorMark = null;
function clearSyntaxHighlight() {
  if (errorMark) { errorMark.clear(); errorMark = null; }
  if (errorLine !== null) { editor.removeLineClass(errorLine, 'background', 'cm-error-line'); }
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
  if (firstRunMs === null) firstRunMs = performance.now();
  const code = editor.getValue();
  clearSyntaxHighlight();
  const syntaxErr = findSyntaxError(code);
  if (syntaxErr) {
    highlightSyntaxError(syntaxErr);
    runner.loadTrace([{ col: LEVEL.startCol, event: 'start' }], false, syntaxErr.message);
    return;
  }
  const { trace, success, error } = simulateSideScroller(LEVEL, code);
  runner.loadTrace(trace, success, error);
}

// Step mode: same syntax check + simulate as Run, but hands the result to
// the shared step controller (engine.js) instead of auto-playing it — one
// click of Next advances one move OR one for-loop init/test/update phase.
function stepCode() {
  if (firstRunMs === null) firstRunMs = performance.now();
  const code = editor.getValue();
  clearSyntaxHighlight();
  const syntaxErr = findSyntaxError(code);
  if (syntaxErr) {
    highlightSyntaxError(syntaxErr);
    runner.loadTrace([{ col: LEVEL.startCol, event: 'start' }], false, syntaxErr.message);
    return;
  }
  const result = simulateSideScroller(LEVEL, code);
  stepping = true;
  document.getElementById('step-controls').style.display = '';
  stepController.start(result);
}

window.addEventListener('DOMContentLoaded', () => {
  const gapCount = LEVEL.columns.filter((t) => t === 'gap').length;
  document.getElementById('level-hint').textContent =
    `The flag is ${LEVEL.columns.length - 1} steps from the start, with ${gapCount} gaps along the way.`;

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
