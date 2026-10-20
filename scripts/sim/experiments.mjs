// Runs several simulations in parallel (one process each) and prints a table.
//
// Usage: node scripts/sim/experiments.mjs [minutes] [seeds] [set]
// Edit CONFIG_SETS below to change what's compared; [set] picks one (default: first).
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { renderProgress } from './progress.mjs';

const minutes = Number(process.argv[2] ?? 120);
const seeds = (process.argv[3] ?? '7').split(',').map(Number);

const SAVE = ['--save', 'research/tmp/save-2026-10-19.txt'];
const CONFIG_SETS = {
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
const jobs = [];
for (const seed of seeds) for (const [name, extra] of Object.entries(CONFIGS)) jobs.push(runOne(name, seed, extra));

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
const results = await Promise.all(jobs);
clearInterval(tick);
await writeFile('research/sim-runs/progress.json', JSON.stringify(progress));

const rows = results.map(({ name, seed, result: r }) => {
  if (!r) return `${name.padEnd(16)} seed ${seed}: FAILED (see research/sim-runs/${name}-s${seed}.txt)`;
  return `${name.padEnd(16)} seed ${seed}: bansAllTime ${r.bansAllTime.toExponential(3)}  bps ${r.bps.toExponential(3)}` +
    `  waves ${r.waves} tiers ${r.tiers.join('/')}  avgHeat ${r.avgHeat?.toFixed(1)}  golden ${r.goldenClicked}/${r.goldenClicked + r.goldenMissed}` +
    `  clicks ${r.clicks}  perception ${r.perception.toFixed(0)}  burnout ${r.burnout.toFixed(0)}` +
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
