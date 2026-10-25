// Checks predictGolden (src/game.js, used by Golden picks) against the game's
// own golden report effect pick on the current build: a fresh offline game
// with Golden picks on, and once a game-second both a red and a normal
// report's prediction compared with the game's pick from the same RNG state
// (which is restored after). Fails on any difference, or if the pick
// function can't be found in the bundle. Run after every new game build
// (part of npm run release).
import { createSim } from './sim/harness.mjs';
import { bindGame, predictGolden } from '../src/game.js';

const MINUTES = 20;
const sim = await createSim({ seed: 7, userscript: 'dist/onlybans-glider.user.js', settings: { auto: true, ops: { goldenPick: true } }, hookActions: true });
if (!sim.goldenPick) throw new Error('golden report effect pick not exported');
[...sim.window.document.querySelectorAll('button')].find(b => /GET FUNDED/i.test(b.textContent))?.click();
const game = await bindGame(sim.window);
const s = () => sim.G.s;
let checked = 0;
let missed = 0;
const misses = [];
const seen = new Set();
await sim.run(MINUTES * 60, t => {
  for (const wrath of [false, true]) {
    const rng = s().rng;
    const predicted = predictGolden(game, { wrath });
    const actual = sim.goldenPick(wrath);
    s().rng = rng;
    checked++;
    seen.add(actual);
    if (predicted !== actual) missed++;
    if (predicted !== actual && misses.length < 5) misses.push(`t=${t}s wrath=${wrath}: predicted ${predicted}, game ${actual}`);
  }
});
const failures = missed ? [`${missed} of ${checked} predictions differ`, ...misses] : [];
if (seen.size < 6) failures.push(`only ${seen.size} different effects seen (${[...seen].join(', ')}): too little coverage`);
if (failures.length) {
  console.log(`FAIL: golden prediction (${checked} checks on ${sim.bundleName})`);
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
console.log(`PASS: golden prediction matched the game's pick ${checked} of ${checked} times on ${sim.bundleName} (${seen.size} effects)`);
process.exit(0);
