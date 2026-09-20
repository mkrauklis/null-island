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

### World 4 — The Foundry — built
**Teaches:** functions.
A catwalk (`GridMazeRunner`, new `foundry` theme — rust-metal palette, no
darkness pass) with three gaps in the floor plating, each needing the exact
same four-move detour (up, over, over, down). Nothing enforces writing an
actual `function` — same "teaches by fit, not force" choice already made for
World 2's loops — but retyping the same four lines three times is annoying
enough that the hint text and a starter-code comment both point at defining
`passGap()` once and calling it three times instead. The `reuser` achievement
(`js/achievements.js`) rewards it directly: a declared function called at
least twice beyond its own declaration.

No new engine mechanic was needed — `new Function(...)` already runs the
player's code as a real JS function body, so nested `function` declarations
and calls just work with the existing `simulateGridMaze`/`computeMinMovesGrid`
from World 2. The layout itself isn't a generated maze (`generateMaze`) like
World 2/3 — it's constructed directly (a 2-row grid: a floor row with the
three gaps, a "detour lane" row that's only floor immediately around each
gap), so it's connected by construction and doesn't need a BFS solvability
check, only a par count. One side effect worth knowing: closely-spaced gaps'
detour-lane clusters can merge into one longer upper corridor, letting the
BFS-computed par undercut the "three separate identical detours" solution —
not a bug, just means the naive intended solution isn't always the optimal
one, same as it isn't in World 2 or 3.

**The squid — Red Light, Green Light.** A fixed overseer, drawn in the HUD
above the catwalk (not part of the level grid — see `_drawSquid`), with one
eye that cycles on a repeating tick pattern (`level.squid.pattern`, a
boolean array indexed by `tick % pattern.length`, same trick as the
scanner's `path`). Grey and "looking around" = safe to move. Red and
watching = any move (not `wait()`) anywhere gets you caught — it's global,
not spatial, deliberately: there's no dodging by position, only by timing,
same as the real game. A persistent, faint sight-cone from the eye to the
floor illustrates that "hitbox" even while safe (floods solid red while
watching), so it never has to be inferred.

Implementation stayed inside the existing simulate-then-replay contract:
`squidWatchAt(squid, tick)` is a pure function of the tick number, so
`simulateGridMaze`'s `step()` can reject a non-wait move outright (a
`'caught'` trace event, same shape the scanner already produces), and
`computeMinMovesGrid`'s BFS can treat "moving on a watched tick" as a
disallowed transition when searching for par (state key extended to tick
mod `lcm(scannerPeriod, squidPeriod)`, so a level with both hazards someday
would still search correctly, though no built world uses both at once yet).
No new execution model, no live reaction — same reasoning as every other
enemy in this game.

**Foundry is "nearly pitch black."** Reused the dungeon's darkness pass
(`_drawDarkness`, `destination-out` radial gradients on an offscreen
buffer) rather than writing a second one — foundry just has no torches at
all, only a tight ring around the player, and a darker base fill than the
dungeon's. The squid's glow and sight-cone are drawn in the HUD layer,
*after* the darkness mask is applied to the level below, so they stay
visible even when the corridor itself is barely legible — a deliberate
"you can't see the room, but you can always see it watching you" effect.

**Line pointer.** During playback, the CodeMirror line whose call produced
the step currently animating gets a highlight (`cm-current-line`), cleared
the moment playback stops. Every trace entry across all three simulate
functions now carries a `.line` — captured via `getCallerLine()`, which
reads the call site straight out of `new Error().stack` at a fixed stack
depth (calibrated empirically against V8, since every api function is
called `player code → arrow wrapper → step() → getCallerLine()`, always the
same shape). This is a V8-specific trick, not a spec guarantee; on an
engine where the stack shape doesn't match, `getCallerLine()` just returns
`null` and playback quietly skips the highlight rather than breaking
anything. `syncCodeHighlight(editor, runner)` is shared by all five worlds'
render loops — one function, not five copies.

**Extended to show `for`/`while`/`if` too, not just the leaf call.** A
`for(...)` or `if(...)` header never calls any injected api function, so
there's no stack-trace hook for it the way there is for `moveRight()` —
`getCallerLine()` only ever sees the one line with the actual call. Instead,
`computeControlLines(code)` parses the code with Acorn (already loaded for
syntax-error detection) into an AST, walks it generically (recurse into
every object/array property, not a hardcoded set of node shapes — works
without needing acorn-walk), and records every `For*`/`While*`/`IfStatement`
node's header line plus its body's line range. `syncCodeHighlight` then
marks the leaf line bright (`cm-current-line`, unchanged) and every
enclosing header line dim (`cm-current-line-outer`) — so a loop or
conditional stays lit for as long as execution is anywhere inside its body,
not just one instant, which is what actually reads as "this loop is
running" across several iterations rather than a single flash. Cached by
source text so a 60fps render loop isn't re-parsing on every frame; an
unparsable mid-edit code string just yields no outer-highlight, not a crash.

**Step mode — pause for a click, see init/test/update as they happen.**
The dim "enclosing line" trick above shows *that* a for-loop is running,
but not the individual init/test/update moments a real for-loop actually
goes through. Direct request, illustrated with `for(let i=0;i<2;i++){
moveRight(); }`, expecting to see exactly: `let i=0`, `i<2`, `moveRight()`,
`i++`, `i<2`, `moveRight()`, `i++`, `i<2` — eight distinct, clickable
moments.

*Instrumentation (`instrumentForLoops`, engine.js).* A for-loop header
never calls any injected api function, so there's no stack-trace hook for
its init/test/update individually the way there is for a move. Fixed by
inserting `__mark(line)` calls into the header ONLY, via small in-place
Acorn-offset insertions, never touching the body:
- `__mark(initLine); ` is prepended immediately before the `for` keyword.
- `test` is wrapped in place as `(__mark(testLine), (test))` — the comma
  operator runs `__mark` for its side effect, then evaluates to `test`'s
  own value, so the loop's real semantics are untouched.
- `update` is wrapped the same way.

The body is never sliced, moved, or reflowed. That was a real bug caught
during testing: an earlier version rewrote the whole
`for(init;test;update){body}` into `{ init; while(true){ test; body;
update; } }`, using sliced original text for each piece — correct-looking,
but it silently reflowed the body onto different lines than the original
source, which broke `getCallerLine()` for every move/wait call inside a
loop (it reports lines against whatever code actually ran, so a relocated
body means wrong reported lines). Keeping every edit a small same-line
insertion at a precise offset, and never moving the body at all, avoids
that class of bug entirely — and as a side effect, works at any nesting
depth for free, since no two for-loops' header edits can ever overlap,
nested or not.

`__mark` doesn't touch the movement trace or its `tick` numbering (which
squid/scanner timing depends on) — it records a *separate* `phaseEvents`
array, each entry noting `beforeMoveIndex` = `trace.length` at the instant
it fired. `buildStepSequence(trace, phaseEvents)` merges both into one
ordered list of "moments" by walking movement indices and flushing any
phase events due before each one. All four simulate functions
(`simulateSideScroller`/`simulateGridMaze`/`simulateGridMazeChase`/
`simulateVault`) instrument the code, expose `__mark`, and return
`phaseEvents` alongside the usual `trace`/`success`/`error`.

*Playback (`createStepController`, engine.js).* A "Step" button next to
Run on every world runs the same syntax-check + simulate pipeline, then
hands the result to a step controller instead of auto-playing it — a
"Next ▶" click advances exactly one merged step. `runner.stepModeActive`
(checked by `update()` and `syncCodeHighlight`) tells the rest of the
engine to stop auto-advancing on a timer and stop deriving the highlighted
line from `trace`/`stepIndex` the normal way. A phase step only updates
`stepModeLine` (no trace index exists for it); a move step also updates
`lastMoveTraceIndex`. Both then set `runner.trace = fullTrace.slice(0,
lastMoveTraceIndex + 1)` and `runner.stepIndex = lastMoveTraceIndex - 1` —
truncating the runner's own trace view to exactly what's happened *so
far*, rather than the negative stepIndex that would otherwise be needed to
show "nothing has moved yet," which isn't possible: `playerPos()` always
reads `trace[stepIndex]` unconditionally (even though its value is only
mathematically relevant mid-interpolation), so a negative index would
throw. Truncating also means switch/octopus/scanner rendering during step
mode correctly only reflects moves that have actually happened, for free.

When the sequence ends, `finish()` restores the untruncated trace and
forces one more auto-play tick (`stepElapsed = 9999; playing = true`)
rather than duplicating the win/status-computation branch — the very next
`update()` call completes exactly the way a full Run would, so
`recordClear`/achievements/the win check all fire identically regardless
of whether the player watched it happen instantly or one click at a time.
Verified end-to-end: stepped a real par-matching solution through to a win
and confirmed `Progress.recordClear` fired with the right move count.

### World 5 — The Vault — built
**Teaches:** arrays/objects.
A bigger generated maze (`GridMazeRunner`, new `vault` theme — steel-blue,
panel-grid backdrop) scattered with 4 switch terminals. Stepping onto a
terminal's tile lights it automatically, same physicality as the goal
itself; reaching the goal only counts as `'goal'` once every terminal is
lit, otherwise it's `'goal-incomplete'` (states exactly how many are still
dark) — same honesty principle as World 3's `'goal-unearned'`.

`switches()` is a read-only query (doesn't consume a tick, same contract as
`octopusNear()`) returning a snapshot array of `{row, col, on}` objects —
the array-of-objects hook. Nothing forces the player to actually loop over
it (same "teaches by fit, not force" choice as every prior world's
mechanic), but checking four separate booleans by hand is annoying enough
that the hint and starter comment both model `switches().filter(s =>
!s.on)`. The `lister` achievement rewards actually doing that: `switches()`
referenced alongside a loop or array method, not just called once.

`simulateVault` is a fourth engine-level simulate function (`js/engine.js`,
alongside the side-scroller, scanner/squid grid-maze, and chase grid-maze) —
consistent with how each world's win-condition semantics has gotten its own
simulate function rather than overloading a shared one. Switch placement
uses the same generated-maze "room cell" grid (`generateMaze`) as World 2/3,
picked with a minimum spacing heuristic so they don't cluster.

**Par is a constructed solution, not a proven minimum**, same tradeoff as
World 3's `findGreedySolution` and for the same reason: exact TSP over
"visit N waypoints in whatever order, then reach the goal" has no cheap
exact search once N gets past a couple of points. `greedyVaultPar`
(`world5.js`) builds a route via nearest-unvisited-switch-by-BFS-distance
each step, then to the goal, and reports its length honestly labeled as
such in both the world-select par line and the in-level hint.

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

Customizable from a panel on the splash screen (`index.html`): species
("skin" — capuchin, gorilla, manatee, proboscis monkey, or spider monkey),
a flat fur color, and one cosmetic. Both colors and cosmetics can be locked
behind a `requiresWorld` (same shape for both — `COLORS`/`ACCESSORIES` in
`index.html` — checked via `Progress.getWorld(<id>).cleared` directly, one
source of truth, no separate unlock flag) — a color texture (not just a
flat fill) was tried once (`clouds`, a decorative overlay pass) and then
removed on direct request; `drawCharacter`'s per-skin dispatch stayed a
clean fit for flat colors only after that.
`Progress.getCharacter()`/`setCharacter()` store the choice in localStorage,
deliberately outside `resetAll()` — it's a cosmetic preference, not
progress, so "reset progress" doesn't silently undo it. Unlockable
cosmetics check `Progress.getWorld(<id>).cleared` directly rather than
their own separate unlock flag — one source of truth.

Drawn by one shared function, `drawCharacter(p, tile, opts)` (engine.js),
called from three places: the splash-screen preview, `SideScrollerRunner`,
and `GridMazeRunner`. Pick a look once and it's the same everywhere in the
game — no per-world character art to keep in sync. Each skin is its own
small drawing function (`drawGorillaBody`, etc.) sharing the same color/
accessory system; wings draw *before* the body (so they sit behind it) while
hats draw after (on top of an already-drawn head) — the two accessory
categories need opposite z-order and there was no getting around that with
a single draw pass.

## Wins, rank, and the re-lock loop

A **win** means every world (all 6 — currently a no-op until World 6 ships,
since it can never be true with only 3 built) is cleared at once.
`Progress.checkForWin(WORLDS)`, called after every clear from each world's
own script, checks that; when it's true it increments a stored win count
and wipes `PROGRESS_KEY` entirely — every world's `cleared`/`bestMoves`/
`parMoves` resets, re-locking the whole game back to World 1. Seeds,
achievements, unlocked command-palette snippets, and character
customization are untouched — only the lock/clear state resets, so a
completed run becomes a fresh one rather than a wiped save. This is
deliberately a *different*, softer reset than the "Reset progress" button
on World Select, which still wipes everything including the win count.

`js/ranks.js` maps win count directly to a title — Beginner (0) → Learner
(3) → Technician (5) → Coded (7) → Hacked (10) → Webbed (15) → Networked
(25) → Interwebbed (50) — recomputed from `Progress.getWins()` every time
it's shown rather than stored separately, so it can't drift out of sync.
Each rank is a multiple of full playthroughs, not incremental score — the
tiers are deliberately far apart since a "win" is the whole game, not a
single level. Each rank also carries a `color` used for both the badge text
and its border on World Select.

The top three ranks (Webbed, Networked, Interwebbed) additionally get a
small particle effect around the badge — rising, color-matched sparks on a
`<canvas>` overlay (`js/rank-particles.js`), pure vanilla canvas rather than
p5 since `worlds.html` doesn't otherwise load it and this is a live
decorative loop, not a simulated/replayed trace like everything else in the
engine. `updateRankParticles(rank)` runs every time the badge re-renders and
is cheap to call even when nothing changes — it only tears down and
restarts the animation when the rank *title* actually changes, and no-ops
back to hidden below Webbed.

World Select also shows a full ranks board (`renderRankBoard`, below the
world grid) — every tier from `RANKS`, unlocked ones in their real color
with a border, locked ones dimmed via opacity, and the player's current
tier labeled "You are here." Unlike the achievement grid, locked rank
titles aren't hidden behind "???" — a rank name and its win requirement
aren't a mystery to preserve, just a target not yet reached.

## World 3 lighting

Dungeon-theme grid mazes render mostly dark, lit only by torches (placed by
`_torchCells()`, the same deterministic rule `_drawGrid` already used to draw
them) plus a small radius around the player for playability — a pure
constructive-visibility choice, not spoken about in the design brief
originally, added because the dungeon needed the torches to actually mean
something. Implemented as an offscreen buffer filled opaque near-black, then
punched through with `destination-out` radial gradients at each light
source (`GridMazeRunner._drawDarkness`) — soft falloff instead of a hard
circle. World 2 (theme `'vents'`) is unaffected; the darkness pass no-ops
for any theme but `'dungeon'`.

## Save slots (multiple games)

Everything `Progress` reads/writes — worlds progress, seeds, snippets,
achievements, wins, character — is scoped to a "slot" (one save file), so
more than one person can play on the same browser without overwriting each
other. The six data keys that used to be the whole story are now just
suffixes; `Progress._key(suffix)` prefixes whichever slot is active
(`` `null-island:slot:${activeId}:${suffix}` ``). Slot bookkeeping itself —
the slot list and which one is active — deliberately lives *outside* that
scoping, under its own un-prefixed keys, since it has to be readable before
you know which slot you're in.

This was a refactor entirely inside `progress.js`: every other file (all
five level scripts, `worlds.html`, `index.html`) already only ever touched
save data through `Progress`'s methods, never `localStorage` directly, so
none of them needed to change at all — confirmed by grepping the whole repo
for `localStorage` before starting and finding it nowhere outside this file.

New methods: `listSlots`/`getActiveSlotId`/`getActiveSlot`/`createSlot`/
`switchActiveSlot`/`renameSlot`/`deleteSlot`, plus `getSlotSummary(id)` for
reading a slot's wins/cleared-count *without* switching into it first (for
a save picker that shows every slot's progress at once). `deleteSlot` never
leaves zero slots — deleting the last one immediately creates a fresh
"Slot 1" in its place, so every other method always has somewhere valid to
read/write.

**Migration:** the first time `_ensureSlots()` runs and finds no slot index
yet, it checks whether real data exists under the old un-prefixed keys
(pre-dating this feature) and, if so, copies it into a new "Slot 1" rather
than orphaning it — copies, doesn't delete, so the legacy keys are harmless
leftovers rather than a silent data-loss risk. Verified by seeding legacy
keys by hand and confirming every field (progress, wins, character,
achievements) survives into the new slot untouched.

UI lives on the splash screen (`index.html`, "Save file" panel: a `<select>`
of slots plus New/Rename/Delete) and a one-line indicator + "switch save"
link on `worlds.html`. Rename/delete use plain `prompt()`/`confirm()` —
no custom modal, consistent with how "Reset progress" already works.

## Enemy guide

`enemies.html`, linked from World Select. One card per hazard (Scanner,
Octopus, Squid — the three built so far), each with a small looping demo
animation. Deliberately reuses the real rendering, not a redrawn copy: each
card builds a tiny fake level (`{grid, start, goal, scanner/octopi/squid}`)
and a real `GridMazeRunner`, so `runner.draw()` calls the exact same
`_drawScanner`/`_drawOctopus`/`_drawSquid` the actual worlds use — this
guide can never visually drift from what a world actually shows, since
there's nothing to keep in sync by hand. The demo trace is just `wait()`
repeated (player holds still, hazard still animates from `tick`), reloaded
every time it finishes so it loops forever.

## Repo conventions

- `index.html` — splash screen (title, premise, one link into `worlds.html`).
- `worlds.html` — world select / settings: every world's lock state, best
  score, par, and star; also where "reset progress" lives.
- `enemies.html` — enemy guide, one looping demo card per hazard.
- `levels/worldN/` — one folder per world, `index.html` + level-specific JS.
- `js/engine.js` — shared engine: level simulation (side-scroller and grid
  maze), par/BFS helpers, trace playback, rendering. Reused across worlds;
  world-specific level data stays in each world's own folder.
- `js/progress.js` — localStorage save data, scoped to a save slot: clears,
  best moves, per-world seed and generated par, unlocked command-palette
  snippets, achievements, wins, character. Also owns slot management itself
  (create/switch/rename/delete) — see "Save slots" above.
- `js/worlds-registry.js` — static ordered metadata for all six worlds. Its
  `parMoves` is only a placeholder shown before a player has ever generated
  that world's real (seeded) layout.
- `js/achievements.js` — the badge catalog, plus the one cross-world check
  (`escapee`). Per-world detection lives in each world's own script.
- `js/ranks.js` — win-count-to-title/color mapping (`RANKS`, `computeRank`).
- `js/rank-particles.js` — the canvas spark effect for the top three ranks.
- `css/style.css` — shared theme.
- No build step. Dependencies (all CDN): p5.js, CodeMirror (theme:
  `dracula`), and Acorn (syntax-error line/column detection only).
