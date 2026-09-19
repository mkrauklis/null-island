// Static metadata for every world in the game. `parMoves` is the true
// minimum move count for that level, computed once via the engine's BFS
// helpers (see DESIGN.md) and pinned here as a plain number so the world
// select screen can show "best / par" without loading each level's game
// code just to compute it.
const WORLDS = [
  {
    id: 'world1',
    title: 'The Wreck',
    concept: 'Sequential commands',
    path: 'levels/world1/index.html',
    built: true,
    parMoves: 6,
  },
  {
    id: 'world2',
    title: 'The Vents',
    concept: 'Loops',
    path: 'levels/world2/index.html',
    built: true,
    parMoves: 15,
  },
  {
    id: 'world3',
    title: 'The Dungeon Halls',
    concept: 'Conditionals',
    path: null,
    built: false,
    parMoves: null,
  },
  {
    id: 'world4',
    title: 'The Foundry',
    concept: 'Functions',
    path: null,
    built: false,
    parMoves: null,
  },
  {
    id: 'world5',
    title: 'The Vault',
    concept: 'Arrays & objects',
    path: null,
    built: false,
    parMoves: null,
  },
  {
    id: 'world6',
    title: 'The Core',
    concept: 'Events',
    path: null,
    built: false,
    parMoves: null,
  },
];
