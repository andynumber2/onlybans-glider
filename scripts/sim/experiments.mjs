// Runs several simulations in parallel (one process each) and prints a table.
//
// Usage: node scripts/sim/experiments.mjs [minutes] [seeds] [set]
// Edit CONFIG_SETS below to change what's compared; [set] picks one (default: first).
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { renderProgress } from './progress.mjs';

const minutes = Number(process.argv[2] ?? 120);
const seeds = (process.argv[3] ?? '7').split(',').map(Number);

const SAVE = ['--save', 'research/tmp/save-2026-10-19.txt'];
const SAVE_CAP = ['--save', 'research/tmp/save-2026-10-22.txt'];
const CONFIG_SETS = {
  // Fresh run to the 5e37 cap (build JlW7JWZY) with the current bot.
  // Seeds 7-11: 36.95 game hours mean (33.5-41.8), 15-17 sequels, ~50 min wall.
  fresh: {
    base: [],
  },
  // Fresh run to the 5e37 cap: endgame ship rule (src/planner.js
  // endgameShip) and planner horizon 4h, against the current bot. Run with
  // 7+ seeds: the same seed and config can differ by 9 h. Seeds 7-13: base
  // 40.2 / endgame 38.9 / h4h 40.8 game hours, no consistent winner.
  freshEndgame: {
    base: [],
    endgame: ['--set', 'ops.sequelEndgame=true'],
    h4h: ['--set', 'horizon=14400'],
  },
  // Fresh run to the 5e37 cap: the planner's deadline objective (bans earned
  // by the next ship or the cap; `deadline` in src/main.js), alone and with
  // the endgame ship rule, against the current bot. 7+ seeds. Seeds 7-13:
  // base 40.6 / deadline 39.8 / deadlineEndgame 45.9 game hours; deadline
  // beat base on 4 of 7 (noise), deadlineEndgame lost on 6 of 7.
  freshDeadline: {
    base: [],
    deadline: ['--set', 'deadline=true'],
    deadlineEndgame: ['--set', 'deadline=true', '--set', 'ops.sequelEndgame=true'],
  },
  // Fresh run to the 5e37 cap: ceiling for an RNG look-ahead on the golden
  // report effect pick (harness.mjs RIGS, GOLD_RANK). Seeds 7-13: base 43.7 /
  // gold10 12.6 / goldBest 12.9 game hours, faster on 7 of 7 seeds.
  freshGold: {
    base: [],
    gold10: ['--rig', 'gold10'],
    goldBest: ['--rig', 'goldBest'],
  },
  // Fresh run to the 5e37 cap: the bot's golden report look-ahead
  // (ops.goldenPick, predictGolden in src/game.js) against the current bot.
  freshGoldPick: {
    base: [],
    goldenPick: ['--set', 'ops.goldenPick=true'],
  },
  // Fresh run to the 5e37 cap: more seeds for base vs the deadline objective
  // (freshDeadline's gap was within noise). Seeds 29-43: base 42.1 /
  // deadline 39.3, deadline faster on 10 of 15. Seeds 14-28 of freshDeadline
  // went the other way (39.6 / 41.3 / deadlineEndgame 40.6). Pooled over 37
  // seeds: 40.8 vs 40.2, no measurable effect.
  freshConfirm: {
    base: [],
    deadline: ['--set', 'deadline=true'],
  },
  // Fresh run to the 5e37 cap: ceiling for an RNG look-ahead on the wave heat
  // roll (harness.mjs RIGS). wave10 = best of 10 draws, wave0 = best roll.
  // Seeds 7-13: base 36.4 / wave10 41.3 / wave0 38.9 game hours. A perfect
  // roll does not reach the cap sooner: no RNG look-ahead for waves.
  freshRig: {
    base: [],
    wave10: ['--rig', 'wave10'],
    wave0: ['--rig', 'wave0'],
  },
  // Fresh run to the 5e37 cap: sequel ship ratio sweep. Seeds 7-11, game
  // hours to cap: ×1.5 46.0 / ×2 35.5 / ×3 48.4 / ×4 44.5.
  freshSequel: {
    g15: ['--set', 'ops.sequelGain=1.5'],
    g2: [],
    g3: ['--set', 'ops.sequelGain=3'],
    g4: ['--set', 'ops.sequelGain=4'],
  },
  // Time to the 1e38 all-time cap from the 2026-10-22 save (sequel 8,
  // 2.0e37 all-time): sequel ratio sweep, plus never shipping again.
  // Seeds 7-11, game hours to cap: ×1.3 18.6 / ×1.45 20.9 / ×1.6 16.5 /
  // ×2 17.5 / never 25.7. Ratios within noise; ×2 kept.
  cap: {
    g13: [...SAVE_CAP, '--set', 'ops.sequelGain=1.3'],
    g145: [...SAVE_CAP, '--set', 'ops.sequelGain=1.45'],
    g16: [...SAVE_CAP, '--set', 'ops.sequelGain=1.6'],
    g2: [...SAVE_CAP],
    never: [...SAVE_CAP, '--set', 'ops.sequelGain=1000'],
  },
  // Sequels from the user's late save (42,573 pending stars). 3 h results
  // (seeds 7-9): never ship 26.15, ship at ×2 27.05, ×4 27.17, ×2 spending all
  // reputation 26.81. 6 h: ×4 29.41 vs a gain-per-hour rule 28.19 (removed).
  // From the 2026-10-19 save (sequel 7), 6 h: ×2 36.67 / ×3 36.81 / ×4 36.77,
  // inconclusive (only one ×2 run shipped).
  sequel: {
    gain2: [...SAVE],
    gain3: [...SAVE, '--set', 'ops.sequelGain=3'],
    gain4: [...SAVE, '--set', 'ops.sequelGain=4'],
  },
  // 24 h, seeds 7-15: ×1.6 37.68 / ×2 37.73 / ×4 37.41 (×2 shipped as the
  // default). A toy model (linear income after a ~100 min ramp) predicted
  // the order: ×1.6 37.32 / ×2 37.31 / ×4 37.15.
  sequel24: {
    g16: [...SAVE, '--set', 'ops.sequelGain=1.6'],
    g2: [...SAVE],
    g4: [...SAVE, '--set', 'ops.sequelGain=4'],
  },
  // Simulator speed: animation frames at 16 ms (browser) vs 50 ms (default).
  raf: {
    raf16: [...SAVE, '--raf', '16'],
    raf50: [...SAVE],
  },
  stealth: {
    human: [],
    steady: ['--set', 'stealth=false'],
  },
  waveAt: {
    wave100: [],
    wave134: ['--set', 'ops.waveAt=1.34'],
    wave200: ['--set', 'ops.waveAt=2'],
    wave267: ['--set', 'ops.waveAt=2.67'],
  },
  // Confirms the sweep's winner on fresh seeds, and whether longer still helps.
  confirm: {
    d3h15m: ['--set', 'depth=3', '--set', 'horizon=900'],
    d1h1h: ['--set', 'depth=1', '--set', 'horizon=3600'],
    d1h4h: ['--set', 'depth=1', '--set', 'horizon=14400'],
  },
  sweep: Object.fromEntries([1, 2, 3].flatMap(depth => [[300, '5m'], [900, '15m'], [3600, '1h']].map(([h, label]) =>
    [`d${depth}h${label}`, ['--set', `depth=${depth}`, '--set', `horizon=${h}`]]))),
};
const setName = process.argv[4] ?? Object.keys(CONFIG_SETS)[0];
const CONFIGS = CONFIG_SETS[setName];
if (!CONFIGS) throw new Error(`unknown config set ${setName}; have ${Object.keys(CONFIG_SETS).join(', ')}`);

// Live progress: written to research/sim-runs/progress.json for
// scripts/sim/progress.mjs, and drawn in place when run in a terminal.
const progress = { started: Date.now(), runs: {} };

function runOne(name, seed, extra) {
  const id = `${name} s${seed}`;
  progress.runs[id] = { done: 0, total: minutes * 60, finished: false };
  return new Promise(resolve => {
    const child = spawn('node', ['scripts/sim/run.mjs', '--minutes', String(minutes), '--seed', String(seed), ...extra]);
    let out = '';
    child.stdout.on('data', d => {
      out += d;
      for (const m of String(d).matchAll(/PROGRESS (\d+) (\d+)/g)) progress.runs[id].done = Number(m[1]);
    });
    child.stderr.on('data', d => { out += d; });
    child.on('close', async () => {
      progress.runs[id].finished = true;
      progress.runs[id].done = progress.runs[id].total;
      await writeFile(`research/sim-runs/${name}-s${seed}.txt`, out);
      const last = out.trim().split('\n').reverse().find(l => l.startsWith('{'));
      resolve({ name, seed, result: last ? JSON.parse(last) : null });
    });
  });
}

await mkdir('research/sim-runs', { recursive: true });
// At most (cores - 2) runs at once so the machine stays usable (user request,
// 2026-10-23); the rest wait in a queue.
const MAX_PARALLEL = Math.max(1, availableParallelism() - 2);
const queue = [];
for (const seed of seeds) for (const [name, extra] of Object.entries(CONFIGS)) queue.push([name, seed, extra]);
const done = new Array(queue.length);
let nextJob = 0;
async function worker() {
  while (nextJob < queue.length) {
    const i = nextJob++;
    done[i] = await runOne(...queue[i]);
  }
}
const jobs = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker);

const tty = process.stdout.isTTY;
let drawnLines = 0;
const tick = setInterval(async () => {
  await writeFile('research/sim-runs/progress.json', JSON.stringify(progress));
  if (!tty) return;
  const text = renderProgress(progress);
  if (drawnLines) process.stdout.write(`\x1b[${drawnLines}A`);
  process.stdout.write(text + '\n');
  drawnLines = text.split('\n').length;
}, 2000);
await Promise.all(jobs);
const results = done;
clearInterval(tick);
await writeFile('research/sim-runs/progress.json', JSON.stringify(progress));

const rows = results.map(({ name, seed, result: r }) => {
  if (!r) return `${name.padEnd(16)} seed ${seed}: FAILED (see research/sim-runs/${name}-s${seed}.txt)`;
  return `${name.padEnd(16)} seed ${seed}: bansAllTime ${r.bansAllTime.toExponential(3)}  bps ${r.bps.toExponential(3)}` +
    `  waves ${r.waves} tiers ${r.tiers.join('/')}  avgHeat ${r.avgHeat?.toFixed(1)}  golden ${r.goldenClicked}/${r.goldenClicked + r.goldenMissed}` +
    `  clicks ${r.clicks}  perception ${r.perception.toFixed(0)}  burnout ${r.burnout.toFixed(0)}` +
    `  cap ${r.capSeconds === null ? '-' : (r.capSeconds / 3600).toFixed(2) + 'h'}  sequels ${r.sequels}` +
    `  planner ${r.plannerMs?.mean}/${r.plannerMs?.p95}/${r.plannerMs?.max}ms  wall ${r.wallSeconds}s`;
});
console.log(rows.join('\n'));

// Per config: mean score (mean log10 total bans over the last 30 minutes)
// across seeds; +0.1 is about 26% more bans.
console.log('\nmean score by config (log10 bans, last 30 min):');
for (const name of Object.keys(CONFIGS)) {
  const scores = results.filter(x => x.name === name && x.result).map(x => x.result.score);
  const mean = scores.reduce((a, x) => a + x, 0) / Math.max(1, scores.length);
  console.log(`  ${name.padEnd(16)} ${mean.toFixed(3)}  (${scores.map(x => x.toFixed(2)).join(', ')})`);
}

// Per config: mean game hours to the 1e38 cap. A run that never capped
// counts as the full run length, so that mean is a lower bound.
console.log('\nmean hours to cap by config:');
for (const name of Object.keys(CONFIGS)) {
  const rs = results.filter(x => x.name === name && x.result).map(x => x.result);
  const hours = rs.map(r => (r.capSeconds ?? minutes * 60) / 3600);
  const mean = hours.reduce((a, x) => a + x, 0) / Math.max(1, hours.length);
  const uncapped = rs.filter(r => r.capSeconds === null).length;
  console.log(`  ${name.padEnd(16)} ${mean.toFixed(2)}h  (${hours.map(x => x.toFixed(1)).join(', ')})${uncapped ? `  ${uncapped} never capped` : ''}`);
}
