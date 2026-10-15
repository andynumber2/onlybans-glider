// Run one offline simulation with the Glider userscript and print metrics.
//
// Usage: node scripts/sim/run.mjs [--minutes 60] [--seed 1] [--set key=value ...]
//   --set auto=false            plain game, no automation
//   --set ops.notch=false       disable one routine
// Prints a JSON summary on the last line for scripting.
import { performance as realPerf } from 'node:perf_hooks';
import { createSim } from './harness.mjs';

const args = process.argv.slice(2);
const opt = { minutes: 60, seed: 1, set: [] };
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, '');
  if (k === 'set') opt.set.push(args[i + 1]);
  else if (k === 'relic') (opt.relics ??= []).push(args[i + 1]);
  else opt[k] = Number(args[i + 1]);
}

const settings = { auto: true, ops: {} };
for (const kv of opt.set) {
  const [path, raw] = kv.split('=');
  let value = raw;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  else if (!isNaN(Number(raw))) value = Number(raw);
  const parts = path.split('.');
  let target = settings;
  while (parts.length > 1) target = target[parts.shift()] ??= {};
  target[parts[0]] = value;
}

const wall0 = realPerf.now();
const sim = await createSim({ seed: opt.seed, userscript: 'dist/onlybans-glider.user.js', settings });
const start = [...sim.window.document.querySelectorAll('button')].find(b => /GET FUNDED/i.test(b.textContent));
start?.click();
// --relic thermos: grant a relic at the start (experiments only).
for (const id of opt.relics ?? []) {
  const mod = await import(sim.window.document.querySelector('script[type="module"]').src);
  const relicState = Object.values(mod).find(v => v && Array.isArray(v.owned) && 'ctr' in v && 'offer' in v);
  relicState.owned.push(id);
}

const G = sim.G;
const waves = [];
let review = null;
let minute = 0;
// log10(total bans) once a game-minute; growth is exponential, so compare runs
// on the mean of the last 30 of these rather than one noisy endpoint.
const logSamples = [];
// Count automation actions by watching the panel's action log.
const actionCounts = {};
let lastLogTop = '';
await sim.run(opt.minutes * 60, s => {
  const top = sim.window.document.querySelector('#obh .opsLog')?.firstElementChild?.textContent ?? '';
  if (top && top !== lastLogTop) {
    lastLogTop = top;
    const kind = top.replace(/^\S+\s+(AM|PM)?\s*/, '').split(/[:(]/)[0].replace(/\d+/g, '').trim();
    actionCounts[kind] = (actionCounts[kind] ?? 0) + 1;
  }
  if ((s + 1) % 60 === 0) {
    logSamples.push(Math.log10(Math.max(1, G.s.bansAllTime)));
    // Machine-readable progress for experiments.mjs: game seconds done/total.
    console.log(`PROGRESS ${s + 1} ${opt.minutes * 60}`);
  }
  const r = G.s.truth.review;
  if (r) review = { tier: r.tier, heat: r.heat, inn: r.inn, f: r.f };
  if (!r && review) {
    waves.push(review);
    review = null;
  }
  if ((s + 1) % 600 === 0) {
    minute += 10;
    console.log(`t=${minute}m bansAllTime=${G.s.bansAllTime.toExponential(3)} bps=${G.bps.toExponential(3)} waves=${G.s.wavesLaunched} perception=${G.s.perception.toFixed(1)} notch=${G.s.truth.notch}`);
  }
});

if (process.env.SIM_DEBUG) {
  const panel = sim.window.document.querySelector('#obh');
  console.log('panel:', panel ? panel.textContent.replace(/\s+/g, ' ').slice(0, 1200) : 'MISSING');
}

const simMod = await import(sim.window.document.querySelector('script[type="module"]').src);
const relicsOwned = Object.values(simMod).find(v => v && Array.isArray(v.owned) && 'ctr' in v && 'offer' in v)?.owned ?? [];

const tiers = [0, 0, 0, 0, 0];
for (const w of waves) tiers[w.tier]++;
const summary = {
  seed: opt.seed, minutes: opt.minutes, settings,
  score: logSamples.slice(-30).reduce((a, x) => a + x, 0) / Math.max(1, logSamples.slice(-30).length),
  bansAllTime: G.s.bansAllTime, bps: G.bps, waves: G.s.wavesLaunched, tiers,
  avgHeat: waves.length ? waves.reduce((a, w) => a + w.heat, 0) / waves.length : null,
  goldenClicked: G.s.eventsClicked, goldenMissed: G.s.eventsMissed, clicks: G.s.clicks,
  upgrades: G.s.upgradesBought.size, perception: G.s.perception, burnout: G.s.staff.burnout,
  relics: relicsOwned, actions: actionCounts,
  wallSeconds: Math.round((realPerf.now() - wall0) / 1000),
};
console.log(JSON.stringify(summary));
process.exit(0);
