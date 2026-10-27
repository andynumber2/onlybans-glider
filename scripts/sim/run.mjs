// Run one offline simulation with the Glider userscript and print metrics.
//
// Usage: node scripts/sim/run.mjs [--minutes 60] [--seed 1] [--set key=value ...]
//   --set auto=false            plain game, no automation
//   --set ops.notch=false       disable one routine
//   --bundle index-X.js         run an older game build from research/site/
//   --save FILE                 start from a game save (localStorage `click2ban-save` text)
//   --raf MS                    animation frame period (default 50; 16 = browser's 60 fps)
//   --rig NAME                  rig a game roll (harness.mjs RIGS; sim-only ceiling tests)
//   --userscript FILE           run another userscript build (default dist/)
//   --nonces 1                  mix a seeded leaderboard nonce into the game RNG
//                               at start and every minute, as the live server does
//   --record FILE               save every game action (with its tick and the
//                               game's RNG state) for scripts/sim/replay.mjs
// Prints a JSON summary on the last line for scripting.
import { performance as realPerf } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { createSim } from './harness.mjs';

const args = process.argv.slice(2);
const opt = { minutes: 60, seed: 1, set: [] };
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, '');
  if (k === 'set') opt.set.push(args[i + 1]);
  else if (k === 'relic') (opt.relics ??= []).push(args[i + 1]);
  else if (k === 'record') opt.record = args[i + 1];
  else if (k === 'bundle') opt.bundle = args[i + 1];
  else if (k === 'save') opt.save = args[i + 1];
  else if (k === 'rig') opt.rig = args[i + 1];
  else if (k === 'userscript') opt.userscript = args[i + 1];
  else opt[k] = Number(args[i + 1]);
}

const settings = { auto: true, ops: {} };
for (const kv of opt.set) {
  const [path, raw] = kv.split('=');
  let value = raw;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  else if (!isNaN(Number(raw))) value = Number(raw);
  else if (raw.startsWith('[')) value = JSON.parse(raw);
  const parts = path.split('.');
  let target = settings;
  while (parts.length > 1) target = target[parts.shift()] ??= {};
  target[parts[0]] = value;
}

const wall0 = realPerf.now();
const save = opt.save ? (await readFile(opt.save, 'utf8')).trim() : null;
const sim = await createSim({ seed: opt.seed, userscript: opt.userscript ?? 'dist/onlybans-glider.user.js', settings, hookActions: !!opt.record, bundle: opt.bundle ?? null, save, rafMs: opt.raf ?? 50, rig: opt.rig ?? null, nonces: !!opt.nonces });
// Every action the game applies, as the server would receive it: tick, the
// action, and the RNG state and all-time bans just before it was applied.
const recorded = [];
if (opt.record) {
  globalThis.__obAction = (e, ui) => {
    recorded.push({ T: sim.G.T, a: JSON.parse(JSON.stringify(e)), rng: sim.G.s.rng, all: sim.G.s.bansAllTime, ui: ui ?? null });
  };
}
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
// Planner run time (real ms) read from the panel once a game-second.
const plannerSamples = [];
// The panel's "Rate" line, parsed back from fmtNum's units.
const UNITS = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
function parseFmt(num, unit) {
  return Number(num) * Math.pow(1000, Math.max(0, UNITS.indexOf(unit)));
}
const rateWindow = [];
const rateChecks = [];
let windowStartBans = 0;
// Count automation actions by watching the panel's action log.
const actionCounts = {};
let lastLogTop = '';
// Game seconds from the start of this run until all-time bans hit the 1e38
// cap (`s.capped`); the run stops there.
let capSeconds = null;
// Stalls: game seconds where the bank holds more than 30 minutes of
// production, by the buyer's stop reason (digits stripped) and by sequel
// number, so we can see whether the bot sits on money it could spend.
const STALL_BANK_S = 1800;
const stalls = { seconds: 0, byReason: {}, bySequel: {}, episodes: [] };
let stallEpisode = null;
await sim.run(opt.minutes * 60, s => {
  const bankSeconds = G.s.bans / Math.max(1, G.bps);
  if (bankSeconds > STALL_BANK_S) {
    const autoLine = [...sim.window.document.querySelectorAll('#obh div')].find(d => d.textContent.startsWith('Auto: '));
    const stop = autoLine?.textContent.split(' · ')[1] ?? '?';
    const reason = stop.replace(/[\d.]+/g, '#').trim().slice(0, 40);
    const seq = G.s.prestige.sequels;
    stalls.seconds++;
    stalls.byReason[reason] = (stalls.byReason[reason] ?? 0) + 1;
    stalls.bySequel[seq] = (stalls.bySequel[seq] ?? 0) + 1;
    if (!stallEpisode) stallEpisode = { start: s, end: s, seq, maxBankMin: 0, reason };
    stallEpisode.end = s;
    stallEpisode.maxBankMin = Math.max(stallEpisode.maxBankMin, Math.round(bankSeconds / 60));
  } else if (stallEpisode) {
    if (stallEpisode.end - stallEpisode.start >= 60) stalls.episodes.push(stallEpisode);
    stallEpisode = null;
  }

  const top = sim.window.document.querySelector('#obh .opsLog')?.firstElementChild?.textContent ?? '';
  if (top && top !== lastLogTop) {
    lastLogTop = top;
    const kind = top.replace(/^\S+\s+(AM|PM)?\s*/, '').split(/[:(]/)[0].replace(/\d+/g, '').trim();
    actionCounts[kind] = (actionCounts[kind] ?? 0) + 1;
  }
  const plannerMatch = sim.window.document.querySelector('#obh')?.textContent.match(/planner (\d+)ms/);
  if (plannerMatch) plannerSamples.push(Number(plannerMatch[1]));
  const rateMatch = sim.window.document.querySelector('#obh header .rate')?.textContent.match(/([\d.]+)([A-Za-z]*)\/s/);
  if (rateMatch) rateWindow.push(parseFmt(rateMatch[1], rateMatch[2]));
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
    // Rate check: the panel's estimated rate (mean over the window) vs bans
    // actually earned in the window.
    const est = rateWindow.reduce((a, x) => a + x, 0) / Math.max(1, rateWindow.length);
    const actual = (G.s.bansAllTime - windowStartBans) / 600;
    rateChecks.push({ minute, est, actual, ratio: actual / est });
    rateWindow.length = 0;
    windowStartBans = G.s.bansAllTime;
    console.log(`t=${minute}m bansAllTime=${G.s.bansAllTime.toExponential(3)} bps=${G.bps.toExponential(3)} waves=${G.s.wavesLaunched} perception=${G.s.perception.toFixed(1)} notch=${G.s.truth.notch}`);
  }
  if (G.s.capped && capSeconds === null) {
    capSeconds = s + 1;
    console.log(`capped at ${(capSeconds / 3600).toFixed(2)} game hours (sequels ${G.s.prestige.sequels})`);
    return false;
  }
});

if (stallEpisode && stallEpisode.end - stallEpisode.start >= 60) stalls.episodes.push(stallEpisode);

if (process.env.SIM_DEBUG) {
  const panel = sim.window.document.querySelector('#obh');
  console.log('panel:', panel ? panel.textContent.replace(/\s+/g, ' ').slice(0, 1200) : 'MISSING');
}

const simMod = await import(sim.window.document.querySelector('script[type="module"]').src);
const relicsOwned = Object.values(simMod).find(v => v && Array.isArray(v.owned) && 'ctr' in v && 'offer' in v)?.owned ?? [];

function plannerStats(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, x) => a + x, 0) / samples.length;
  return { mean: Math.round(mean), p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1] };
}

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
  sequels: G.s.prestige.sequels, prestigeLevel: G.s.prestige.level, reputation: G.s.prestige.reputation,
  prestigeOwned: [...G.s.prestige.upgrades],
  plannerMs: plannerStats(plannerSamples),
  agentOwned: G.s.upgradesBought.has("tool:agent"),
  rateChecks,
  capSeconds,
  stalls,
  wallSeconds: Math.round((realPerf.now() - wall0) / 1000),
};
if (opt.record) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(opt.record, JSON.stringify({ seed: opt.seed, minutes: opt.minutes, save: opt.save ?? null, endT: G.T, endRng: G.s.rng, endAll: G.s.bansAllTime, actions: recorded }));
}
// Exit only once the summary is flushed: process.exit() right after a write
// to a pipe cuts it at the 64 KB pipe buffer.
process.stdout.write(JSON.stringify(summary) + '\n', () => process.exit(0));
