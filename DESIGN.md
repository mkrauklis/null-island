# Null Island — Design Document

## Premise

You crash-land on Null Island — an island that's secretly a buried facility of
half-abandoned technology. There's no signal, no manual, and the only way out
is down: into a dungeon built from old machines. Every door, bridge, and gate
down here runs on code, and the only tool you have is a terminal. You escape
by learning to program the island's own systems against it.

It should feel a little scary — you're alone, the tech doesn't fully work
right anymore, and something in the deeper levels is not just broken
machinery.

## Core mechanic

Every level is a real JavaScript coding puzzle. The player writes actual code
in an in-page editor; there is no blockly/drag-and-drop layer standing in for
"real" syntax. Running the code drives a character through a 2D p5.js world.
Each world introduces one programming concept by making the *previous*
approach painfully tedious — the concept should feel necessary, not assigned.

**Execution model (current, for sequential/loop/conditional worlds):** the
player's code runs once, synchronously, against a simulated copy of the level
state, producing a trace of moves. The engine then plays that trace back as
an animation. This keeps early worlds simple (no async/await required to
write a solution) while still supporting real loops and conditionals, since
those are evaluated at trace-build time against known level state.

**Open question for later worlds:** World 3 (reactive dodging) and World 6
(the boss) want the player reacting to *live, possibly nondeterministic*
game state (e.g. a monster whose timing isn't fully fixed), which a
build-then-replay trace can't represent. When we get there we'll likely need
a second execution mode — running the player's function as a live
interpreted loop (or an async function awaiting engine-driven ticks) — rather
than trying to force everything through the simple trace model. Not solved
yet; flagging so it doesn't get glossed over.

## Stack

- **p5.js** (CDN, no build step) for rendering and the game loop.
- **CodeMirror 5** (CDN) for the in-page code editor.
- Plain HTML/CSS/JS per level, same zero-dependency discipline as
  michaelkrauklis.com's lab tools — no bundler, no framework, runs by
  opening a file (or a trivial static server) directly in a browser.

## Progress, scoring, and the command palette

**Progress (`js/progress.js`):** localStorage-backed, no accounts. Per world,
tracks `cleared` and `bestMoves` (the lowest move count that has ever
cleared it). A world is unlocked if it's World 1, or the world before it is
cleared — `js/worlds-registry.js` holds the ordered list every page checks
this against, plus each built world's `parMoves`.

**Par and stars:** `parMoves` is the *true* minimum number of actions to
clear a level, computed by BFS over the level's own simulation rules
(`computeMinMoves` for side-scrollers, `computeMinMovesGrid` — a
time-expanded BFS keyed on `(row, col, tick mod scanner-period)` — for grid
mazes with a patrolling enemy). It's computed, never hand-guessed: a level's
"obvious" solution is often not the cheapest one (e.g. World 1's jump()
isn't restricted to only work over an actual gap, so the true par turned out
to be "just jump the whole way," not the walk/jump/walk solution the hint
text suggests). A clear earns a star when `bestMoves <= parMoves`.
`worlds-registry.js` pins each built world's par as a plain number so the
world-select screen can show it without loading that world's game code.

**Command palette:** each level lists its available commands next to the
editor. A command starts as inert text; the first time the player actually
types it in their own code (checked on every CodeMirror change event,
against the code with comments stripped — otherwise a command mentioned in
the level's own starter-comment unlocks itself for free) it turns into a
button that inserts that snippet at the cursor. Unlocked commands are stored
globally (`Progress.unlockSnippet`), not per-world, so a command learned in
one world stays unlocked in the next — the palette is there to save typing
once you've proven you know the syntax, not to gate it.

## World progression

### World 1 — The Wreck (side-scroller, tutorial) — built
**Teaches:** sequential commands (`moveRight()`, `jump()`).
Low stakes, no enemies. Getting oriented: code = control. Two gaps to clear
by jumping prove that order and precision matter. Real gravity-driven jump
arc and fall animation, a scrolling camera, and a moody parallax sci-fi-wreck
background — see the commit history for the physics/graphics pass.

### World 2 — The Vents (top-down maze) — built
**Teaches:** loops.
An L-shaped vent shaft: 9 cells right, then 5 up. The maze is long enough
that writing out every individual move by hand is miserable — `for`/`while`
loops stop being abstract and start being obviously necessary. First enemy:
a "Scanner" that patrols a fixed back-and-forth path along the floor,
deterministic per tick (so it stays inside the simulate-then-replay model,
no live execution needed). Its phase is tuned so the *naive* straight-loop
solution actually walks into it — clearing the level requires either
reordering moves or spending a `wait()` to change timing, which is the
point: the puzzle isn't solved by "loops exist," it's solved by noticing
*when* the loop runs matters too.

### World 3 — The Dungeon Halls (mixed side-scroller/maze, 3 areas) — not built
**Teaches:** conditionals.
The tech gives way to something organic — a **mutated tentacle-flesh
creature** tangled through the server racks and stone, actively hunting you.
Three areas, each **progressively bigger** than the last. In each area you
must find a hidden key before you can unlock the door to the next area.
Conditionals have a real reason to exist here: `if (hasKey) unlockDoor()`,
`if (tentacleNear()) hide()`, checking state before acting rather than
executing a fixed script. Area 3 (the biggest) is where the creature should
corner you at least once before you find the last key — the game's first
real scare.

### World 4 — The Foundry (mixed) — not built
**Teaches:** functions.
Puzzles are now multi-step enough that inlining every move is unmanageable —
the player starts writing their own named functions bundling move/jump/check
patterns.

### World 5 — The Vault (top-down maze, harder) — not built
**Teaches:** arrays/objects.
Multiple switches/terminals manipulated by looping over a list rather than
hardcoding each one individually.

### World 6 — The Core (boss, everything combined) — not built
**Teaches:** events/callbacks.
The source of the island's corruption: a **mutated octopus**, five tentacles,
each with a bomb strapped to it. The player must register handlers/trigger
logic to hit **5 buttons**, one per tentacle, blowing each tentacle in turn —
ideally each button only works while its tentacle is exposed/vulnerable, so
the player is reacting to an event (`onTentacleExposed(id, () => detonate(id))`)
rather than running a fixed script. All five down opens the hall to the
finish, where a **helicopter is waiting outside** — the ending.

## Repo conventions

- `index.html` — splash screen (title, premise, one link into `worlds.html`).
- `worlds.html` — world select / settings: every world's lock state, best
  score, par, and star; also where "reset progress" lives.
- `levels/worldN/` — one folder per world, `index.html` + level-specific JS.
- `js/engine.js` — shared engine: level simulation (side-scroller and grid
  maze), par/BFS helpers, trace playback, rendering. Reused across worlds;
  world-specific level data stays in each world's own folder.
- `js/progress.js` — localStorage save data (clears, best moves, unlocked
  command-palette snippets).
- `js/worlds-registry.js` — static ordered metadata for all six worlds,
  including each built world's `parMoves`.
- `css/style.css` — shared theme.
- No build step. No dependencies beyond p5.js and CodeMirror (theme:
  `dracula`), both loaded from CDN.
