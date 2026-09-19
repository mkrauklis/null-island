// World 1 — The Wreck. Sequential commands only: moveRight(), moveLeft(), jump().
const LEVEL = {
  startCol: 0,
  columns: [
    'ground', 'ground', 'ground', 'gap', 'ground', 'ground', 'ground',
    'gap', 'ground', 'ground', 'ground', 'goal',
  ],
};

const STARTER_CODE = `// Get to the flag. moveRight() walks one step.
// jump() leaps two steps forward, clearing a gap.
moveRight();
moveRight();
`;

let runner;
let editor;
let lastFrameMs;

function sketch(p) {
  p.setup = () => {
    const canvas = p.createCanvas(12 * 48, 320);
    canvas.parent('level-canvas-holder');
    runner = new SideScrollerRunner(p, LEVEL, { groundY: 260 });
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

function renderStatus() {
  const statusEl = document.getElementById('status');
  if (!runner) return;
  statusEl.className = runner.status;
  switch (runner.status) {
    case 'won':
      statusEl.textContent = 'Reached the flag. World 1 clear.';
      break;
    case 'fell':
      statusEl.textContent = 'You fell in a gap. Edit your code and run again.';
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

function runCode() {
  const code = editor.getValue();
  const { trace, success, error } = simulateSideScroller(LEVEL, code);
  runner.loadTrace(trace, success, error);
}

window.addEventListener('DOMContentLoaded', () => {
  editor = CodeMirror.fromTextArea(document.getElementById('code'), {
    mode: 'javascript',
    theme: 'default',
    lineNumbers: true,
    tabSize: 2,
  });
  document.getElementById('run-btn').addEventListener('click', runCode);
  new p5(sketch);
});
