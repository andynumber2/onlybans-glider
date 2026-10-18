// Replays a recorded run (run.mjs --record FILE) in a fresh game the way the
// leaderboard server does: no userscript, no UI, each logged action applied
// through the game's own dispatcher at its logged tick, without the UI
// argument (the server only gets [tick, action]). Reports the first action
// where the replay's state (RNG, all-time bans) differs from the recording,
// and how far apart the two runs end.
//
// Usage: node scripts/sim/replay.mjs FILE [--seed N] [--bundle index-X.js]
//   --seed: Math.random seed for the replay (default: recording's seed + 1000,
//           since the server's cosmetic randomness won't match the browser's)
// A recording made with run.mjs --save starts the replay from the same save.
import { readFile } from 'node:fs/promises';
import { createSim } from './harness.mjs';

const file = process.argv[2];
const seedAt = process.argv.indexOf('--seed');
const rec = JSON.parse(await readFile(file, 'utf8'));
const seed = seedAt > 0 ? Number(process.argv[seedAt + 1]) : rec.seed + 1000;
const bundleAt = process.argv.indexOf('--bundle');
const bundle = bundleAt > 0 ? process.argv[bundleAt + 1] : null;

const save = rec.save ? (await readFile(rec.save, 'utf8')).trim() : null;
const sim = await createSim({ seed, hookActions: true, bundle, save });
const G = sim.G;
// The game's own one-tick step (r.T++ and everything a tick does). The fake
// clock is never advanced, so the game's frame loop never runs; ticks happen
// only here, exactly where the log says.
const step = sim.logic.logic;

function runTo(T) {
  while (G.T < T) step();
}

const describe = (i) => {
  const r = rec.actions[i];
  return r ? { index: i, tick: r.T, action: r.a } : null;
};

let firstDiff = null;
let overshoots = 0;
const results = {}; // action code -> [applied, rejected]
for (let i = 0; i < rec.actions.length; i++) {
  const r = rec.actions[i];
  runTo(r.T);
  if (G.T > r.T) overshoots++;
  if (!firstDiff && (G.s.rng !== r.rng || G.s.bansAllTime !== r.all)) {
    firstDiff = {
      before: describe(i), previous: describe(i - 1), previous2: describe(i - 2),
      replay: { T: G.T, rng: G.s.rng, all: G.s.bansAllTime },
      recorded: { T: r.T, rng: r.rng, all: r.all },
    };
  }
  const ok = sim.dispatch(r.a);
  const code = r.a[0];
  results[code] ??= [0, 0];
  results[code][ok ? 0 : 1]++;
}
runTo(rec.endT);

console.log(JSON.stringify({
  actions: rec.actions.length,
  overshoots,
  results,
  firstDiff,
  end: {
    recordedAll: rec.endAll, replayAll: G.s.bansAllTime,
    ratio: rec.endAll / Math.max(1, G.s.bansAllTime),
    rngMatches: rec.endRng === G.s.rng,
  },
}));
process.exit(0);
