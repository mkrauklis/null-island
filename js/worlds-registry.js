// Static metadata for every world in the game. Levels are now procedurally
// generated per player (see Progress.getSeed/setWorldPar), so `parMoves`
// here is only a rough placeholder shown before a player has ever opened
// that world — once they have, worlds.html prefers the real par cached in
// Progress for their actual generated layout.
const WORLDS = [
  {
    id: 'world1',
    title: 'The Wreck',
    concept: 'Sequential commands',
    path: 'levels/world1/index.html',
    built: true,
    parMoves: 7,
  },
  {
    id: 'world2',
    title: 'The Vents',
    concept: 'Loops',
    path: 'levels/world2/index.html',
    built: true,
    parMoves: 20,
  },
  {
    id: 'world3',
    title: 'The Dungeon Halls',
    concept: 'Conditionals',
    path: 'levels/world3/index.html',
    built: true,
    parMoves: 12,
  },
  {
    id: 'world4',
    title: 'The Foundry',
    concept: 'Functions',
    path: 'levels/world4/index.html',
    built: true,
    parMoves: 18,
  },
  {
    id: 'world5',
    title: 'The Vault',
    concept: 'Arrays & objects',
    path: 'levels/world5/index.html',
    built: true,
    parMoves: 26,
  },
  {
    id: 'world6',
    title: 'The Core',
    concept: 'Events',
    path: 'levels/world6/index.html',
    built: true,
    parMoves: 22,
  },
];
