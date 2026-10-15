// ==UserScript==
// @name         OnlyBans Glider
// @namespace    onlybans-glider
// @version      0.9.0
// @description  Purchase planner and automation for onlybans.wtf
// @match        *://onlybans.wtf/*
// @match        *://*.onlybans.wtf/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
'use strict';

// ---- src/planner.js ----
// Receding-horizon purchase planner.
//
// Works against a sandbox ("sim") that can apply and undo purchases and report
// the resulting production rate. The planner never touches the game directly.
//
// sim interface:
//   candidates() -> item[]          items purchasable in the current sim state
//   price(item)  -> number
//   rate()       -> number          bans/sec in the current sim state
//   apply(item)  / undo()
//
// Objective: maximize  bank(H) + rate(H) * H.
// The tail term values production for one more horizon, so a purchase is worth
// making when it pays back within roughly (2H - time until affordable).

// Cap on purchases made in the "spend now" phase, to bound planning time.
const MAX_NOW_BUYS = 100;

function plan(sim, { bank, horizon, depth = 3, beam = 5 }) {
  const rateStart = sim.rate();
  const ranked = rankCandidates(sim, { t: 0, bank, rate: rateStart }, horizon);

  // Phase 1: while the best-scoring item is affordable now and pays back
  // within the objective's break-even (2H), buy it. Late game this can be
  // dozens of purchases, which a depth-limited search would never reach.
  const nowSteps = [];
  let nowBank = bank;
  try {
    let top = ranked[0];
    while (top && top.wait === 0 && top.payback < 2 * horizon && nowSteps.length < MAX_NOW_BUYS) {
      sim.apply(top.item);
      nowBank -= top.price;
      nowSteps.push({ item: top.item, price: top.price, at: 0, gain: top.gain, rateAfter: top.rateAfter });
      top = rankCandidates(sim, { t: 0, bank: nowBank, rate: top.rateAfter }, horizon)[0];
    }
    const ahead = lookahead(sim, nowBank, horizon, depth, beam);
    return { rate: rateStart, path: [...nowSteps, ...ahead], candidates: ranked };
  } finally {
    for (let i = 0; i < nowSteps.length; i++) sim.undo();
  }
}

// Phase 2: depth-limited search over future purchases from the current state.
function lookahead(sim, bank, horizon, depth, beam) {
  const rate0 = sim.rate();
  const holdValue = bank + rate0 * horizon * 2;
  const ranked = rankCandidates(sim, { t: 0, bank, rate: rate0 }, horizon);

  for (const c of ranked.slice(0, beam)) {
    const sub = descend(sim, c, { t: 0, bank, rate: rate0 }, horizon, depth - 1, beam);
    c.pathValue = sub.value;
    c.path = sub.steps;
  }

  let best = null;
  for (const c of ranked.slice(0, beam)) {
    if (c.pathValue > holdValue && (!best || better(c.pathValue, best.pathValue))) best = c;
  }

  if (!best) return [];
  return best.path;
}

// Score every candidate at a node: wait time plus payback time.
function rankCandidates(sim, node, horizon) {
  const out = [];
  for (const item of sim.candidates()) {
    const price = sim.price(item);
    if (!(price >= 0) || !isFinite(price)) continue;
    const wait = waitFor(price, node.bank, node.rate);
    if (node.t + wait > horizon) continue;
    sim.apply(item);
    const rateAfter = sim.rate();
    sim.undo();
    const gain = rateAfter - node.rate;
    if (!(gain > 0)) continue;
    out.push({ item, price, wait, gain, rateAfter, payback: price / gain, score: wait + price / gain });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

function descend(sim, cand, node, horizon, depthLeft, beam) {
  const t = node.t + cand.wait;
  const bank = node.bank + node.rate * cand.wait - cand.price;
  const step = {
    item: cand.item,
    price: cand.price,
    at: t,
    gain: cand.gain,
    rateAfter: cand.rateAfter,
  };
  const here = { t, bank, rate: cand.rateAfter };
  const leaf = bank + here.rate * (horizon - t) + here.rate * horizon;

  if (depthLeft <= 0) return { value: leaf, steps: [step] };

  sim.apply(cand.item);
  try {
    let best = { value: leaf, steps: [] };
    for (const c of rankCandidates(sim, here, horizon).slice(0, beam)) {
      const sub = descend(sim, c, here, horizon, depthLeft - 1, beam);
      if (better(sub.value, best.value)) best = sub;
    }
    return { value: best.value, steps: [step, ...best.steps] };
  } finally {
    sim.undo();
  }
}

// Strictly better by more than float noise. Candidates are visited in payback
// order, so equal-value paths resolve to the best-payback item first.
function better(a, b) {
  return a - b > Math.abs(b) * 1e-9;
}

function waitFor(price, bank, rate) {
  if (bank >= price) return 0;
  if (!(rate > 0)) return Infinity;
  return (price - bank) / rate;
}

// Collapse consecutive identical purchases: [A, A, B] -> [{A x2}, {B x1}].
function groupSteps(steps, keyOf) {
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && keyOf(last.item) === keyOf(s.item)) {
      last.count++;
      last.price += s.price;
      last.at = s.at;
      last.gain += s.gain;
      last.rateAfter = s.rateAfter;
    } else {
      out.push({ ...s, count: 1 });
    }
  }
  return out;
}

// ---- src/game.js ----
// Binds to the running game and provides a what-if sandbox for the planner.
//
// The game's bundle is an ES module. Importing the same URL returns the
// already-running instance, so we get the live tables without copying any
// numbers. Export names are minified and change between builds, so each export
// is identified by its contents instead.

// Upgrade kinds with side effects beyond production (arms race mechanics).
// Shown to the player but never auto-planned.
const SPECIAL_KINDS = new Set(['escalation', 'truce', 'detente']);

async function bindGame(win) {
  const script = win.document.querySelector('script[type="module"][src*="/assets/index-"]');
  if (!script) throw new Error('game bundle <script> not found');
  const mod = await import(script.src);

  let logic = null;
  let buildings = null;
  let upgrades = null;
  let dupe = null;
  for (const val of Object.values(mod)) {
    if (val && typeof val === 'object' && typeof val.calculateGains === 'function' && val.G) logic = val;
    // Dupe-outbreak minigame state: optional, automation skips it if absent.
    if (val && typeof val === 'object' && 'answer' in val && Array.isArray(val.deck) && Array.isArray(val.done)) dupe = val;
    if (Array.isArray(val) && val.length && typeof val[0] === 'object' && val[0]) {
      if ('baseCost' in val[0] && 'baseBps' in val[0]) buildings = val;
      if (typeof val[0].unlock === 'function' && 'kind' in val[0]) upgrades = val;
    }
  }
  const missing = [];
  if (!logic) missing.push('logic API');
  if (!buildings) missing.push('building table');
  if (!upgrades) missing.push('upgrade table');
  if (missing.length) throw new Error('could not find: ' + missing.join(', '));

  return { logic, G: logic.G, buildings, upgrades, dupe, build: script.src.split('/').pop() };
}

// Runs fn(sim) with the live state temporarily mutated, then restores it.
// Synchronous on purpose: the game loop cannot interleave with us.
function withSandbox(game, { clicksPerSec = 0 } = {}, fn) {
  const { logic, G, buildings, upgrades } = game;
  const s = G.s;
  const savedBuffs = s.buffs;
  const undoStack = [];
  // Temporary buffs are excluded so advice doesn't swing during golden events.
  s.buffs = [];

  const sim = {
    rate() {
      logic.calculateGains();
      return G.rawBps + clicksPerSec * G.clickPower;
    },
    price(item) {
      if (item.type === 'building') return logic.buildingPrice(item.def.id, 1);
      return logic.upgradePrice(item.def);
    },
    apply(item) {
      if (item.type === 'building') {
        s.buildings[item.def.id].amount++;
        undoStack.push(() => { s.buildings[item.def.id].amount--; });
      } else {
        s.upgradesBought.add(item.def.id);
        undoStack.push(() => { s.upgradesBought.delete(item.def.id); });
      }
    },
    undo() {
      undoStack.pop()();
    },
    candidates() {
      const out = buildings.filter(def => buildingVisible(def, s)).map(def => ({ type: 'building', def }));
      const ctx = logic.ctx();
      for (const def of upgrades) {
        if (SPECIAL_KINDS.has(def.kind)) continue;
        if (s.upgradesBought.has(def.id)) continue;
        if (!s.upgradesUnlocked.has(def.id) && !safeUnlock(def, ctx)) continue;
        out.push({ type: 'upgrade', def });
      }
      return out;
    },
  };

  try {
    return fn(sim);
  } finally {
    while (undoStack.length) undoStack.pop()();
    s.buffs = savedBuffs;
    logic.calculateGains();
  }
}

// Mirrors the store's rule for showing a building row as buyable rather than
// "???". Locked rows have no click handler, so they can't be purchased.
function buildingVisible(def, s) {
  const b = s.buildings[def.id];
  return def.index === 0 || b.amount > 0 || b.highest > 0 || s.bansEarned >= def.baseCost;
}

// Bans/sec regained if the given buff (e.g. a stopped department) ended now.
// Measured with the game's own calculateGains, then state is restored.
function buffCost(game, buffKey) {
  const { logic, G } = game;
  const s = G.s;
  const saved = s.buffs;
  const buff = saved.find(b => b.key === buffKey);
  if (!buff) return 0;
  try {
    s.buffs = saved.filter(b => b !== buff);
    logic.calculateGains();
    const without = G.bps;
    s.buffs = saved;
    logic.calculateGains();
    return Math.max(0, without - G.bps);
  } finally {
    s.buffs = saved;
    logic.calculateGains();
  }
}

function safeUnlock(def, ctx) {
  try {
    return !!def.unlock(ctx);
  } catch {
    return false;
  }
}

function itemKey(item) {
  return item.type + ':' + item.def.id;
}

function itemLabel(item) {
  return `${iconText(item.def.icon)} ${item.def.name}`.trim();
}

// Some icons are sprite tokens ("sprite:NAME") drawn by the game; skip those.
function iconText(icon) {
  if (!icon || icon.startsWith('sprite:')) return '';
  return icon;
}

// Special upgrades the player can buy right now, listed separately.
function specialUpgrades(game) {
  const s = game.G.s;
  return game.upgrades.filter(u =>
    SPECIAL_KINDS.has(u.kind) && s.upgradesUnlocked.has(u.id) && !s.upgradesBought.has(u.id));
}

// ---- src/ops.js ----
// Automation for everything besides purchases. Every action is a click on the
// game's own UI, so it runs the same recorded handler a human click does.
// Each routine waits a random reaction delay after its target becomes
// actionable, so nothing fires on the exact tick it becomes possible.

const OPS = [
  { key: 'hammer', label: 'Click the banhammer (stops when clicks are negligible)' },
  { key: 'pizza', label: 'Pizza party (feed everyone)' },
  { key: 'streamer', label: 'Streamer minigames (speedrun, react, launch)' },
  { key: 'region', label: 'Wrong region: pick the right flag' },
  { key: 'legends', label: 'Legends (ZABURUFF, BENZON, crew)' },
  { key: 'bugs', label: 'Squash crawling bugs' },
  { key: 'evaders', label: 'Pop ban evaders' },
  { key: 'weird', label: 'Weird events (coup, strike, you are banned)' },
  { key: 'notch', label: 'Strictness notch (loosest that stays safe)' },
  { key: 'shimmers', label: 'Click bonus objects (skips red reports)' },
  { key: 'clip', label: 'Clip it! (live cheater stream)' },
  { key: 'relics', label: 'Evidence Seized: pick a relic' },
  { key: 'priority', label: 'Priority cases' },
  { key: 'tickets', label: 'Tickets & repairs' },
  { key: 'weekend', label: 'Weekends (work unless burnout high)' },
  { key: 'incidents', label: 'Other incidents (pay when it pays off)' },
  { key: 'coffee', label: 'Coffee run' },
  { key: 'callHammer', label: 'Call the Hammer' },
  { key: 'lever', label: 'Pull the Lever at high burnout' },
  { key: 'coinLock', label: 'Coin-Lock during dupe/economy meta' },
  { key: 'audit', label: 'Audits' },
  { key: 'report', label: 'Transparency reports (clean only)' },
  { key: 'dupes', label: 'Dupe outbreaks' },
  { key: 'banWaves', label: 'Ban waves (100%, audit first when possible)' },
];

const OPS_DEFAULTS = Object.fromEntries(OPS.map(o => [o.key, true]));

// Tunables. Burnout is 0..100; humans lose burnout/200 of output.
const COFFEE_MAX_BURNOUT = 40; // the game's own "suggest" threshold
const WEEKEND_WORK_MAX_BURNOUT = 50; // crunch adds +20; stay under the 70 "hot" line
const LEVER_AT_BURNOUT = 70; // the game's "hot" threshold
const CLEAN_REPORT_RATIO = 0.35; // reality/perception below this = clean verdict
const REACTION_MS = [600, 2200];
const FAST_REACTION_MS = [250, 700]; // short-window prompts (clip it)
// A priority case pays double when "airtight" (enough hammer clicks seen).
// Hold the verdict for that while the hammer clicker runs, unless time is short.
const PRIORITY_MIN_SECONDS_LEFT = 2.5;
const TICKS_PER_SEC = 30;

// Relic preference given what this script automates. Priority cases are
// always ruled correctly, so the cat and little brother never trigger; only
// clean reports are published, so the sharpie only adds leak risk; evaders
// are not popped, so the mustache bin only makes them siphon more.
const RELIC_RANK = ['thermos', 'ringLight', 'lunchbox', 'tally', 'phil', 'loadedDie', 'cat', 'littleBrother'];
const RELIC_NAMES = {
  "Kevin's Night-Shift Thermos": 'thermos',
  "The Streamer's Ring Light": 'ringLight',
  "Grandma's Lunchbox": 'lunchbox',
  "The Auditor's Tally Counter": 'tally',
  'A Second Phil': 'phil',
  "The Tribunal's Loaded Die": 'loadedDie',
  'The Cat': 'cat',
  'The Little Brother': 'littleBrother',
};

// Incident choices: return the button index to press, or null to let the card
// expire (expiry picks option 1 for free). Costs are seconds of production.
const INCIDENTS = {
  // 60s / 120s to restore a stopped department: pay only if the production
  // lost over the remaining stoppage is worth more than the fee.
  employeeQuits: (inc, game) => payIfStoppageCostsMore(inc, game, 'quit:'),
  vendorLapse: (inc, game) => payIfStoppageCostsMore(inc, game, 'vendor:'),
  excelLimit: () => 0, // 300s for a permanent ×1.5 on Log Analysts
  streamerAccusation: () => 0, // 60s: Perception -10, credibility +3
  falsePositive: () => 0, // 30s: Perception -12, credibility +4 (vs +4 / -8)
  wrongfulBans: () => 0, // 60s: Perception -6, credibility +3 (vs +5 / -5)
  cheatSeller: () => 0, // 120s for a 50-80% shot at +400s of bans
  cheatSellerLawsuit: () => 0, // 300s for +1500s of bans, Perception -8
};
// Leadership's "turn it all off" card: option 0 switches the anti-cheat off,
// option 1 costs 60s for nothing. Letting it expire is the free option 1.

// Pays (0) when the output lost over the remaining stoppage exceeds the fee,
// otherwise explicitly waits it out (1, free).
function payIfStoppageCostsMore(inc, game, prefix) {
  const b = inc.building;
  const buff = game.G.s.buffs.find(x => x.key === prefix + b);
  const fee = inc.choice.costs[0];
  if (!buff || game.G.s.bans < fee) return 1;
  const lostPerSec = buffCost(game, buff.key);
  return lostPerSec * (buff.time / TICKS_PER_SEC) > fee ? 0 : 1;
}

const LAUNCH_DROP_SECONDS = 1.5;

// Notch controller. Wave heat = 100 × innocent share × f^1.5 × (1.3 − 0.6 ×
// credibility/100) × a 0.7–1.3 roll; verdict tiers start at heat 5/15/35/70.
// Tier 1 is a mild ×0.85 for 60 s; tier 2+ costs real production and
// perception, so keep the worst-case roll under 15 with margin.
const NOTCH_HEAT_HIGH = 12;
const NOTCH_HEAT_LOW = 4;
const HEAT_WORST_ROLL = 1.3;
const AUDIT_KEEPS = 0.3; // a 5/5 audit scrubs about 75% of innocents
const NOTCH_MIN_METER = 0.15; // too little pile to judge before this
const NOTCH_STEP_MS = [4000, 8000]; // new pile only reflects the notch slowly

const PIZZA_REACTION_MS = [120, 320];
const PIZZA_CUTS_EACH = 4;

// Hold a charged wave this long at most for the audit cooldown to finish.
const AUDIT_WAIT_SECONDS = 20;

// Satisfies the game's prerequisites: identify<-page, hotfix/ban<-identify,
// rollback<-hotfix+coinlock, community<-hotfix+leadership.
// Duped gold stops growing once the hotfix ships, so get there first. Gold
// stays under 60 by then, so leadership adds no harm afterwards.
const DUPE_ORDER = ['page', 'identify', 'hotfix', 'leadership', 'coinlock', 'ban', 'rollback', 'community'];

// Weird events with a choice: button index to press.
const WEIRD = {
  modCoup: () => 1, // pay 30 s of production to end 40 s of "only Moderators work"
  youAreBanned: () => 1, // "I AM the anti-cheat": 60% for +600 s vs a sure +180 s
  cheaterStrike: () => 0, // ×4 for 30 s vs ×0.1 until the strike ends
};
const DUPE_LABELS = {
  page: 'Page the on-call engineer',
  coinlock: 'COIN-LOCK the economy',
  identify: 'Find the exploit in the logs',
  hotfix: 'Ship the hotfix',
  ban: 'Ban the duper accounts',
  rollback: 'Roll back the duped gold',
  leadership: 'Brief leadership',
  community: 'Post to the community',
};

const since = new Map();
const delays = new Map();

// True once `eligible` has held continuously for this key's reaction delay.
function ready(key, eligible, range = REACTION_MS) {
  if (!eligible) {
    since.delete(key);
    delays.delete(key);
    return false;
  }
  const now = performance.now();
  if (!since.has(key)) {
    since.set(key, now);
    delays.set(key, range[0] + Math.random() * (range[1] - range[0]));
  }
  if (now - since.get(key) < delays.get(key)) return false;
  since.delete(key);
  delays.delete(key);
  return true;
}

function usable(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el || el.disabled || el.classList.contains('hidden')) return null;
  return el;
}

function press(el) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  el.click();
}

// Incident cards carry no id; match the card by its title.
function incidentCard(inc) {
  for (const card of document.querySelectorAll('.incident')) {
    const b = card.querySelector('.incHead b');
    if (b && b.textContent === inc.title) return card;
  }
  return null;
}

const ROUTINES = {
  shimmers(G) {
    for (const el of document.querySelectorAll('#shimmers .shimmer:not(.wrath)')) {
      if (ready('shimmer:' + shimmerKey(el), true)) {
        // Shimmers listen for pointerdown only.
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        return 'clicked bonus';
      }
    }
    return null;
  },

  // 75 s to feed 12 seats 2 slices + 1 soda each (36 servings) plus 12 cuts
  // and 12 sodas. Payout scales with the fraction fed, so keep it moving:
  // serve whenever possible, otherwise cut a pizza, otherwise open a soda.
  pizza(G) {
    const p = G.s.party;
    if (!p) {
      const done = document.querySelector('.pzResult:not(.hidden) .pzDone');
      if (!ready('pizza-done', !!done)) return null;
      done.click();
      return 'pizza: back to banning';
    }
    if (!ready('pizza:' + p.fed + ':' + p.cuts + ':' + p.opened, true, PIZZA_REACTION_MS)) return null;
    let seat = p.want.findIndex(w => w > 0);
    if (seat >= 0 && p.slices <= 0) seat = -1;
    if (seat < 0 && p.sodas > 0) seat = p.soda.findIndex(n => n > 0);
    if (seat >= 0) {
      const el = document.querySelector(`.pzTable .pzSeat[data-i="${seat}"]`);
      if (el) {
        el.click();
        return `pizza: fed ${p.fed + 1}/36`;
      }
    }
    const pizza = p.pcuts.findIndex(c => c < PIZZA_CUTS_EACH);
    if (pizza >= 0 && p.slices <= 0) {
      document.querySelectorAll('.pzPizza')[pizza]?.click();
      return 'pizza: cut';
    }
    if (p.opened < p.want.length) {
      document.querySelector('.pzCooler')?.click();
      return 'pizza: soda';
    }
    if (pizza >= 0) document.querySelectorAll('.pzPizza')[pizza]?.click();
    return null;
  },

  // Wave launch alarm: the right region is in state; each wrong flag adds
  // innocents to the pending wave and Perception +2.
  region(G) {
    const reg = G.s.truth.region;
    const flag = reg ? document.querySelector(`#regionRoom .rgFlag[data-r="${reg.ans}"]`) : null;
    if (!ready('region', !!flag, FAST_REACTION_MS)) return null;
    flag.click();
    return 'region: picked the right flag';
  },

  legends() {
    const el = usable('#zaburuff') ?? usable('#benzon') ??
      [...document.querySelectorAll('.crewLegend')].find(e => usable(e));
    if (!ready('legend:' + (el ? el.id || el.className : ''), !!el)) return null;
    el.click();
    return 'legend: ' + (el.id || el.title.split(',')[0]);
  },

  bugs() {
    const bug = document.querySelector('#bugLayer .crawlBug');
    if (!ready('bug', !!bug, FAST_REACTION_MS)) return null;
    bug.click();
    return 'squashed a bug';
  },

  // Evaders are drawn on the canvas; the game hit-tests pointerdowns there.
  // Position math mirrors the game's own layout (yp/bp).
  evaders(G) {
    const ev = G.s.evaders[0];
    if (!ready('evader:' + (ev ? ev.id + ':' + ev.hp : ''), !!ev)) return null;
    const canvas = document.querySelector('#leftCanvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const z = Math.max(50, Math.min(Math.min(w, h * 0.6) * 0.29, (h - 230) / 3.4, 160));
    const cx = w * 0.46;
    const cy = Math.max(h * 0.46, 120 + 2.1 * z);
    const dist = z * (2.75 - 1.45 * ev.close);
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true,
      clientX: rect.left + cx + Math.cos(ev.angle) * dist,
      clientY: rect.top + cy + Math.sin(ev.angle) * dist,
    }));
    return 'hit an evader';
  },

  weird(G) {
    const wd = G.s.weird;
    const policy = wd && wd.choice && wd.choice.chosen === undefined ? WEIRD[wd.key] : null;
    if (!ready('weird:' + (wd ? wd.id : ''), !!policy)) return null;
    const pick = policy(wd);
    const btns = wd.key === 'youAreBanned'
      ? document.querySelectorAll('.banBtn')
      : document.querySelectorAll('.wActions .incBtn');
    const btn = usable(btns[pick]);
    if (!btn) return null;
    btn.click();
    return `${wd.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
  },

  streamer(G) {
    const wd = G.s.weird;
    if (!wd || !wd.x) return null;
    if (wd.key === 'banSpeedrun') {
      // Each alt is clickable for 2.4 s; 8 bans in 50 s wins.
      const alt = document.querySelector('.lcMsgs .lcAlt.active');
      if (!ready('speedrun:' + wd.x[0], !!alt, FAST_REACTION_MS)) return null;
      alt.click();
      return 'speedrun: banned an alt';
    }
    if (wd.key === 'devsReact') {
      // The good clip's index is wd.x[1]; each poll is open 10 s.
      const btn = wd.v > 0 ? usable(`.lcCtl button[data-arg="${wd.x[1]}"]`) : null;
      if (!ready('react:' + wd.x[0], !!btn)) return null;
      btn.click();
      return 'devs react: picked the good clip';
    }
    if (wd.key === 'cheatLaunch') {
      // The stream's end tick is pre-rolled in wd.x[1]; payout grows with
      // buyers, so drop the wave just before it ends.
      const left = (wd.x[1] - wd.x[0]) / TICKS_PER_SEC;
      const btn = wd.v === 0 && left <= LAUNCH_DROP_SECONDS ? usable('.lcCtl button[data-arg]') : null;
      if (!ready('launch', !!btn, [30, 120])) return null;
      btn.click();
      return `cheat launch: dropped with ${Math.floor(wd.n)} buyers`;
    }
    return null;
  },

  // Looser notch = meter fills faster (more ×3+ waves per hour) but adds more
  // innocents, which raise the wave's heat and risk a bad verdict. Step
  // looser while the pile's projected heat (after a perfect audit, worst-case
  // roll) stays low; step stricter when it climbs toward the tier-2 line.
  notch(G, enabled) {
    const t = G.s.truth;
    if (!t.pile || G.s.waveMeter < NOTCH_MIN_METER) return null;
    const heat = projectedHeat(G, enabled);
    let dir = 0;
    if (heat > NOTCH_HEAT_HIGH) dir = -1;
    else if (heat < NOTCH_HEAT_LOW) dir = 1;
    let btn = null;
    if (dir < 0) btn = usable('#nPrev');
    if (dir > 0) btn = usable('#nNext');
    if (!ready('notch:' + t.notch + ':' + dir, !!btn, NOTCH_STEP_MS)) return null;
    btn.click();
    return `notch ${dir < 0 ? 'stricter' : 'looser'} (projected heat ${heat.toFixed(1)})`;
  },

  // The hammer clicker runs on its own faster loop (startHammer); nothing here.
  hammer() {
    return null;
  },

  clip(G) {
    const live = G.s.weird && G.s.weird.key === 'caughtLive';
    const btn = live ? usable('.liveChat .lcClip.ready') : null;
    if (!ready('clip', !!btn, FAST_REACTION_MS)) return null;
    btn.click();
    return 'clipped it';
  },

  relics() {
    const offer = document.querySelector('#relicOffer');
    const open = !!offer && !offer.classList.contains('hidden') && !!offer.querySelector('.offerCards');
    if (!ready('relic', open)) return null;
    let best = null;
    let bestRank = Infinity;
    for (const card of offer.querySelectorAll('.offerCard')) {
      const id = RELIC_NAMES[card.querySelector('.offerName')?.textContent.trim()];
      const rank = RELIC_RANK.indexOf(id);
      if (rank >= 0 && rank < bestRank) {
        best = card;
        bestRank = rank;
      }
    }
    // Nothing worth taking: leave it in the bag for 2 minutes of bans.
    const btn = best ?? offer.querySelector('.offerFoot button[data-i="3"]');
    if (!btn) return null;
    btn.click();
    return best ? 'relic: ' + RELIC_RANK[bestRank] : 'relic: left in the bag';
  },

  priority(G, enabled) {
    const cur = G.s.priority && G.s.priority.cur;
    const waitForAirtight = enabled.hammer && cur && cur.hits < cur.need &&
      cur.t / TICKS_PER_SEC > PRIORITY_MIN_SECONDS_LEFT;
    const eligible = !!cur && !cur.verdict && !waitForAirtight;
    if (!ready('priority:' + (cur ? cur.id : ''), eligible)) return null;
    const btn = usable(cur.guilty ? '#priorityBox .pBan' : '#priorityBox .pLegit');
    if (!btn) return null;
    btn.click();
    return cur.guilty ? 'priority: ban' : 'priority: legit';
  },

  tickets(G) {
    for (const inc of G.s.incidents) {
      if (inc.ticket && !inc.ticket.done) {
        if (!ready('ticket:' + inc.id, true)) continue;
        const btns = incidentCard(inc)?.querySelectorAll('.ticketBtn');
        const btn = btns && usable(btns[inc.ticket.answer]);
        if (btn) {
          btn.click();
          return 'ticket answered';
        }
      }
      if (inc.repair && inc.repair.hits < inc.repair.need) {
        if (!ready('repair:' + inc.id + ':' + inc.repair.hits, true)) continue;
        const lit = incidentCard(inc)?.querySelector('.repairBtn.lit');
        if (lit) {
          lit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          return 'repair hit';
        }
      }
    }
    return null;
  },

  weekend(G) {
    const inc = G.s.incidents.find(i => i.key === 'weekend' && i.choice && i.choice.chosen === undefined);
    if (!ready('weekend:' + (inc ? inc.id : ''), !!inc)) return null;
    const work = G.s.staff.burnout <= WEEKEND_WORK_MAX_BURNOUT;
    const btn = incidentCard(inc)?.querySelectorAll('.incBtn')[work ? 0 : 1];
    if (!usable(btn)) return null;
    btn.click();
    return work ? 'weekend: work' : 'weekend: off';
  },

  incidents(G, enabled, game) {
    for (const inc of G.s.incidents) {
      if (!inc.choice || inc.choice.chosen !== undefined) continue;
      const policy = INCIDENTS[inc.key];
      const pick = policy ? policy(inc, game) : null;
      if (pick === null || G.s.bans < inc.choice.costs[pick]) continue;
      if (!ready('incident:' + inc.id, true)) continue;
      const btn = incidentCard(inc)?.querySelectorAll('.incBtn')[pick];
      if (!usable(btn)) continue;
      btn.click();
      return `${inc.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
    }
    return null;
  },

  coffee(G) {
    const st = G.s.staff;
    const ok = st.burnout < COFFEE_MAX_BURNOUT && !st.week.weekend && st.lever.party <= 0;
    const btn = usable('#coffeeBtn');
    if (!ready('coffee', ok && !!btn)) return null;
    btn.click();
    return 'coffee run';
  },

  callHammer() {
    const btn = usable('#hammerBtn');
    if (!ready('callHammer', !!btn)) return null;
    btn.click();
    return 'called the hammer';
  },

  lever(G) {
    const btn = usable('#leverBtn');
    if (!ready('lever', !!btn && G.s.staff.burnout >= LEVER_AT_BURNOUT)) return null;
    btn.click();
    return 'pulled the lever';
  },

  coinLock(G) {
    const meta = G.s.meta && G.s.meta.cur;
    const btn = usable('#coinBtn');
    if (!ready('coin', !!btn && (meta === 'duping' || meta === 'economy'))) return null;
    btn.click();
    return 'coin-lock';
  },

  audit(G) {
    const truth = G.s.truth;
    const panel = document.querySelector('.auRows');
    const open = panel && !panel.closest('.hidden') && truth.audit && truth.audit.cases;
    if (open) {
      // Rows default to "keep banned"; clear the innocent ones, then submit.
      const rows = [...document.querySelectorAll('.auRow')];
      for (const row of rows) {
        const c = truth.audit.cases[+row.dataset.i];
        const clear = row.querySelector('button[data-v="1"]');
        if (c && !c.g && clear && !clear.classList.contains('on')) {
          if (!ready('audit-row:' + row.dataset.i, true)) return null;
          clear.click();
          return 'audit: cleared one';
        }
      }
      const submit = usable('.auSubmit');
      if (!ready('audit-submit', !!submit)) return null;
      submit.click();
      return 'audit submitted';
    }
    const btn = usable('#auditBtn');
    const pile = truth.pile;
    if (!ready('audit-start', !!btn && !(pile && pile.audited))) return null;
    btn.click();
    return 'audit started';
  },

  report(G) {
    const ratio = G.s.reality / Math.max(1, G.s.perception);
    const btn = usable('#repBtn');
    if (!ready('report', !!btn && ratio < CLEAN_REPORT_RATIO)) return null;
    btn.click();
    return 'transparency report';
  },

  // Launch at 100%. The wave bonus grows roughly linearly with charge while
  // holding raises the perception target and the odds of a bad verdict, so
  // this beats Agentic AI's 200% auto-launch too. Audit first only when an
  // audit is possible soon; early game (no Moderator) launches right away.
  banWaves(G, enabled) {
    const truth = G.s.truth;
    const pile = truth.pile;
    const btn = usable('#waveBtn');
    const charged = !!btn && G.s.waveMeter >= 1;
    const auditSoon = enabled.audit && G.s.buildings.moderator.amount > 0 &&
      !(pile && pile.audited) && truth.auditCd / TICKS_PER_SEC <= AUDIT_WAIT_SECONDS;
    if (!ready('wave', charged && !auditSoon)) return null;
    btn.click();
    return 'launched ban wave';
  },

  // Work the response cards in dependency order, fastest path, no playbook
  // (it voids the flawless bonus). Leadership first: it adds harm once the
  // duped gold passes 60.
  dupes(G, enabled, game) {
    const d = game.dupe;
    const room = document.querySelector('#dupeRoom');
    if (!d || !d.active || !room || room.classList.contains('hidden')) return null;
    const step = DUPE_ORDER.find(k => !d.done.includes(k));
    if (!step) return null;
    const logs = room.querySelectorAll('.drLogs .drLog');
    if (step === 'identify' && logs.length) {
      if (!ready('dupe-log', true, FAST_REACTION_MS)) return null;
      logs[d.answer]?.click();
      return 'dupe: picked log line';
    }
    // The COIN-LOCK card counts as done while the ability is active.
    const card = [...room.querySelectorAll('.drCard')].find(c => c.querySelector('b')?.textContent === DUPE_LABELS[step]);
    if (!usable(card) || !ready('dupe:' + step, true, FAST_REACTION_MS)) return null;
    card.click();
    return 'dupe: ' + step;
  },
};

// Banhammer clicker. The game accepts one click per tick and at most 20 per
// second, and flags more than 15 in a second as an auto-clicker. Every click
// is a recorded input, so stay well under that and stop when clicks stop
// mattering (late game, unless a priority case needs evidence).
const HAMMER_CPS = 8;
const HAMMER_MIN_SHARE = 0.01; // clicks must add at least 1% of passive income

function startHammer(game, getSettings) {
  const loop = () => {
    const settings = getSettings();
    if (settings.auto && settings.ops.hammer && hammerWorthwhile(game.G)) clickHammer();
    const jitter = 0.7 + Math.random() * 0.6;
    setTimeout(loop, (1000 / HAMMER_CPS) * jitter);
  };
  loop();
}

function hammerWorthwhile(G) {
  if (G.ascending) return false;
  const cur = G.s.priority && G.s.priority.cur;
  if (cur && !cur.verdict && cur.hits < cur.need) return true;
  return G.clickPower * HAMMER_CPS >= HAMMER_MIN_SHARE * G.bps;
}

function clickHammer() {
  const el = document.querySelector('#hammerHit');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = r.left + r.width * (0.35 + Math.random() * 0.3);
  const y = r.top + r.height * (0.35 + Math.random() * 0.3);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

// Worst-case heat of the wave currently charging, after the audit the
// automation would run. Shared by the notch controller and the stats log.
function projectedHeat(G, enabled) {
  const t = G.s.truth;
  if (!t.pile) return null;
  const innocentShare = t.pile.inn / Math.max(0.001, G.s.waveMeter);
  const auditing = enabled.audit && G.s.buildings.moderator.amount > 0 && !t.pile.audited;
  const scrub = auditing ? AUDIT_KEEPS : 1;
  return 100 * innocentShare * scrub * HEAT_WORST_ROLL * (1.3 - 0.6 * t.cred / 100);
}

let shimmerSeq = 0;
const shimmerIds = new WeakMap();
function shimmerKey(el) {
  if (!shimmerIds.has(el)) shimmerIds.set(el, ++shimmerSeq);
  return shimmerIds.get(el);
}

// Runs at most one action per call, in OPS order. Returns a log line or null.
function runOps(game, enabled) {
  const G = game.G;
  if (G.ascending) return null;
  for (const { key } of OPS) {
    if (!enabled[key]) continue;
    try {
      const did = ROUTINES[key](G, enabled, game);
      if (did) return did;
    } catch (e) {
      return `${key} error: ${e.message}`;
    }
  }
  return null;
}

// ---- src/stats.js ----
// Run telemetry for tuning the automation: wave verdicts with the conditions
// at launch, periodic snapshots, and action counts.
//
// Stored in IndexedDB, not localStorage: the game keeps its save and its
// leaderboard input log in localStorage, and running that out of quota marks
// the run ineligible.

const DB_NAME = 'onlybans-glider';
const STORE = 'kv';
const DOC = 'stats';
const SNAPSHOT_MS = 60000;
const PERSIST_MS = 30000;
const MAX_SNAPSHOTS = 2880; // two days at one a minute
const MAX_WAVES = 1000;
const MAX_RECENT_ACTIONS = 300;
const TIER_NAMES = ['CLEAN', 'APPEALS', 'TRENDING', 'FAMOUS FP', 'SCANDAL'];

function emptyStats() {
  return { started: Date.now(), snapshots: [], waves: [], actionCounts: {}, recentActions: [] };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

async function createStats() {
  let data = emptyStats();
  try {
    const saved = await idb('readonly', s => s.get(DOC));
    if (saved) data = { ...emptyStats(), ...saved };
  } catch {}

  let dirty = false;
  let lastSnapshot = 0;
  let pendingWave = null;

  const persist = () => {
    if (!dirty) return;
    dirty = false;
    idb('readwrite', s => s.put(data, DOC)).catch(() => {});
  };
  setInterval(persist, PERSIST_MS);
  window.addEventListener('pagehide', persist);

  function push(list, item, max) {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
    dirty = true;
  }

  return {
    action(line) {
      const kind = line.split(':')[0].replace(/\d+/g, '').trim();
      data.actionCounts[kind] = (data.actionCounts[kind] ?? 0) + 1;
      push(data.recentActions, { t: Date.now(), line }, MAX_RECENT_ACTIONS);
    },

    // Called about once a second.
    tick(G, projectedHeat) {
      const s = G.s;
      const t = s.truth;
      const now = Date.now();
      if (now - lastSnapshot >= SNAPSHOT_MS) {
        lastSnapshot = now;
        push(data.snapshots, {
          t: now, bps: G.bps, rawBps: G.rawBps, bans: s.bans,
          perception: s.perception, reality: s.reality, cred: t.cred,
          burnout: s.staff.burnout, notch: t.notch, meter: s.waveMeter, waves: s.wavesLaunched,
        }, MAX_SNAPSHOTS);
      }
      // A review exists from launch until the verdict lands.
      const review = t.review;
      if (review && !pendingWave) {
        pendingWave = {
          n: s.wavesLaunched, launchedAt: now, f: review.f, notch: t.notch, cred: t.cred,
          audited: !!(t.pile && t.pile.audited), projectedHeat,
          perception: s.perception, reality: s.reality,
        };
      }
      if (review && pendingWave) {
        pendingWave.tier = review.tier;
        pendingWave.heat = review.heat;
        pendingWave.innocent = review.inn;
      }
      if (!review && pendingWave) {
        pendingWave.landedAt = now;
        push(data.waves, pendingWave, MAX_WAVES);
        pendingWave = null;
      }
    },

    summary() {
      const counts = TIER_NAMES.map(() => 0);
      for (const w of data.waves) if (w.tier >= 0 && w.tier < counts.length) counts[w.tier]++;
      const recent = data.snapshots.slice(-10);
      const avgBps = recent.length ? recent.reduce((a, x) => a + x.bps, 0) / recent.length : 0;
      return { waves: data.waves.length, counts, avgBps, lastWave: data.waves[data.waves.length - 1] };
    },

    exportJson() {
      return JSON.stringify(data);
    },

    reset() {
      data = emptyStats();
      pendingWave = null;
      dirty = true;
      persist();
    },
  };
}

// ---- src/overlay.js ----
// Overlay panel: plan display, settings, and the automation toggles.

const SETTINGS_KEY = 'onlybans-glider-settings';
const HORIZONS = [
  ['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['12h', 43200], ['2d', 172800],
];
const DEFAULTS = {
  auto: false, horizon: 900, clicksPerSec: 0, depth: 3, beam: 5, collapsed: false,
  side: 'left', x: 12, y: 12, ops: {},
};
const LOG_LINES = 6;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...DEFAULTS, ...saved, ops: { ...OPS_DEFAULTS, ...(saved.ops ?? {}) } };
  } catch {
    return { ...DEFAULTS, ops: { ...OPS_DEFAULTS } };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

const CSS = `
#obh { position: fixed; z-index: 99999; width: min(340px, calc(100vw - 8px)); font: 12px/1.35 ui-monospace, Menlo, monospace;
  color: #e6ebff; background: rgba(10,13,24,.94); border: 2px solid #f5c542; border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,.6); }
#obh header { display: flex; gap: 6px; align-items: center; padding: 4px 6px; background: #f5c542;
  color: #111; cursor: move; user-select: none; font-weight: 700; }
#obh header span { flex: 1; }
#obh header button { all: unset; cursor: pointer; padding: 0 4px; font-weight: 700; }
#obh header button[data-act="auto"] { border: 1px solid #111; border-radius: 3px; font-size: 10px; }
#obh header button[data-act="auto"].on { background: #c62828; color: #fff; border-color: #c62828; }
#obh .body { padding: 6px 8px; max-height: 70vh; overflow: auto; }
#obh.collapsed .body { display: none; }
#obh .controls { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
#obh select, #obh input { background: #1a2036; color: #e6ebff; border: 1px solid #39425f; font: inherit; }
#obh input { width: 44px; }
#obh .next { font-size: 14px; padding: 6px; margin-bottom: 6px; background: #1d2a1a; border-left: 4px solid #6fdc6f; }
#obh .next b { color: #6fdc6f; }
#obh .muted { color: #8592b3; }
#obh table { width: 100%; border-collapse: collapse; margin-top: 4px; }
#obh th, #obh td { padding: 1px 3px; text-align: right; white-space: nowrap; }
#obh th:first-child, #obh td:first-child { text-align: left; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
#obh th { color: #8592b3; font-weight: 400; border-bottom: 1px solid #39425f; }
#obh h4 { margin: 8px 0 2px; color: #f5c542; font-size: 12px; }
#obh .err { color: #ff6b6b; white-space: pre-wrap; }
#obh details.ops { margin-bottom: 6px; border: 1px solid #39425f; padding: 2px 6px; }
#obh details.ops summary { cursor: pointer; color: #f5c542; }
#obh details.ops label { display: block; }
#obh details.ops input { width: auto; }
#obh .opsLog { color: #8592b3; margin-top: 4px; white-space: pre-wrap; }
#buildings .product.obh-pick { outline: 3px solid #6fdc6f; outline-offset: -3px; }
`;

function createOverlay({ onChange, onRefresh, onCopyStats, onResetStats }) {
  const settings = loadSettings();
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'obh';
  if (settings.collapsed) root.classList.add('collapsed');
  root.innerHTML = `
    <header><span>OnlyBans Glider</span>
      <button data-act="auto" title="Auto-buy the plan's buy-now list">AUTO</button>
      <button data-act="refresh" title="Replan now">⟳</button>
      <button data-act="collapse" title="Collapse">–</button></header>
    <div class="body">
      <div class="controls">
        <label>Horizon <select data-set="horizon">${HORIZONS.map(([l, v]) =>
          `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>Clicks/s <input data-set="clicksPerSec" type="number" min="0" max="20" step="1"></label>
        <label>Depth <input data-set="depth" type="number" min="1" max="5" step="1"></label>
      </div>
      <details class="ops"><summary>Automation (runs while AUTO is on)</summary>
        ${OPS.map(o => `<label><input type="checkbox" data-op="${o.key}"> ${esc(o.label)}</label>`).join('')}
        <div class="opsLog"></div>
      </details>
      <details class="ops"><summary>Stats</summary>
        <div class="statsBody muted">Collecting…</div>
        <div class="controls"><button data-act="copyStats">Copy JSON</button>
          <button data-act="resetStats">Reset</button></div>
      </details>
      <div class="content muted">Binding to game…</div>
    </div>`;
  document.body.appendChild(root);
  place(root, settings);
  window.addEventListener('resize', () => place(root, settings));

  for (const el of root.querySelectorAll('[data-op]')) {
    el.checked = !!settings.ops[el.dataset.op];
    el.addEventListener('change', () => {
      settings.ops[el.dataset.op] = el.checked;
      saveSettings(settings);
    });
  }

  for (const el of root.querySelectorAll('[data-set]')) {
    el.value = settings[el.dataset.set];
    el.addEventListener('change', () => {
      const n = Number(el.value);
      if (isFinite(n) && n >= 0) settings[el.dataset.set] = n;
      saveSettings(settings);
      onChange(settings);
    });
  }
  const autoBtn = root.querySelector('[data-act="auto"]');
  const paintAuto = () => autoBtn.classList.toggle('on', settings.auto);
  paintAuto();
  autoBtn.addEventListener('click', () => {
    settings.auto = !settings.auto;
    paintAuto();
    saveSettings(settings);
    onChange(settings);
  });
  root.querySelector('[data-act="refresh"]').addEventListener('click', () => onRefresh());
  const copyBtn = root.querySelector('[data-act="copyStats"]');
  copyBtn.addEventListener('click', async () => {
    try {
      await onCopyStats();
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 2000);
  });
  root.querySelector('[data-act="resetStats"]').addEventListener('click', () => {
    if (confirm('Clear all recorded stats?')) onResetStats();
  });
  root.querySelector('[data-act="collapse"]').addEventListener('click', () => {
    settings.collapsed = !settings.collapsed;
    root.classList.toggle('collapsed', settings.collapsed);
    saveSettings(settings);
  });
  makeDraggable(root, root.querySelector('header'), () => {
    // Anchor to the nearer edge so a window resize keeps the panel in view.
    const rect = root.getBoundingClientRect();
    if (rect.left + rect.width / 2 > window.innerWidth / 2) {
      settings.side = 'right';
      settings.x = window.innerWidth - rect.right;
    } else {
      settings.side = 'left';
      settings.x = rect.left;
    }
    settings.y = rect.top;
    place(root, settings);
    saveSettings(settings);
  });

  const content = root.querySelector('.content');
  const opsLog = root.querySelector('.opsLog');
  const statsBody = root.querySelector('.statsBody');
  const logLines = [];
  return {
    settings,
    render(html) {
      content.classList.remove('muted');
      content.innerHTML = html;
    },
    renderStats(html) {
      statsBody.classList.remove('muted');
      statsBody.innerHTML = html;
    },
    log(line) {
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      logLines.unshift(`${t} ${line}`);
      logLines.length = Math.min(logLines.length, LOG_LINES);
      opsLog.replaceChildren(...logLines.map(l => Object.assign(document.createElement('div'), { textContent: l })));
    },
  };
}

// Positions the panel from its saved edge offset, clamped inside the viewport.
function place(root, settings) {
  const maxX = Math.max(0, window.innerWidth - root.offsetWidth);
  const maxY = Math.max(0, window.innerHeight - 32);
  const x = Math.min(Math.max(0, settings.x), maxX);
  const y = Math.min(Math.max(0, settings.y), maxY);
  if (settings.side === 'right') {
    root.style.left = 'auto';
    root.style.right = x + 'px';
  } else {
    root.style.right = 'auto';
    root.style.left = x + 'px';
  }
  root.style.top = y + 'px';
}

function makeDraggable(el, handle, onDrop) {
  let start = null;
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const rect = el.getBoundingClientRect();
    el.style.right = 'auto';
    el.style.left = rect.left + 'px';
    start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!start) return;
    el.style.left = Math.max(0, e.clientX - start.x) + 'px';
    el.style.top = Math.max(0, e.clientY - start.y) + 'px';
  });
  handle.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    onDrop();
  });
}

function highlightBuilding(index) {
  for (const el of document.querySelectorAll('#buildings .product.obh-pick')) el.classList.remove('obh-pick');
  if (index === null) return;
  const row = document.querySelectorAll('#buildings .product')[index];
  if (row) row.classList.add('obh-pick');
}

function fmtNum(n) {
  if (!isFinite(n)) return '∞';
  if (Math.abs(n) < 1000) return n < 10 ? n.toFixed(1) : Math.round(n).toString();
  const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  if (Math.abs(n) >= Math.pow(1000, units.length + 1)) return n.toExponential(3);
  let i = -1;
  while (Math.abs(n) >= 1000) {
    n /= 1000;
    i++;
  }
  return n.toFixed(n < 10 ? 2 : 1) + units[i];
}

function fmtTime(sec) {
  if (!isFinite(sec)) return '∞';
  if (sec < 1) return 'now';
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm' + String(Math.round(sec % 60)).padStart(2, '0') + 's';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h' + String(Math.round((sec % 3600) / 60)).padStart(2, '0') + 'm';
  return (sec / 86400).toFixed(1) + 'd';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- src/auto.js ----
// Auto mode: executes the planner's buy-now steps by clicking the game's own
// store elements. Each click runs the same handler a human click does, so the
// purchase goes through the game's input recorder like any other input.

const MAX_CLICKS_PER_CYCLE = 15;
const CLICK_GAP_MS = [120, 260];

let busy = false;

// Returns the number of purchases made. Never overlaps itself.
async function autoBuy(game, path) {
  if (busy) return 0;
  busy = true;
  try {
    let clicks = 0;
    for (const step of path) {
      if (step.at > 0 || clicks >= MAX_CLICKS_PER_CYCLE || game.G.ascending) break;
      if (game.G.s.bans < step.price) break;
      let ok = false;
      if (step.item.type === 'building') ok = clickBuilding(game, step.item.def);
      else ok = clickUpgrade(game, step.item.def);
      if (!ok) break;
      clicks++;
      // The upgrade crates re-render after a purchase; wait for the next cycle.
      if (step.item.type === 'upgrade') break;
      await sleep(CLICK_GAP_MS[0] + Math.random() * (CLICK_GAP_MS[1] - CLICK_GAP_MS[0]));
    }
    return clicks;
  } finally {
    busy = false;
  }
}

function clickBuilding(game, def) {
  if (!ensureBuyOne()) return false;
  const row = document.querySelectorAll('#buildings .product')[def.index];
  if (!row || row.classList.contains('locked')) return false;
  row.click();
  return true;
}

// Crates are rendered for unlocked, unbought upgrades sorted by price. Rebuild
// that order and only click when the DOM matches it.
function clickUpgrade(game, def) {
  const { logic, G, upgrades } = game;
  const expected = upgrades
    .filter(u => G.s.upgradesUnlocked.has(u.id) && !G.s.upgradesBought.has(u.id))
    .sort((a, b) => logic.upgradePrice(a) - logic.upgradePrice(b));
  const crates = document.querySelectorAll('#upgrades .crate');
  const idx = expected.indexOf(def);
  if (idx < 0 || crates.length !== expected.length) return false;
  crates[idx].click();
  return true;
}

// The building rows buy whatever the Buy/Sell + quantity toggles say.
// Force Buy x1 so each click is exactly one planned purchase.
function ensureBuyOne() {
  for (const label of ['Buy', '1']) {
    const btn = [...document.querySelectorAll('#buyControls button')].find(b => b.textContent.trim() === label);
    if (!btn) return false;
    if (!btn.classList.contains('on')) btn.click();
  }
  const on = [...document.querySelectorAll('#buyControls button.on')].map(b => b.textContent.trim());
  return on.includes('Buy') && on.includes('1');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- src/main.js ----
// Entry point: wait for the game, bind to it, replan on a timer.

const REPLAN_MS = 2000;
const BUY_NOW_ROWS = 6;
const OPS_MS = 400;
const STATS_MS = 1000;

async function waitForGame() {
  for (let i = 0; i < 300; i++) {
    if (window.OnlyBans && window.OnlyBans.G && window.OnlyBans.G.s) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('window.OnlyBans never appeared (game changed or failed to load)');
}

async function start() {
  let game = null;
  const stats = await createStats();
  const ui = createOverlay({
    onChange: () => tick(),
    onRefresh: () => rebind(),
    onCopyStats: () => navigator.clipboard.writeText(stats.exportJson()),
    onResetStats: () => stats.reset(),
  });

  async function rebind() {
    try {
      await waitForGame();
      game = await bindGame(window);
      tick();
    } catch (e) {
      game = null;
      ui.render(`<div class="err">Bind failed: ${esc(e.message)}\nRun scripts/probe.mjs to see what changed.</div>`);
    }
  }

  let autoBought = 0;

  async function tick() {
    if (!game || game.G.ascending) return;
    // A hidden tab only matters for display; auto mode keeps buying.
    if (document.hidden && !ui.settings.auto) return;
    let result;
    try {
      result = render(game, ui, autoBought);
    } catch (e) {
      ui.render(`<div class="err">Planner error: ${esc(e.stack ?? e.message)}</div>`);
      return;
    }
    if (ui.settings.auto) autoBought += await autoBuy(game, result.path);
  }

  await rebind();
  setInterval(tick, REPLAN_MS);
  startHammer({ get G() { return game ? game.G : { ascending: true }; } }, () => ui.settings);
  setInterval(() => {
    if (!game || !ui.settings.auto) return;
    const did = runOps(game, ui.settings.ops);
    if (did) {
      ui.log(did);
      stats.action(did);
    }
  }, OPS_MS);
  // Stats record whether or not AUTO is on, so manual play can be compared.
  setInterval(() => {
    if (!game) return;
    stats.tick(game.G, projectedHeat(game.G, ui.settings.ops));
    ui.renderStats(statsHtml(stats.summary()));
  }, STATS_MS);
}

function statsHtml(sum) {
  const tiers = TIER_NAMES.map((name, i) => `${name} ${sum.counts[i]}`).join(' · ');
  let html = `<div>Waves: ${sum.waves} · ${tiers}</div>`;
  html += `<div>Avg income (last 10 min): ${fmtNum(sum.avgBps)}/s</div>`;
  const w = sum.lastWave;
  if (w) {
    html += `<div>Last wave #${w.n}: ${TIER_NAMES[w.tier] ?? '?'} · charge ${Math.round(w.f * 100)}%` +
      ` · notch ${w.notch} · ${w.audited ? 'audited' : 'not audited'}` +
      ` · heat ${w.heat?.toFixed(1)} (projected ${w.projectedHeat?.toFixed(1) ?? '?'})</div>`;
  }
  return html;
}

function render(game, ui, autoBought) {
  const { settings } = ui;
  const bank = game.G.s.bans;
  const t0 = performance.now();
  // While the hammer clicker runs, value click upgrades at its click rate.
  let clicksPerSec = settings.clicksPerSec;
  if (settings.auto && settings.ops.hammer) clicksPerSec = Math.max(clicksPerSec, HAMMER_CPS);
  const result = withSandbox(game, { clicksPerSec }, sim =>
    plan(sim, { bank, horizon: settings.horizon, depth: settings.depth, beam: settings.beam }));
  const ms = performance.now() - t0;

  const steps = groupSteps(result.path, itemKey);
  const first = steps[0];
  highlightBuilding(first && first.item.type === 'building' ? first.item.def.index : null);

  const buyNow = summarizeBuyNow(result.path);
  let html = '';
  if (!first) {
    html += result.rate > 0
      ? `<div class="next">Nothing pays back within this horizon. <b>Save.</b></div>`
      : `<div class="next">No income yet. <b>Click the banhammer.</b></div>`;
  } else if (buyNow.length) {
    const total = buyNow.reduce((sum, b) => sum + b.price, 0);
    const biggest = [...buyNow].sort((a, b) => b.price - a.price).slice(0, BUY_NOW_ROWS);
    html += `<div class="next">Buy now (${fmtNum(total)} bans):`;
    for (const b of biggest) {
      html += `<div><b>${esc(itemLabel(b.item))}</b> ×${b.count} <span class="muted">${fmtNum(b.price)}</span></div>`;
    }
    if (buyNow.length > biggest.length) {
      html += `<div class="muted">+${buyNow.length - biggest.length} cheaper items</div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="next">Next: <b>${esc(itemLabel(first.item))}</b>${first.count > 1 ? ' ×' + first.count : ''}
      <div class="muted">${fmtNum(first.price)} bans · ${first.at < 1 ? 'buy now' : 'in ' + fmtTime(first.at)}
      · +${fmtNum(first.gain)}/s</div></div>`;
  }

  // Buy-now steps are summarized above; the path table shows what comes after.
  const later = buyNow.length ? steps.filter(s => s.at > 0) : steps.slice(1);
  if (later.length) {
    html += `<h4>Then</h4><table><tr><th>Buy</th><th>at</th><th>rate after</th></tr>`;
    for (const s of later) {
      html += `<tr><td>${esc(itemLabel(s.item))}${s.count > 1 ? ' ×' + s.count : ''}</td>
        <td>${fmtTime(s.at)}</td><td>${fmtNum(s.rateAfter)}/s</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<h4>Best single buys</h4><table><tr><th>Item</th><th>cost</th><th>+/s</th><th>payback</th><th>wait</th></tr>`;
  for (const c of result.candidates.slice(0, 8)) {
    html += `<tr><td title="${esc(c.item.def.name)}">${esc(itemLabel(c.item))}</td><td>${fmtNum(c.price)}</td>
      <td>${fmtNum(c.gain)}</td><td>${fmtTime(c.payback)}</td><td>${fmtTime(c.wait)}</td></tr>`;
  }
  html += `</table>`;

  const special = specialUpgrades(game);
  if (special.length) {
    html += `<h4>Not planned (arms race)</h4>`;
    html += special.map(u => `<div>${esc(iconText(u.icon))} ${esc(u.name)}</div>`).join('');
  }

  html += `<div class="muted" style="margin-top:6px">rate ${fmtNum(result.rate)}/s (no buffs) · bank ${fmtNum(bank)}
    · ${ms.toFixed(0)}ms · ${esc(game.build)}</div>`;
  if (settings.auto) html += `<div class="muted">auto: ${autoBought} bought this session</div>`;
  ui.render(html);
  return result;
}

// Everything affordable right now, merged per item, in first-purchase order.
function summarizeBuyNow(path) {
  const byKey = new Map();
  for (const s of path) {
    if (s.at > 0) break;
    const k = itemKey(s.item);
    const entry = byKey.get(k) ?? { item: s.item, count: 0, price: 0 };
    entry.count++;
    entry.price += s.price;
    byKey.set(k, entry);
  }
  return [...byKey.values()];
}

start();
})();
