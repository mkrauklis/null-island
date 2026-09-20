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

**Resolved:** the "reactive dodging" open question turned out not to need a
second execution mode. World 3's octopus chases greedily (shortest path
toward the player's cell, recomputed after every move), which sounds "live"
but is actually a pure function of the player's already-decided move
sequence — so it's fully computable during the same synchronous trace-build
pass as everything else (`simulateGridMazeChase`). `octopusNear()` reads
real state *as of that point in the simulated trace*, same as any other
query function would. The only time this stops working is if a future
world's obstacle depends on something the simulator doesn't control (real
wall-clock time, true randomness) — not the case for anything built so far.
World 6's boss will need to be re-examined against this once designed, but
the model itself no longer looks like the blocker it did.

**Procedural, seeded levels:** every level is generated from
`Progress.getSeed(worldId)` — a random seed picked once and stuck to a
player (localStorage), not re-rolled every reload. `js/engine.js` provides
`mulberry32` (seeded PRNG), `shuffleWithRng`, and `generateMaze` (recursive-
backtracker perfect maze on a wall/floor tile grid — shared by World 2 and
3). Every generator verifies solvability with the matching BFS solver
(`computeMinMoves`/`computeMinMovesGrid`/`computeMinMovesGridChase`) before
accepting a layout, regenerating or falling back if it comes up `Infinity`.
Because par is no longer a fixed number, it's computed at load time and
cached via `Progress.setWorldPar` so World Select can show it without
re-running that world's generator.

**Gotcha worth remembering:** a perfect maze (`generateMaze`) has exactly
one route between any two cells — no loops, so nothing to circle around. An
enemy that always moves *at the player's speed* toward the player's exact
position can therefore corner them with zero possible escape if it starts
anywhere near the direct route; this isn't a rare edge case, it's most
placements. Two independent fixes were needed together: the chaser moves at
*half* the player's speed (so a direct run can always outrun it), and it's
placed in a dead-end branch *off* the solution path rather than on it (so it
has to travel to intercept, not just walk straight at the player). Either
fix alone still produced unsolvable layouts in testing.

**Syntax errors get located, not just reported:** `findSyntaxError` (engine.js)
parses the code with Acorn (CDN) before ever running it, since a thrown
`SyntaxError` from `new Function(...)` doesn't reliably carry a usable line
number across browsers. The offending line gets a background tint and the
token an underline in CodeMirror, cleared on the next edit.

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

**Next-world CTA:** `renderNextWorldLink` (engine.js) shows a button on a
win pointing at the next built world in `worlds-registry.js`, or back to
World Select if the next one isn't built yet. Assumes the
`levels/<id>/index.html` folder-naming convention.

**Achievements (`js/achievements.js`):** a flat catalog of badges, stored
globally and permanently in localStorage (`Progress.unlockAchievement`) —
they don't reset per world, they're bragging rights across the whole save.
Detection lives in each world's own script (it has the code text and the
winning trace right there), checked once per win: `jumper`/`looper`/
`patient`/`backtracker` scan the stripped code for the relevant syntax,
`compass` checks the trace used all four directions, `perfectionist` checks
the star, `escapee` (checked cross-world, from `worlds.html`) fires once
every *built* world is cleared. Several of these are deliberately not
achievable by the intended/optimal solution (e.g. World 2 never needs
`moveLeft`/`moveDown` to clear it) — they're side quests for players who
go looking, not a second scoring track. `worlds.html` renders the full
catalog, showing `???` for anything not yet earned rather than spelling
out what it takes.

## World progression

### World 1 — The Wreck (side-scroller, tutorial) — built
**Teaches:** sequential commands (`moveRight()`, `jump()`).
Low stakes, no enemies. Getting oriented: code = control. Two gaps to clear
by jumping prove that order and precision matter. Real gravity-driven jump
arc and fall animation, a scrolling camera, and a moody parallax sci-fi-wreck
background — see the commit history for the physics/graphics pass. Course
length and gap placement are now seeded-random per player (gaps spaced >=3
columns apart by construction, so a jump can always clear exactly one).

### World 2 — The Vents (top-down maze) — built
**Teaches:** loops.
A real generated maze now (`generateMaze`, seeded per player), not just a
straight shaft — long enough that writing out every individual move by hand
is miserable, and now with actual branches/dead-ends, so `for`/`while` loops
stop being abstract and start being obviously necessary. The patrol enemy
(visually a small drone) patrols a fixed back-and-forth path along a segment
of the solution corridor, deterministic per tick (stays inside the
simulate-then-replay model, no live execution needed). The generator tries
several phase/window choices and prefers one where the *naive* straight-loop
solution actually walks into it — clearing the level requires either
reordering moves or spending a `wait()` to change timing, which is the
point: the puzzle isn't solved by "loops exist," it's solved by noticing
*when* the loop runs matters too.

**Lesson learned from playtesting:** the math checks out (any odd number of
`wait()`s at the very start clears it — one is enough), but the game gave
zero feedback about *where* an attempt failed, so it read as unsolvable
rather than as a puzzle. Fixed by (1) naming the exact tick and grid
position in the fail message instead of a generic "caught you", and (2)
stating the actual mechanic in the level text — "the Scanner takes one
step every time you do, including `wait()`" — since that's the one fact
the puzzle can't be solved without, and it wasn't written down anywhere.
General principle for future worlds: a puzzle being *solvable* isn't the
same as it being *debuggable* — always show the player enough state to
know why an attempt failed, not just that it did.

### World 3 — The Dungeon Halls — MVP built, full vision not yet
**Teaches:** conditionals.
What's actually built: a single generated maze (`simulateGridMazeChase`)
with a small, cartoonish octopus that greedily chases the player — one step
toward your current cell after every move you make, at half your speed (see
the maze-topology gotcha above for why). `octopusNear()` exposes whether
it's within 2 tiles right now, which is the hook for conditionals:
`if (octopusNear()) { ... }` lets the player react to state instead of
committing to a fixed script.

**Not built yet — original fuller vision, still the intent:** the tech
giving way to something organic — a **mutated tentacle-flesh creature**
tangled through the server racks and stone — three areas, each
**progressively bigger** than the last, each requiring a hidden key found
before the door to the next area unlocks (`if (hasKey) unlockDoor()`), with
the creature cornering the player at least once in the biggest area for the
game's first real scare. The current MVP proves the chase mechanic works;
the key-hunt/multi-area structure is the next pass on this world, not a
replacement for it.

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

## The player character

The player is a capuchin, customizable (color + one cosmetic: party hat, top
hat, or angel wings) from a panel on the splash screen (`index.html`).
`Progress.getCharacter()`/`setCharacter()` store the choice in localStorage,
deliberately outside `resetAll()` — it's a cosmetic preference, not
progress, so "reset progress" doesn't silently undo it.

Drawn by one shared function, `drawCapuchin(p, tile, opts)` (engine.js),
called from three places: the splash-screen preview, `SideScrollerRunner`,
and `GridMazeRunner`. Pick a color once and it's the same monkey everywhere
in the game — there's no per-world character art to keep in sync.

## Repo conventions

- `index.html` — splash screen (title, premise, one link into `worlds.html`).
- `worlds.html` — world select / settings: every world's lock state, best
  score, par, and star; also where "reset progress" lives.
- `levels/worldN/` — one folder per world, `index.html` + level-specific JS.
- `js/engine.js` — shared engine: level simulation (side-scroller and grid
  maze), par/BFS helpers, trace playback, rendering. Reused across worlds;
  world-specific level data stays in each world's own folder.
- `js/progress.js` — localStorage save data: clears, best moves, per-world
  seed and generated par, unlocked command-palette snippets, achievements.
- `js/worlds-registry.js` — static ordered metadata for all six worlds. Its
  `parMoves` is only a placeholder shown before a player has ever generated
  that world's real (seeded) layout.
- `js/achievements.js` — the badge catalog, plus the one cross-world check
  (`escapee`). Per-world detection lives in each world's own script.
- `css/style.css` — shared theme.
- No build step. Dependencies (all CDN): p5.js, CodeMirror (theme:
  `dracula`), and Acorn (syntax-error line/column detection only).
