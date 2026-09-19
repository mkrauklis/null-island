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

## World progression

### World 1 — The Wreck (side-scroller, tutorial)
**Teaches:** sequential commands (`moveRight()`, `jump()`).
Low stakes, no enemies. Getting oriented: code = control. Two gaps to clear
by jumping prove that order and precision matter.

### World 2 — The Vents (top-down maze)
**Teaches:** loops.
The maze is long enough that writing out every individual move by hand is
miserable — `for`/`while` loops stop being abstract and start being
obviously necessary. First enemy: a slow patrol "Scanner" dodged by timing
a loop.

### World 3 — The Dungeon Halls (mixed side-scroller/maze, 3 areas)
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

### World 4 — The Foundry (mixed)
**Teaches:** functions.
Puzzles are now multi-step enough that inlining every move is unmanageable —
the player starts writing their own named functions bundling move/jump/check
patterns.

### World 5 — The Vault (top-down maze, harder)
**Teaches:** arrays/objects.
Multiple switches/terminals manipulated by looping over a list rather than
hardcoding each one individually.

### World 6 — The Core (boss, everything combined)
**Teaches:** events/callbacks.
The source of the island's corruption: a **mutated octopus**, five tentacles,
each with a bomb strapped to it. The player must register handlers/trigger
logic to hit **5 buttons**, one per tentacle, blowing each tentacle in turn —
ideally each button only works while its tentacle is exposed/vulnerable, so
the player is reacting to an event (`onTentacleExposed(id, () => detonate(id))`)
rather than running a fixed script. All five down opens the hall to the
finish, where a **helicopter is waiting outside** — the ending.

## Repo conventions

- `index.html` — landing page / premise / start.
- `levels/worldN/` — one folder per world, `index.html` + level-specific JS.
- `js/engine.js` — shared engine: level simulation, trace playback, rendering
  helpers. Reused across worlds; world-specific level data stays in each
  world's own folder.
- `css/style.css` — shared theme.
- No build step. No dependencies beyond p5.js and CodeMirror, both loaded
  from CDN.
