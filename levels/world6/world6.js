// World 6 — The Core. Events/callbacks. Five tentacles, each cycling
// through its own hidden/exposed pattern (tentacleExposedAt, engine.js —
// same deterministic-per-tick trick as the scanner/squid). There's no
// query function for "is tentacle N exposed right now" — the only way to
// react in time is onTentacleExposed(id, callback), registered before the
// fight starts, which the engine calls the instant that tentacle's state
// flips from hidden to exposed. detonate(id) only actually destroys the
// tentacle while it's exposed. The exit only counts once all five are gone
// — same 'goal-incomplete' honesty principle as World 5's switches.
const WORLD_ID = 'world6';
const TENTACLE_COUNT = 5;

// Unlike every other world's par, this one has a clean closed-form minimum
// rather than a constructed/greedy approximation: nothing about this level
// is a spatial search problem. A tentacle can only ever be destroyed at or
// after its own first exposure tick (destroying it earlier is physically
// impossible — it isn't exposed yet), and every action (wait or move)
// costs exactly one tick either way, so there's no cheaper way to spend
// time than the straight walk. That means the true minimum is exactly:
// however many ticks the last tentacle to open needs, or the walk length,
// whichever is bigger (plus one extra tick to actually step onto the exit
// if the walk would otherwise already be finished before the fight is).
function computeCorePar(level) {
  const { grid, tentacles } = level;
  const cols = grid[0].length;
  const walkLen = cols - 1;
  const lastEdgeTick = tentacles[tentacles.length - 1].firstExposureTick;
  return lastEdgeTick <= walkLen ? walkLen : lastEdgeTick + 1;
}

function generateLevel(seed) {
  const rng = mulberry32(seed);
  const cols = 6 + Math.floor(rng() * 2); // 6..7
  const grid = [new Array(cols).fill('wall'), new Array(cols).fill('floor')];
  const start = { row: 1, col: 0 };
  const goal = { row: 1, col: cols - 1 };

  // Each tentacle stays hidden, then opens for a short window, then closes
  // again for a while before repeating (so a missed window isn't fatal —
  // just costly). Staggered so the five windows never overlap, forcing a
  // separate handler per tentacle rather than one that happens to cover
  // all of them.
  const tentacles = [];
  let cursor = 2 + Math.floor(rng() * 2); // first tentacle opens on tick 2..3
  for (let i = 0; i < TENTACLE_COUNT; i++) {
    const hiddenLen = cursor;
    const exposedLen = 2 + Math.floor(rng() * 2); // 2..3 ticks open
    const cooldown = 4 + Math.floor(rng() * 3); // 4..6 ticks before it repeats
    const period = hiddenLen + exposedLen + cooldown;
    const pattern = new Array(period).fill(false);
    for (let k = hiddenLen; k < hiddenLen + exposedLen; k++) pattern[k] = true;
    tentacles.push({ id: i, pattern, firstExposureTick: hiddenLen });
    cursor = hiddenLen + exposedLen + (3 + Math.floor(rng() * 3));
  }

  const level = { grid, start, goal, tentacles };
  level.parMoves = computeCorePar(level);
  return level;
}

const LEVEL = generateLevel(Progress.getSeed(WORLD_ID));
Progress.setWorldPar(WORLD_ID, LEVEL.parMoves);

const COMMANDS = [
  { id: 'moveRight', label: 'moveRight()', insert: 'moveRight();\n', pattern: /moveRight\s*\(/ },
  { id: 'moveLeft', label: 'moveLeft()', insert: 'moveLeft();\n', pattern: /moveLeft\s*\(/ },
  { id: 'wait', label: 'wait()', insert: 'wait();\n', pattern: /wait\s*\(/ },
  { id: 'onTentacleExposed', label: 'onTentacleExposed(id, fn)', insert: 'onTentacleExposed(0, () => {\n  detonate(0);\n});\n', pattern: /onTentacleExposed\s*\(/ },
  { id: 'detonate', label: 'detonate(id)', insert: 'detonate(0);\n', pattern: /detonate\s*\(/ },
  { id: 'forLoop', label: 'for loop', insert: 'for (let i = 0; i < 20; i++) {\n  \n}\n', pattern: /for\s*\(/ },
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
    const canvas = p.createCanvas(480, 260);
    canvas.parent('level-canvas-holder');
    runner = new GridMazeRunner(p, LEVEL, { tile: 64, viewportW: 480, viewportH: 260, theme: 'core' });
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
    el.textContent = `Par: ${LEVEL.parMoves} ticks (wait() and moves both count) — provably the minimum, not just a working solution. Match it for a star.`;
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
    resultCache = {
      moves,
      bestMoves: updated.bestMoves,
      starred: updated.bestMoves <= LEVEL.parMoves,
      allViaCallback: runner.finalAllViaCallback,
    };
    renderWorldMeta();
    renderNextWorldLink(WORLD_ID);
    checkAchievements();
    checkGameWinAndAnnounce();
  }
  lastStatus = runner.status;

  switch (runner.status) {
    case 'won': {
      const r = resultCache;
      statusEl.textContent = `All five gone. The hall opens — a helicopter is waiting outside. ` +
        `${r.moves} ticks, best ${r.bestMoves}${r.starred ? ' ★' : ''} (par ${LEVEL.parMoves}).`;
      break;
    }
    case 'goal-incomplete': {
      const last = runner.trace[runner.trace.length - 1];
      const remaining = last.tentaclesDestroyed.filter((d) => !d).length;
      statusEl.textContent = `Tick ${last.tick}: reached the hall door, but ${remaining} tentacle${remaining === 1 ? '' : 's'} still armed — it won't open yet.`;
      break;
    }
    case 'blocked': {
      const last = runner.trace[runner.trace.length - 1];
      statusEl.textContent = `Tick ${last.tick}: nothing that way. Edit your code and run again.`;
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
  if (resultCache.allViaCallback) record('eventHandler');
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
  const { trace, success, error, allViaCallback } = simulateCore(LEVEL, code);
  runner.finalAllViaCallback = allViaCallback;
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
  runner.finalAllViaCallback = result.allViaCallback;
  stepping = true;
  document.getElementById('step-controls').style.display = '';
  stepController.start(result);
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('level-hint').textContent =
    `Par is ${LEVEL.parMoves} ticks — proven minimum, not a guess. Five tentacles, each with its own ` +
    `hidden/exposed cycle you can't see coming; register onTentacleExposed(id, fn) for each one before you start waiting.`;

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
