// ==UserScript==
// @name         OnlyBans Glider
// @namespace    onlybans-glider
// @version      0.20.8
// @description  Purchase planner and automation for onlybans.wtf
// @match        *://onlybans.wtf/*
// @match        *://*.onlybans.wtf/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
'use strict';
const ANALYZED_BUILD = 'index-B688DHuD.js';
const VERSION = '0.20.8';

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
// An item may be a bundle ({ type: 'bundle', parts: [...] }): several
// purchases valued and applied as one move (e.g. "buy 18 more of X so its
// next ×2 upgrade unlocks, then buy that upgrade"). sim.apply/undo/price
// handle bundles; this file only needs to know how to execute them.
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
  // A bundle that isn't affordable yet is still worth working toward: buy its
  // next part now if that part is affordable (the rest stays ranked next time).
  const nowSteps = [];
  let nowBank = bank;
  let applied = 0;
  try {
    let top = ranked[0];
    while (top && top.payback < 2 * horizon && nowSteps.length < MAX_NOW_BUYS) {
      let parts = [top.item];
      if (top.item.type === 'bundle') parts = top.wait === 0 ? top.item.parts : top.item.parts.slice(0, 1);
      else if (top.wait > 0) break;
      const rateBefore = sim.rate();
      let bought = 0;
      for (const part of parts) {
        const price = sim.price(part);
        if (price > nowBank) break;
        sim.apply(part);
        applied++;
        bought++;
        nowBank -= price;
        nowSteps.push({ item: part, price, at: 0, gain: 0, rateAfter: 0, via: top.item.label });
      }
      if (!bought) break;
      const rateAfter = sim.rate();
      const last = nowSteps[nowSteps.length - 1];
      last.gain = rateAfter - rateBefore;
      last.rateAfter = rateAfter;
      top = rankCandidates(sim, { t: 0, bank: nowBank, rate: rateAfter }, horizon)[0];
    }
    const ahead = lookahead(sim, nowBank, horizon, depth, beam);
    return { rate: rateStart, path: [...nowSteps, ...ahead.flatMap(expandStep)], candidates: ranked };
  } finally {
    for (let i = 0; i < applied; i++) sim.undo();
  }
}

// Lookahead steps can be bundles; show and execute them as their parts.
function expandStep(step) {
  if (step.item.type !== 'bundle') return [step];
  return step.item.parts.map((part, i) => ({
    ...step,
    item: part,
    via: step.item.label,
    price: i === 0 ? step.price : 0,
    gain: i === step.item.parts.length - 1 ? step.gain : 0,
  }));
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
  let relics = null;
  for (const val of Object.values(mod)) {
    if (val && typeof val === 'object' && typeof val.calculateGains === 'function' && val.G) logic = val;
    // Dupe-outbreak minigame state: optional, automation skips it if absent.
    if (val && typeof val === 'object' && 'answer' in val && Array.isArray(val.deck) && Array.isArray(val.done)) dupe = val;
    // Relic state (owned list, counters, current offer): optional.
    if (val && typeof val === 'object' && Array.isArray(val.owned) && 'ctr' in val && 'offer' in val) relics = val;
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

  return { logic, G: logic.G, buildings, upgrades, dupe, relics, build: script.src.split('/').pop() };
}

// The game's calculateGains() rewrites its derived production numbers. The
// game only refreshes them about once a second, and every tick in between
// earns with the old ones, so recomputing them mid-second changes what this
// browser earns versus the leaderboard server's replay of the same inputs.
// That float-level drift compounds once the server rejects a purchase this
// browser could just afford. So every live calculation here restores the
// derived numbers exactly as they were.
const DERIVED_FIELDS = ['bps', 'rawBps', 'globalMult', 'clickPower', 'trust', 'recalc'];

function saveDerived(G) {
  const saved = { each: { ...G.buildingEach } };
  for (const k of DERIVED_FIELDS) saved[k] = G[k];
  return saved;
}

function restoreDerived(G, saved) {
  for (const k of DERIVED_FIELDS) G[k] = saved[k];
  for (const k of Object.keys(G.buildingEach)) {
    if (k in saved.each) G.buildingEach[k] = saved.each[k];
    else delete G.buildingEach[k];
  }
}

// Runs fn(sim) with the live state temporarily mutated, then restores it.
// Synchronous on purpose: the game loop cannot interleave with us.
// Bundles look this many units ahead for a department's next unlock.
const BUNDLE_MAX_UNITS = 60;

function withSandbox(game, { clicksPerSec = 0, bundles = true } = {}, fn) {
  const { logic, G, buildings, upgrades } = game;
  const s = G.s;
  const savedBuffs = s.buffs;
  const derived = saveDerived(G);
  const undoStack = [];
  // Temporary buffs are excluded so advice doesn't swing during golden events.
  s.buffs = [];
  // Upgrades tied to one department (tier doublers, synergies), by building.
  const byBuilding = new Map();
  for (const def of upgrades) {
    if (!def.building || SPECIAL_KINDS.has(def.kind)) continue;
    if (!byBuilding.has(def.building)) byBuilding.set(def.building, []);
    byBuilding.get(def.building).push(def);
  }
  const bundleCache = new Map();

  // "Buy k more of this department, then the upgrades that unlocks": found
  // by probing each upgrade's own unlock condition at higher counts, so the
  // thresholds (1, 5, 25, 50, ... and 15 for synergies) come from the game.
  function bundleFor(def) {
    const owned = s.buildings[def.id].amount;
    const key = def.id + ':' + owned + ':' + s.upgradesBought.size;
    if (bundleCache.has(key)) return bundleCache.get(key);
    let result = null;
    const ctx = logic.ctx();
    const locked = (byBuilding.get(def.id) ?? []).filter(u =>
      !s.upgradesBought.has(u.id) && !s.upgradesUnlocked.has(u.id) && !safeUnlock(u, ctx));
    for (let n = owned + 2; locked.length && n <= owned + BUNDLE_MAX_UNITS; n++) {
      const probe = { ...ctx, owned: id => (id === def.id ? n : ctx.owned(id)) };
      const opens = locked.filter(u => safeUnlock(u, probe));
      if (!opens.length) continue;
      const parts = [];
      for (let i = owned; i < n; i++) parts.push({ type: 'building', def });
      for (const u of opens) parts.push({ type: 'upgrade', def: u });
      result = {
        type: 'bundle', parts, def,
        label: `${def.name} ×${n - owned} → ${opens.map(u => u.name).join(', ')}`,
      };
      break;
    }
    bundleCache.set(key, result);
    return result;
  }

  const sim = {
    rate() {
      logic.calculateGains();
      return (G.rawBps + clicksPerSec * G.clickPower) * (1 + goldenShare(s) + waveShare(s));
    },
    price(item) {
      if (item.type === 'building') return logic.buildingPrice(item.def.id, 1);
      if (item.type === 'bundle') {
        let total = 0;
        for (const part of item.parts) {
          total += sim.price(part);
          sim.apply(part);
        }
        for (let i = 0; i < item.parts.length; i++) sim.undo();
        return total;
      }
      return logic.upgradePrice(item.def);
    },
    apply(item) {
      if (item.type === 'bundle') {
        const mark = undoStack.length;
        for (const part of item.parts) sim.apply(part);
        const undos = undoStack.splice(mark).reverse();
        undoStack.push(() => { for (const u of undos) u(); });
      } else if (item.type === 'building') {
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
      const visible = buildings.filter(def => buildingVisible(def, s));
      const out = visible.map(def => ({ type: 'building', def }));
      const ctx = logic.ctx();
      for (const def of upgrades) {
        if (SPECIAL_KINDS.has(def.kind)) continue;
        if (s.upgradesBought.has(def.id)) continue;
        if (!s.upgradesUnlocked.has(def.id) && !safeUnlock(def, ctx)) continue;
        out.push({ type: 'upgrade', def });
      }
      if (bundles) {
        for (const def of visible) {
          const b = bundleFor(def);
          if (b) out.push(b);
        }
      }
      return out;
    },
  };

  try {
    return fn(sim);
  } finally {
    while (undoStack.length) undoStack.pop()();
    s.buffs = savedBuffs;
    restoreDerived(G, derived);
  }
}

// Mirrors the store's rule for showing a building row as buyable rather than
// "???". Locked rows have no click handler, so they can't be purchased.
function buildingVisible(def, s) {
  const b = s.buildings[def.id];
  return def.index === 0 || b.amount > 0 || b.highest > 0 || s.bansEarned >= def.baseCost;
}

// Average income from clicking every golden report, as a fraction of
// production. From the game's spawn timer and outcome pools (stationary
// outcome mix estimated by simulation; bustedProvider assumes a bank of
// ~50 min of production):
//   - mean gap between reports: 446.6 s, halved by event:0 and by event:1
//   - expected payout per normal report: 455 s of production; 707 s when
//     event:2 doubles buff durations
//   - red ("wrath") reports: 721 s (1267 s with event:2); a report is red
//     with chance armsStage/3
const GOLDEN_GAP_SECONDS = 446.6;
const GOLDEN_EV = { normal: 455, wrath: 721 };
const GOLDEN_EV_LONG_BUFFS = { normal: 707, wrath: 1267 };

function goldenShare(s) {
  const owns = id => s.upgradesBought.has(id);
  let gap = GOLDEN_GAP_SECONDS;
  if (owns('event:0')) gap *= 0.5;
  if (owns('event:1')) gap *= 0.5;
  let ev = GOLDEN_EV;
  if (owns('event:2')) ev = GOLDEN_EV_LONG_BUFFS;
  const w = armsStage(s) / 3;
  return ((1 - w) * ev.normal + w * ev.wrath) / gap;
}

// Average income from launching every ban wave at WAVE_LAUNCH_AT: the wave
// runs ×round(3 + 1.5 × (meter − 1)) for 30 s; 100% of meter fills in
// 240/(1 + 0.04 × departments) s, 30% faster with the Dashboard tool.
function waveShare(s) {
  let depts = 0;
  for (const b of Object.values(s.buildings)) if (b.amount > 0) depts++;
  let fill = 240 / (1 + 0.04 * depts);
  if (s.upgradesBought.has('tool:dashboard')) fill /= 1.3;
  const mult = Math.round(3 + 1.5 * (WAVE_LAUNCH_AT - 1));
  return ((mult - 1) * 30) / (WAVE_LAUNCH_AT * fill);
}

function armsStage(s) {
  const ar = s.armsRace;
  if (!ar || ar.detente || ar.truceT > 0) return 0;
  return ar.stage;
}

// Unlocked, unbought upgrades that add nothing to production as calculated
// (golden report frequency, audit tools, etc.). The planner can't value
// these, so they're bought by a price rule instead (see auto.js).
function utilityUpgrades(game, opts) {
  const s = game.G.s;
  return withSandbox(game, { ...opts, bundles: false }, sim => {
    const base = sim.rate();
    const out = [];
    for (const def of game.upgrades) {
      if (SPECIAL_KINDS.has(def.kind) || !s.upgradesUnlocked.has(def.id) || s.upgradesBought.has(def.id)) continue;
      const item = { type: 'upgrade', def };
      sim.apply(item);
      const gain = sim.rate() - base;
      sim.undo();
      if (!(gain > base * 1e-9)) out.push({ def, price: game.logic.upgradePrice(def) });
    }
    return out.sort((a, b) => a.price - b.price);
  });
}

// Bans/sec regained if the given buff (e.g. a stopped department) ended now.
// Measured with the game's own calculateGains, then state is restored.
function buffCost(game, buffKey) {
  const { logic, G } = game;
  const s = G.s;
  const saved = s.buffs;
  const buff = saved.find(b => b.key === buffKey);
  if (!buff) return 0;
  const derived = saveDerived(G);
  try {
    s.buffs = saved.filter(b => b !== buff);
    logic.calculateGains();
    const without = G.bps;
    s.buffs = saved;
    logic.calculateGains();
    return Math.max(0, without - G.bps);
  } finally {
    s.buffs = saved;
    restoreDerived(G, derived);
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
  if (item.type === 'bundle') return `${iconText(item.def.icon)} ${item.label}`.trim();
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

// ---- src/input.js ----
// Every click the automation makes goes through here. With "Anti anti-cheat"
// on (settings.stealth, the default) it only clicks what a person could: the
// point clicked must show the target itself, not a pop-up or anything else
// above it. The same setting turns on the human pacing elsewhere (reaction
// delays in ops.js, hammer bursts, gaps between purchases in auto.js).
//
// None of this can make an event trusted: script-made events always carry
// isTrusted === false. The game doesn't check it today (scripts/fetch.sh
// warns if a new build starts to).

let getInputSettings = () => ({ stealth: true });

function bindInputSettings(getSettings) {
  getInputSettings = getSettings;
}

function humanMode() {
  return getInputSettings().stealth !== false;
}

// The simulator runs the game in jsdom, which has no layout; it sets
// window.__noLayout so clicks skip the hit-test there.
function canHitTest() {
  return !window.__noLayout && typeof document.elementsFromPoint === 'function';
}

// The topmost element at a viewport point, ignoring this script's own panel
// (the game can't see it, and a person would just move it).
function topmostAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!el.closest('#obh')) return el;
  }
  return null;
}

// Where to click el: the given point, or its center. Null when a person
// couldn't click it there (human mode only): no box, off screen, or covered.
function clickPoint(el, x, y) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  const px = x ?? r.left + r.width / 2;
  const py = y ?? r.top + r.height / 2;
  if (!humanMode() || !canHitTest()) return { x: px, y: py };
  if (!r.width || !r.height) return null;
  if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) return null;
  const top = topmostAt(px, py);
  if (!top || !(top === el || el.contains(top))) return null;
  return { x: px, y: py };
}

// Scrolls el into view first in human mode (a person scrolls to a store row
// before clicking it).
function reveal(el) {
  if (el && humanMode() && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

// Returns false, without clicking, when the click is blocked.
function click(el) {
  if (!clickPoint(el)) return false;
  el.click();
  return true;
}

// Pointerdown at a viewport point on whichever of `targets` a person would
// hit there (e.g. the evader canvas or the hammer's hit area above it; the
// game hit-tests evaders from both). Outside human mode, targets[0].
function pointerDownAt(x, y, targets) {
  let el = targets[0];
  if (humanMode() && canHitTest()) {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const top = topmostAt(x, y);
    el = top && targets.find(t => t && (t === top || t.contains(top)));
    if (!el) return false;
  }
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return true;
}

// For elements that listen to pointerdown only (hammer, shimmers, repairs,
// the evader canvas). x/y default to the element's center.
function pointerDown(el, x, y) {
  const p = clickPoint(el, x, y);
  if (!p) return false;
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));
  return true;
}

// ---- src/ops.js ----
// Automation for everything besides purchases. Every action is a click on the
// game's own UI, so it runs the same recorded handler a human click does.
// In human mode (src/input.js) each routine waits a random reaction delay
// after its target becomes actionable, and only clicks what is not covered.

const OPS = [
  { key: 'hammer', label: 'Click the banhammer (stops when clicks are negligible)' },
  { key: 'pizza', label: 'Pizza party (feed everyone)' },
  { key: 'popups', label: 'Close pop-ups (judgment scroll, blue screen, welcome, field trip)' },
  { key: 'streamer', label: 'Streamer minigames (speedrun, react, launch)' },
  { key: 'region', label: 'Wrong region: pick the right flag' },
  { key: 'legends', label: 'Legends (ZABURUFF, BENZON, crew)' },
  { key: 'bugs', label: 'Squash crawling bugs' },
  { key: 'evaders', label: 'Pop ban evaders' },
  { key: 'weird', label: 'Weird events (coup, strike, you are banned)' },
  { key: 'notch', label: 'Strictness notch (loosest that stays safe)' },
  { key: 'shimmers', label: 'Click bonus objects (incl. red reports: higher EV)' },
  { key: 'clip', label: 'Clip it! (live cheater stream)' },
  { key: 'relics', label: 'Evidence Seized: pick a relic' },
  { key: 'priority', label: 'Priority cases' },
  { key: 'tickets', label: 'Tickets & repairs' },
  { key: 'weekend', label: 'Weekends (work unless burnout high)' },
  { key: 'incidents', label: 'Other incidents (pay when it pays off)' },
  { key: 'coffee', label: 'Coffee run' },
  { key: 'callHammer', label: 'Call the Hammer' },
  { key: 'lever', label: 'Pull the Lever (when ready; near-full burnout with the Thermos)' },
  { key: 'coinLock', label: 'Coin-Lock during dupe/economy meta' },
  { key: 'audit', label: 'Audits' },
  { key: 'report', label: 'Transparency reports (clean only)' },
  { key: 'dupes', label: 'Dupe outbreaks' },
  { key: 'banWaves', label: 'Ban waves (hold to 267%, audit first when possible)' },
];

const OPS_DEFAULTS = Object.fromEntries(OPS.map(o => [o.key, o.default ?? true]));

// Tunables. Burnout is 0..100; humans lose burnout/200 of output.
const COFFEE_MAX_BURNOUT = 40; // the game's own "suggest" threshold
const WEEKEND_WORK_MAX_BURNOUT = 50; // crunch adds +20; stay under the 70 "hot" line
// Without the Thermos, pull whenever ready: the 900 s cooldown limits pulls,
// and each one trades 45 s of humans for 120 s of humans ×2 plus a burnout
// reset (read from code; untested in the simulator, where every seed owns
// the Thermos before the Lever unlocks).
const LEVER_AT_BURNOUT = 0;
const THERMOS_LEVER_AT = 95; // Thermos: tech ×(3 + burnout/10) during the party

function hasRelic(game, id) {
  return !!(game && game.relics && game.relics.owned.includes(id));
}

// Thermos strategy: let burnout climb (always work weekends, coffee whenever)
// and hold the Lever until burnout is near full. Simulated at about +32% vs
// the normal thresholds with the Thermos owned (3 seeds, 2 game-hours).
function thermosCrunch(game) {
  return hasRelic(game, 'thermos');
}

function kernelPanic(G) {
  return !!(G.s.weird && G.s.weird.key === 'kernelPanic');
}
const CLEAN_REPORT_RATIO = 0.35; // reality/perception below this = clean verdict
const REACTION_MS = [600, 2200];
const FAST_REACTION_MS = [250, 700]; // short-window prompts (clip it)
// A priority case pays double when "airtight" (enough hammer clicks seen).
// Hold the verdict for that while the hammer clicker runs, unless time is short.
const PRIORITY_MIN_SECONDS_LEFT = 2.5;
const TICKS_PER_SEC = 30;

// Relic preference given what this script automates. Golden reports are
// worth ~100% of production, so doubling them (glider monitors) is best.
// Evaders are popped within seconds, so the mustache bin's extra siphon
// never lands and each pop spawns a free golden report. The lunchbox fixes
// golden reports at 242 s and ignores the golden upgrades, so it loses once
// Anonymous Tip Line is owned. Priority cases are always ruled correctly, so
// the cat and little brother rarely trigger. Never offered here: pager,
// sharpie, loaded die (cursed/contraband come from other sources).
const RELIC_RANK = ['gliderMonitors', 'mustacheBin', 'thermos', 'ringLight', 'noteJar', 'lunchbox', 'tally', 'phil', 'cat', 'littleBrother'];
const RELIC_RANK_WITH_TIP_LINE = RELIC_RANK.filter(id => id !== 'lunchbox');
const RELIC_NAMES = {
  'The Glider Dev\'s Two 27" Monitors': 'gliderMonitors',
  'Bin of Confiscated Fake Mustaches': 'mustacheBin',
  'Jar of "pls unban" Notes': 'noteJar',
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
// perception, so keep the worst-case roll under 15 with margin: a wave that
// landed at heat 10 could have rolled up to 10 × 1.3 / 0.7 ≈ 18 on bad luck.
const NOTCH_HEAT_HIGH = 10;
const NOTCH_HEAT_LOW = 4;
const HEAT_WORST_ROLL = 1.3;
const AUDIT_KEEPS = 0.3; // a 5/5 audit scrubs about 75% of innocents
const notchState = { pending: false, lastHeat: 0, lastTier: 0 };

// An audit only scrubs innocents already in the pile, so run it just before
// launch. (Run at ~25% charge, it left 4-27% innocents in waves, 3 of 9
// TRENDING.) Launch waits for it when an audit is close.
const AUDIT_AT_METER = 0.85; // fraction of the launch point

// Wave meter level to launch at (1 = 100%). The multiplier is
// round(3 + 1.5 × (meter − 1)), so ×6 from 267% (read from code). Simulated
// 100/134/200/267%: 267% won on all 3 seeds, about 4.7× bans vs 100%
// (2 game-hours, 2026-10-15). Hidden knob ops.waveAt for further tests.
const WAVE_LAUNCH_AT = 2.67;
function waveLaunchAt(enabled) {
  return enabled.waveAt ?? WAVE_LAUNCH_AT;
}

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
// Outside human mode (Anti anti-cheat off) there is no delay.
function ready(key, eligible, range = REACTION_MS) {
  if (!eligible || !humanMode()) {
    since.delete(key);
    delays.delete(key);
    return eligible;
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
    for (const el of document.querySelectorAll('#shimmers .shimmer')) {
      if (ready('shimmer:' + shimmerKey(el), true)) {
        // Shimmers listen for pointerdown only.
        if (!pointerDown(el)) return null;
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
      // The result card stays un-hidden inside the overlay after closing, so
      // check that nothing above the button is hidden.
      const done = document.querySelector('.pzResult .pzDone');
      if (!ready('pizza-done', !!done && !done.closest('.hidden'))) return null;
      if (!click(done)) return null;
      return 'pizza: back to banning';
    }
    if (!ready('pizza:' + p.fed + ':' + p.cuts + ':' + p.opened, true, PIZZA_REACTION_MS)) return null;
    let seat = p.want.findIndex(w => w > 0);
    if (seat >= 0 && p.slices <= 0) seat = -1;
    if (seat < 0 && p.sodas > 0) seat = p.soda.findIndex(n => n > 0);
    if (seat >= 0) {
      const el = document.querySelector(`.pzTable .pzSeat[data-i="${seat}"]`);
      if (el) {
        if (!click(el)) return null;
        return `pizza: fed ${p.fed + 1}/36`;
      }
    }
    const pizza = p.pcuts.findIndex(c => c < PIZZA_CUTS_EACH);
    if (pizza >= 0 && p.slices <= 0) {
      if (!click(document.querySelectorAll('.pzPizza')[pizza])) return null;
      return 'pizza: cut';
    }
    if (p.opened < p.want.length) {
      if (!click(document.querySelector('.pzCooler'))) return null;
      return 'pizza: soda';
    }
    if (pizza >= 0) click(document.querySelectorAll('.pzPizza')[pizza]);
    return null;
  },

  // Wave launch alarm: the right region is in state; each wrong flag adds
  // innocents to the pending wave and Perception +2.
  region(G) {
    const reg = G.s.truth.region;
    const flag = reg ? document.querySelector(`#regionRoom .rgFlag[data-r="${reg.ans}"]`) : null;
    if (!ready('region', !!flag, FAST_REACTION_MS)) return null;
    if (!click(flag)) return null;
    return 'region: picked the right flag';
  },

  legends() {
    const el = usable('#zaburuff') ?? usable('#benzon') ??
      [...document.querySelectorAll('.crewLegend')].find(e => usable(e));
    if (!ready('legend:' + (el ? el.id || el.className : ''), !!el)) return null;
    if (!click(el)) return null;
    return 'legend: ' + (el.id || el.title.split(',')[0]);
  },

  bugs() {
    const bug = document.querySelector('#bugLayer .crawlBug');
    if (!ready('bug', !!bug, FAST_REACTION_MS)) return null;
    if (!click(bug)) return null;
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
    const x = rect.left + cx + Math.cos(ev.angle) * dist;
    const y = rect.top + cy + Math.sin(ev.angle) * dist;
    if (!pointerDownAt(x, y, [canvas, document.querySelector('#hammerHit')])) return null;
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
    if (!click(btn)) return null;
    return `${wd.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
  },

  streamer(G) {
    const wd = G.s.weird;
    if (!wd || !wd.x) return null;
    if (wd.key === 'banSpeedrun') {
      // Each alt is clickable for 2.4 s; 8 bans in 50 s wins.
      const alt = document.querySelector('.lcMsgs .lcAlt.active');
      if (!ready('speedrun:' + wd.x[0], !!alt, FAST_REACTION_MS)) return null;
      if (!click(alt)) return null;
      return 'speedrun: banned an alt';
    }
    if (wd.key === 'devsReact') {
      // The good clip's index is wd.x[1]; each poll is open 10 s.
      const btn = wd.v > 0 ? usable(`.lcCtl button[data-arg="${wd.x[1]}"]`) : null;
      if (!ready('react:' + wd.x[0], !!btn)) return null;
      if (!click(btn)) return null;
      return 'devs react: picked the good clip';
    }
    if (wd.key === 'cheatLaunch') {
      // The stream's end tick is pre-rolled in wd.x[1]; payout grows with
      // buyers, so drop the wave just before it ends.
      const left = (wd.x[1] - wd.x[0]) / TICKS_PER_SEC;
      const btn = wd.v === 0 && left <= LAUNCH_DROP_SECONDS ? usable('.lcCtl button[data-arg]') : null;
      if (!ready('launch', !!btn, [30, 120])) return null;
      if (!click(btn)) return null;
      return `cheat launch: dropped with ${Math.floor(wd.n)} buyers`;
    }
    return null;
  },

  // Looser notch = meter fills faster (more ×3+ waves per hour) but adds more
  // innocents, which raise the wave's heat and risk a bad verdict. The pile's
  // innocent share is too noisy to steer on mid-fill (it measured 0.2 to 40
  // within a minute), so steer on outcomes: one step per landed verdict.
  // Stricter after heat above NOTCH_HEAT_HIGH, looser after heat below
  // NOTCH_HEAT_LOW.
  notch(G) {
    const review = G.s.truth.review;
    if (review) {
      notchState.lastHeat = review.heat;
      notchState.lastTier = review.tier;
      notchState.pending = true;
      return null;
    }
    if (!notchState.pending) return null;
    let dir = 0;
    if (notchState.lastTier >= 2 || notchState.lastHeat > NOTCH_HEAT_HIGH) dir = -1;
    else if (notchState.lastHeat < NOTCH_HEAT_LOW) dir = 1;
    let btn = null;
    if (dir < 0) btn = usable('#nPrev');
    if (dir > 0) btn = usable('#nNext');
    if (!btn) {
      notchState.pending = false;
      return null;
    }
    if (!ready('notch', true)) return null;
    if (!click(btn)) return null;
    notchState.pending = false;
    return `notch ${dir < 0 ? 'stricter' : 'looser'} (last wave heat ${notchState.lastHeat.toFixed(1)})`;
  },

  // The hammer clicker runs on its own faster loop (startHammer); nothing here.
  hammer() {
    return null;
  },

  clip(G) {
    const live = G.s.weird && G.s.weird.key === 'caughtLive';
    const btn = live ? usable('.liveChat .lcClip.ready') : null;
    if (!ready('clip', !!btn, FAST_REACTION_MS)) return null;
    if (!click(btn)) return null;
    return 'clipped it';
  },

  relics(G) {
    const offer = document.querySelector('#relicOffer');
    const open = !!offer && !offer.classList.contains('hidden') && !!offer.querySelector('.offerCards');
    if (!ready('relic', open)) return null;
    let order = RELIC_RANK;
    if (G.s.upgradesBought.has('event:0')) order = RELIC_RANK_WITH_TIP_LINE;
    let best = null;
    let bestRank = Infinity;
    const offered = [];
    for (const card of offer.querySelectorAll('.offerCard')) {
      const name = card.querySelector('.offerName')?.textContent.trim() ?? '?';
      offered.push(name);
      const rank = order.indexOf(RELIC_NAMES[name]);
      if (rank >= 0 && rank < bestRank) {
        best = card;
        bestRank = rank;
      }
    }
    // Nothing worth taking: leave it in the bag for 2 minutes of bans.
    const btn = best ?? offer.querySelector('.offerFoot button[data-i="3"]');
    if (!btn) return null;
    if (!click(btn)) return null;
    if (best) return 'relic: ' + order[bestRank];
    return 'relic: left in the bag (offered: ' + offered.join(', ') + ')';
  },

  priority(G, enabled) {
    const cur = G.s.priority && G.s.priority.cur;
    const waitForAirtight = enabled.hammer && cur && cur.hits < cur.need &&
      cur.t / TICKS_PER_SEC > PRIORITY_MIN_SECONDS_LEFT;
    const eligible = !!cur && !cur.verdict && !waitForAirtight;
    if (!ready('priority:' + (cur ? cur.id : ''), eligible)) return null;
    const btn = usable(cur.guilty ? '#priorityBox .pBan' : '#priorityBox .pLegit');
    if (!btn) return null;
    if (!click(btn)) return null;
    return cur.guilty ? 'priority: ban' : 'priority: legit';
  },

  tickets(G) {
    for (const inc of G.s.incidents) {
      if (inc.ticket && !inc.ticket.done) {
        if (!ready('ticket:' + inc.id, true)) continue;
        const btns = incidentCard(inc)?.querySelectorAll('.ticketBtn');
        const btn = btns && usable(btns[inc.ticket.answer]);
        if (btn) {
          if (!click(btn)) return null;
          return 'ticket answered';
        }
      }
      if (inc.repair && inc.repair.hits < inc.repair.need) {
        if (!ready('repair:' + inc.id + ':' + inc.repair.hits, true)) continue;
        const lit = incidentCard(inc)?.querySelector('.repairBtn.lit');
        if (lit) {
          if (!pointerDown(lit)) return null;
          return 'repair hit';
        }
      }
    }
    return null;
  },

  weekend(G, enabled, game) {
    const inc = G.s.incidents.find(i => i.key === 'weekend' && i.choice && i.choice.chosen === undefined);
    if (!ready('weekend:' + (inc ? inc.id : ''), !!inc)) return null;
    // With the Thermos, burnout is fuel for the Lever: always crunch.
    const work = thermosCrunch(game) || G.s.staff.burnout <= WEEKEND_WORK_MAX_BURNOUT;
    const btn = incidentCard(inc)?.querySelectorAll('.incBtn')[work ? 0 : 1];
    if (!usable(btn)) return null;
    if (!click(btn)) return null;
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
      if (!click(btn)) return null;
      return `${inc.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
    }
    return null;
  },

  // Coffee is ×1.5 on humans for 60 s. During Kernel Panic humans are the only
  // ones working, and multipliers stack, so drink then even if tired. With the
  // Thermos, the +8 burnout is fuel, so drink whenever it's ready.
  coffee(G, enabled, game) {
    const st = G.s.staff;
    let maxBurnout = COFFEE_MAX_BURNOUT;
    if (kernelPanic(G)) maxBurnout = 90;
    if (thermosCrunch(game)) maxBurnout = 100;
    const ok = st.burnout < maxBurnout && !st.week.weekend && st.lever.party <= 0;
    const btn = usable('#coffeeBtn');
    if (!ready('coffee', ok && !!btn)) return null;
    if (!click(btn)) return null;
    return 'coffee run';
  },

  callHammer() {
    const btn = usable('#hammerBtn');
    if (!ready('callHammer', !!btn)) return null;
    if (!click(btn)) return null;
    return 'called the hammer';
  },

  // The party zeroes humans for 45 s and runs tech ×3 (×(3 + burnout/10) up
  // to ×13 with the Thermos), then resets burnout. Never during Kernel Panic
  // (tech is down, humans are all that's working). With the Thermos, wait for
  // near-full burnout. During a production boost, pull a little early so the
  // party multiplies into it.
  lever(G, enabled, game) {
    const btn = usable('#leverBtn');
    let at = LEVER_AT_BURNOUT;
    if (thermosCrunch(game)) at = THERMOS_LEVER_AT;
    if (productionBoost(G) >= 2) at -= 15;
    const ok = !!btn && !kernelPanic(G) && G.s.staff.burnout >= at;
    if (!ready('lever', ok)) return null;
    if (!click(btn)) return null;
    return `pulled the lever (burnout ${Math.round(G.s.staff.burnout)})`;
  },

  // Overlays that only need dismissing: ZABURUFF's judgment scroll, the
  // Kernel Panic blue screen, and the welcome-back card.
  popups() {
    const scroll = document.querySelector('.zsClose')?.parentElement;
    if (scroll && !scroll.classList.contains('hidden') && ready('popup:scroll', true)) {
      if (!click(scroll)) return null;
      return 'closed judgment scroll';
    }
    const bsod = document.querySelector('.bsodInner')?.parentElement;
    if (bsod && !bsod.classList.contains('hidden') && ready('popup:bsod', true)) {
      if (!pointerDown(bsod)) return null;
      return 'closed blue screen';
    }
    const back = [...document.querySelectorAll('.wcBtn[data-a="go"]')].find(b => /BACK TO BANNING/i.test(b.textContent));
    if (back && !back.closest('.hidden') && ready('popup:welcome', true)) {
      if (!click(back)) return null;
      return 'closed welcome card';
    }
    // Field Trip (CD-ROM) story: cosmetic, a full-screen overlay. Skip still
    // unlocks the music station and sets settings.mixtape, so it never returns.
    const cdSkip = document.querySelector('#cdRoom:not(.hidden) .cdSkip');
    if (cdSkip && ready('popup:cd', true)) {
      if (!click(cdSkip)) return null;
      return 'skipped field trip';
    }
    return null;
  },

  coinLock(G) {
    const meta = G.s.meta && G.s.meta.cur;
    const btn = usable('#coinBtn');
    if (!ready('coin', !!btn && (meta === 'duping' || meta === 'economy'))) return null;
    if (!click(btn)) return null;
    return 'coin-lock';
  },

  audit(G, enabled) {
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
          if (!click(clear)) return null;
          return 'audit: cleared one';
        }
      }
      const submit = usable('.auSubmit');
      if (!ready('audit-submit', !!submit)) return null;
      if (!click(submit)) return null;
      return 'audit submitted';
    }
    const btn = usable('#auditBtn');
    const pile = truth.pile;
    const nearLaunch = G.s.waveMeter >= AUDIT_AT_METER * waveLaunchAt(enabled);
    if (!ready('audit-start', !!btn && nearLaunch && !(pile && pile.audited))) return null;
    if (!click(btn)) return null;
    return 'audit started';
  },

  report(G) {
    const ratio = G.s.reality / Math.max(1, G.s.perception);
    const btn = usable('#repBtn');
    if (!ready('report', !!btn && ratio < CLEAN_REPORT_RATIO)) return null;
    if (!click(btn)) return null;
    return 'transparency report';
  },

  // Launch at WAVE_LAUNCH_AT (or 100% during a boost). Audit first only when
  // an audit is possible soon; early game (no Moderator) launches right away.
  banWaves(G, enabled) {
    const truth = G.s.truth;
    const pile = truth.pile;
    const btn = usable('#waveBtn');
    // During a ×2+ boost, launch at 100% regardless: the wave multiplies into it.
    const boost = productionBoost(G);
    let launchAt = waveLaunchAt(enabled);
    if (boost >= 2) launchAt = 1;
    const charged = !!btn && G.s.waveMeter >= launchAt;
    const auditOpen = !!(truth.audit && truth.audit.cases);
    const auditSoon = auditOpen || (enabled.audit && G.s.buildings.moderator.amount > 0 &&
      !(pile && pile.audited) && truth.auditCd / TICKS_PER_SEC <= AUDIT_WAIT_SECONDS);
    // The wave's ×3+ multiplies into an active boost, so don't wait for the
    // audit then (unless one is already open and nearly done).
    const waitForAudit = auditOpen || (auditSoon && boost < 2);
    if (!ready('wave', charged && !waitForAudit, boost >= 2 ? FAST_REACTION_MS : REACTION_MS)) return null;
    if (!click(btn)) return null;
    return boost >= 2 ? `launched ban wave into a ×${boost.toFixed(1)} boost` : 'launched ban wave';
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
      if (!click(logs[d.answer])) return null;
      return 'dupe: picked log line';
    }
    // The COIN-LOCK card counts as done while the ability is active.
    const card = [...room.querySelectorAll('.drCard')].find(c => c.querySelector('b')?.textContent === DUPE_LABELS[step]);
    if (!usable(card) || !ready('dupe:' + step, true, FAST_REACTION_MS)) return null;
    if (!click(card)) return null;
    return 'dupe: ' + step;
  },
};

// Banhammer clicker, humanized. The game accepts one click per tick and at
// most 20 per second, and flags more than 15 in a second as an auto-clicker.
// Every click is a recorded input, and /api/ping reports total clicks and
// run seconds, so the long-run rate should look like a person: bursts of
// 4-9 clicks/s with irregular gaps, short pauses, and occasional breaks.
// During boosts (click multipliers, or big production multipliers when clicks
// scale with production) it clicks frantically, like a person would.
// Anti anti-cheat off: a steady 14/s, just under the game's >15/s flag.
const HAMMER_CPS = 4; // human-mode long-run average
const STEADY_CPS = 14;
const HAMMER_MIN_SHARE = 0.01; // clicks must add at least 1% of passive income
const MAX_CLICKS_PER_SEC = 13;
const BURST_CPS = [4, 9];
const BOOST_CPS = [10, 13];
const BURST_SECONDS = [6, 40];
const PAUSE_SECONDS = [1.5, 12];
const BREAK_CHANCE = 0.08; // per pause: a 1-4 minute break instead
const BREAK_SECONDS = [60, 240];

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);

// Long-run clicks/s for the current mode; values click upgrades in the planner.
function hammerCps() {
  if (humanMode()) return HAMMER_CPS;
  return STEADY_CPS;
}

// Log-normal gap around the target rate: mostly near it, sometimes long.
function gapMs(cps) {
  const z = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return Math.max(40, (1000 / cps) * Math.exp(0.35 * z - 0.06));
}

function startHammer(game, getSettings) {
  const recent = [];
  let phaseEnd = 0;
  let clicking = false;
  let cps = 0;
  const loop = () => {
    const settings = getSettings();
    const G = game.G;
    const now = performance.now();
    const boosted = !G.ascending && clickBoost(G) >= 2;
    let delay = 250;
    const active = settings.auto && settings.ops.hammer && hammerWorthwhile(G, boosted);
    if (active && !humanMode()) {
      while (recent.length && now - recent[0] > 1000) recent.shift();
      if (recent.length < STEADY_CPS) {
        clickHammer();
        recent.push(now);
      }
      delay = 1000 / STEADY_CPS;
    } else if (active) {
      if (boosted) {
        // Drop any pause: a person sees ×777 and starts mashing.
        clicking = true;
        cps = rand(BOOST_CPS);
        phaseEnd = now + 1000;
      } else if (now >= phaseEnd) {
        clicking = !clicking;
        if (clicking) {
          cps = rand(BURST_CPS);
          phaseEnd = now + rand(BURST_SECONDS) * 1000;
        } else {
          const brk = Math.random() < BREAK_CHANCE;
          phaseEnd = now + rand(brk ? BREAK_SECONDS : PAUSE_SECONDS) * 1000;
        }
      }
      if (clicking) {
        while (recent.length && now - recent[0] > 1000) recent.shift();
        if (recent.length < MAX_CLICKS_PER_SEC) {
          clickHammer();
          recent.push(now);
        }
        delay = gapMs(cps);
      }
    }
    setTimeout(loop, delay);
  };
  loop();
}

// How much more a click is worth right now than without buffs: click
// multipliers directly, and production multipliers through the mouse
// upgrades' "+1% of bans/sec per click" (only if that share of a click
// dominates). Kernel Panic, golden ×7, strike ×4, speedhack ×3 all count.
// Weird events where clicking is the whole point:
//   honeypot (30 s): each click is a sale paying clickPower×3 + 1 s of production
//   streamerMode (45 s): hype multiplies clicks up to ×21 and drains when idle
//   lagSwitch (12 s): clicks are queued and paid out with 50% interest
const CLICK_EVENTS = new Set(['honeypot', 'streamerMode', 'lagSwitch']);

function clickBoost(G) {
  if (G.s.weird && CLICK_EVENTS.has(G.s.weird.key)) return Infinity;
  let click = 1;
  let bps = 1;
  for (const b of G.s.buffs) {
    if (b.bad) continue;
    if (b.multClick > 1) click *= b.multClick;
    if (b.multBps > 1) bps *= b.multBps;
  }
  const mouse = [...G.s.upgradesBought].filter(id => id.startsWith('mouse:')).length;
  const bpsPart = G.bps > 0 ? (G.bps * 0.01 * mouse) / Math.max(1e-9, G.clickPower) : 0;
  return click * (1 + bpsPart * (bps - 1));
}

function hammerWorthwhile(G, boosted) {
  if (G.ascending) return false;
  if (boosted) return true;
  const cur = G.s.priority && G.s.priority.cur;
  if (cur && !cur.verdict && cur.hits < cur.need) return true;
  return G.clickPower * hammerCps() >= HAMMER_MIN_SHARE * G.bps;
}

// Total production multiplier from active good buffs (what a wave, coffee
// run, or Lever party would multiply into).
function productionBoost(G) {
  let m = 1;
  for (const b of G.s.buffs) if (!b.bad && b.multBps > 1) m *= b.multBps;
  return m;
}

function clickHammer() {
  const el = document.querySelector('#hammerHit');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = r.left + r.width * (0.35 + Math.random() * 0.3);
  const y = r.top + r.height * (0.35 + Math.random() * 0.3);
  pointerDown(el, x, y);
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
    // Experiment flags share OPS but have no routine of their own.
    if (!enabled[key] || !ROUTINES[key]) continue;
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

// The leaderboard's last verified score, from the game's own leaderboard state
// in localStorage (key click2ban-lb, field verified.score). That value also
// holds the pending input log, so only the small field is pulled out, without
// parsing the whole thing. Null when not joined or not found.
const LB_KEY = 'click2ban-lb';
const VERIFIED_RE = /"verified":\{"score":([0-9.eE+-]+)/;

function verifiedScore() {
  try {
    const m = (localStorage.getItem(LB_KEY) ?? '').match(VERIFIED_RE);
    if (m) return Number(m[1]);
    return null;
  } catch {
    return null;
  }
}

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
  let preLaunch = {};

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
          t: now, T: G.T, all: s.bansAllTime, verified: verifiedScore(),
          bps: G.bps, rawBps: G.rawBps, bans: s.bans,
          perception: s.perception, reality: s.reality, cred: t.cred,
          burnout: s.staff.burnout, notch: t.notch, meter: s.waveMeter, waves: s.wavesLaunched,
        }, MAX_SNAPSHOTS);
      }
      // A review exists from launch until the verdict lands. Launch resets the
      // pile, so conditions are captured on every tick before launch.
      const review = t.review;
      if (!review) {
        preLaunch = {
          notch: t.notch, cred: t.cred, meter: s.waveMeter, audited: !!(t.pile && t.pile.audited),
          innocentShare: t.pile ? t.pile.inn / Math.max(0.001, s.waveMeter) : null,
          projectedHeat, perception: s.perception, reality: s.reality,
        };
      }
      if (review && !pendingWave) {
        pendingWave = { n: s.wavesLaunched, launchedAt: now, f: review.f, ...preLaunch };
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
  auto: false, stealth: true, horizon: 3600, clicksPerSec: 0, depth: 1, beam: 5, collapsed: false,
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
#obh { position: fixed; z-index: 99999; width: min(380px, calc(100vw - 8px)); font: 12px/1.35 ui-monospace, Menlo, monospace;
  color: #e6ebff; background: rgba(10,13,24,.94); border: 2px solid #f5c542; border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,.6); }
#obh header { display: flex; gap: 6px; align-items: center; padding: 4px 6px; background: #f5c542;
  color: #111; cursor: move; user-select: none; font-weight: 700; }
#obh header .title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#obh header .rate { white-space: nowrap; }
#obh header button { all: unset; cursor: pointer; padding: 0 4px; font-weight: 700; }
#obh header button[data-act="auto"] { border: 1px solid #111; border-radius: 3px; font-size: 10px; }
#obh header button[data-act="auto"].on { background: #c62828; color: #fff; border-color: #c62828; }
#obh .body { padding: 6px 8px; max-height: 70vh; overflow: auto; overflow-wrap: anywhere; }
#obh.collapsed .body { display: none; }
#obh .controls { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
#obh select, #obh input { background: #1a2036; color: #e6ebff; border: 1px solid #39425f; font: inherit; }
#obh input { width: 44px; }
#obh .next { font-size: 14px; padding: 6px; margin-bottom: 6px; background: #1d2a1a; border-left: 4px solid #6fdc6f; }
#obh .next b { color: #6fdc6f; }
#obh .muted { color: #8592b3; }
#obh table { width: 100%; border-collapse: collapse; margin-top: 4px; }
#obh th, #obh td { padding: 1px 3px; text-align: right; white-space: nowrap; }
/* The name column takes whatever width the number columns leave and truncates,
   so a table can never push the panel sideways. */
#obh th:first-child, #obh td:first-child { text-align: left; overflow: hidden; text-overflow: ellipsis; width: 100%; max-width: 0; }
#obh th { color: #8592b3; font-weight: 400; border-bottom: 1px solid #39425f; }
#obh h4 { margin: 8px 0 2px; color: #f5c542; font-size: 12px; }
#obh .err { color: #ff6b6b; white-space: pre-wrap; }
#obh details.ops { margin-bottom: 6px; border: 1px solid #39425f; padding: 2px 6px; }
#obh details.stats { margin: 10px 0 0; }
#obh details.ops summary { cursor: pointer; color: #f5c542; }
#obh details.ops label { display: block; }
#obh details.ops label.stealth { margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid #2a3150; }
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
    <header><span class="title">BanGlider v${VERSION}</span>
      <span class="rate" title="Estimated income per second: production plus clicks, golden reports and ban waves on average; temporary buffs excluded"></span>
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
        <label class="stealth" title="Only click what a person could (nothing under a pop-up or off screen), with human reaction delays and hammer pacing. Off: instant reactions and a steady 14 clicks/s hammer."><input type="checkbox" data-flag="stealth"> <b>Anti anti-cheat</b> (human-like clicking)</label>
        ${OPS.filter(o => !o.experiment).map(o => `<label><input type="checkbox" data-op="${o.key}"> ${esc(o.label)}</label>`).join('')}
        <div class="opsLog"></div>
      </details>
      <div class="content muted">Binding to game…</div>
      <details class="ops stats"><summary>Stats</summary>
        <div class="statsLive muted"></div>
        <div class="statsBody muted">Collecting…</div>
        <div class="controls"><button data-act="copyStats">Copy JSON</button>
          <button data-act="resetStats">Reset</button></div>
      </details>
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

  for (const el of root.querySelectorAll('[data-flag]')) {
    el.checked = !!settings[el.dataset.flag];
    el.addEventListener('change', () => {
      settings[el.dataset.flag] = el.checked;
      saveSettings(settings);
      onChange(settings);
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
  const statsLive = root.querySelector('.statsLive');
  const rate = root.querySelector('header .rate');
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
    // Estimated income per second, shown in the header so it stays visible collapsed.
    renderRate(text) {
      rate.textContent = text;
    },
    // Planner-side numbers (bank, planner time, build), refreshed each replan.
    renderStatus(html) {
      statsLive.innerHTML = html;
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
const CLICK_GAP_MS = [120, 260]; // human mode only (src/input.js)
// Buy only once the bank clears the price by this factor. The leaderboard
// server replays our inputs and may compute bans a hair differently (another
// JS engine's Math.pow etc.); a purchase it can't afford is rejected there and
// its copy of the game falls behind for good.
const BUY_MARGIN = 1 + 1e-6;

function canAfford(game, price) {
  return game.G.s.bans >= price * BUY_MARGIN;
}
// Utility upgrades (no production effect) are bought once they cost no more
// than this many seconds of current income. Checked before the production
// path so steady buying never starves them.
const UTILITY_MAX_SECONDS = 600;

let busy = false;

// Returns the number of purchases made. Never overlaps itself.
async function autoBuy(game, path, utilities = []) {
  if (busy) return 0;
  busy = true;
  try {
    const arms = armsRacePick(game);
    if (arms && !game.G.ascending && clickUpgrade(game, arms)) return 1;
    const util = utilities.find(u => canAfford(game, u.price) && u.price <= UTILITY_MAX_SECONDS * game.G.bps);
    if (util && !game.G.ascending && clickUpgrade(game, util.def)) return 1;
    let clicks = 0;
    for (const step of path) {
      if (step.at > 0 || clicks >= MAX_CLICKS_PER_CYCLE || game.G.ascending) break;
      if (!canAfford(game, step.price)) break;
      let ok = false;
      if (step.item.type === 'building') ok = clickBuilding(game, step.item.def);
      else ok = clickUpgrade(game, step.item.def);
      if (!ok) break;
      clicks++;
      // The upgrade crates re-render after a purchase; wait for the next cycle.
      if (step.item.type === 'upgrade') break;
      if (humanMode()) await sleep(CLICK_GAP_MS[0] + Math.random() * (CLICK_GAP_MS[1] - CLICK_GAP_MS[0]));
    }
    return clicks;
  } finally {
    busy = false;
  }
}

// Arms race (from the game's code): escalations are permanent ×1.10, ×1.15,
// ×1.20 production. Each arms stage pushes perception up ~8.4 points
// (income ×0.79-0.93 per stage), spawns evaders (popped by ops), and makes
// golden reports red with chance stage/3. Red reports are worth more on
// average (721 s vs 455 s of production), so the stage roughly pays for its
// perception cost. Estimated net: +46-56% with all three escalations, vs
// +44% for escalations + Détente (×0.95, ends the stage). So escalate, skip
// Détente, and use a truce (30 min at stage 0) only to keep perception away
// from the review bomb at 90 (production ×0.5 until it drops below 70).
const ESCALATION_MAX_SECONDS = 900; // permanent +10-20%: pays back in hours
const TRUCE_MAX_SECONDS_PER_STAGE = 180;
const TRUCE_AT_PERCEPTION = 80;

function armsRacePick(game) {
  const { G, upgrades, logic } = game;
  const s = G.s;
  const ar = s.armsRace;
  if (!ar || ar.detente) return null;
  const affordable = (def, maxSeconds) => {
    const price = logic.upgradePrice(def);
    return canAfford(game, price) && price <= maxSeconds * G.bps;
  };
  const available = id => {
    const def = upgrades.find(u => u.id === id);
    if (!def || s.upgradesBought.has(id) || !s.upgradesUnlocked.has(id)) return null;
    return def;
  };
  for (let i = 0; i < 3; i++) {
    const esc = available(`escalation:${i}`);
    if (esc && affordable(esc, ESCALATION_MAX_SECONDS)) return esc;
  }
  const truce = upgrades.find(u => u.kind === 'truce');
  const stage = armsStage(s);
  const danger = s.perception >= TRUCE_AT_PERCEPTION;
  if (stage > 0 && danger && truce && available(truce.id) && affordable(truce, TRUCE_MAX_SECONDS_PER_STAGE * stage)) {
    return truce;
  }
  return null;
}

function clickBuilding(game, def) {
  if (!ensureBuyOne()) return false;
  const row = document.querySelectorAll('#buildings .product')[def.index];
  if (!row || row.classList.contains('locked')) return false;
  reveal(row);
  return click(row);
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
  reveal(crates[idx]);
  return click(crates[idx]);
}

// The building rows buy whatever the Buy/Sell + quantity toggles say.
// Force Buy x1 so each click is exactly one planned purchase.
function ensureBuyOne() {
  for (const label of ['Buy', '1']) {
    const btn = [...document.querySelectorAll('#buyControls button')].find(b => b.textContent.trim() === label);
    if (!btn) return false;
    if (!btn.classList.contains('on') && !click(btn)) return false;
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
const PLANNER_CPU_SHARE = 0.05;
const BUY_NOW_ROWS = 6;
const OPS_MS = 400;
const STATS_MS = 1000;

// Planner timing clock. The simulator fakes performance.now and supplies the
// real wall clock as window.__realNow.
function realNow() {
  if (window.__realNow) return window.__realNow();
  return performance.now();
}

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
  bindInputSettings(() => ui.settings);

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
    let out;
    const t0 = realNow();
    try {
      out = render(game, ui, autoBought);
    } catch (e) {
      ui.render(`<div class="err">Planner error: ${esc(e.stack ?? e.message)}</div>`);
      return;
    }
    const plannerMs = realNow() - t0;
    if (ui.settings.auto) autoBought += await autoBuy(game, out.result.path, out.utilities);
    return plannerMs;
  }

  await rebind();
  // Replan on a CPU budget: the planner runs on the game's main thread, so
  // wait at least PLANNER_CPU_SHARE⁻¹ × its own run time between replans.
  // Only the planner's own compute counts, not the auto-buyer's click pauses.
  const replanLoop = async () => {
    const spent = (await tick()) ?? 0;
    setTimeout(replanLoop, Math.max(REPLAN_MS, spent / PLANNER_CPU_SHARE));
  };
  replanLoop();
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
  const t0 = realNow();
  // While the hammer clicker runs, value click upgrades at its click rate.
  let clicksPerSec = settings.clicksPerSec;
  if (settings.auto && settings.ops.hammer) clicksPerSec = Math.max(clicksPerSec, hammerCps());
  const result = withSandbox(game, { clicksPerSec }, sim =>
    plan(sim, { bank, horizon: settings.horizon, depth: settings.depth, beam: settings.beam }));
  const ms = realNow() - t0;

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

  const utilities = utilityUpgrades(game, { clicksPerSec });
  if (utilities.length) {
    html += `<h4>Utility upgrades (bought at ≤${UTILITY_MAX_SECONDS / 60} min of income)</h4><table>`;
    for (const u of utilities.slice(0, 6)) {
      const secs = result.rate > 0 ? u.price / result.rate : Infinity;
      html += `<tr><td title="${esc(u.def.desc ?? '')}">${esc(iconText(u.def.icon))} ${esc(u.def.name)}</td>
        <td>${fmtNum(u.price)}</td><td>${fmtTime(secs)} of income</td></tr>`;
    }
    html += `</table>`;
  }

  const special = specialUpgrades(game);
  if (special.length) {
    html += `<h4>Arms race (auto: escalate x3; truce only near review bomb; no détente)</h4>`;
    html += special.map(u => `<div>${esc(iconText(u.icon))} ${esc(u.name)}</div>`).join('');
  }

  ui.renderRate(`${fmtNum(result.rate)}/s`);
  let status = `<div>Bank ${fmtNum(bank)} · planner ${ms.toFixed(0)}ms · ${esc(game.build)}</div>`;
  if (settings.auto) status += `<div>Auto: ${autoBought} bought this session</div>`;
  ui.renderStatus(status);
  if (game.build !== ANALYZED_BUILD) {
    html += `<div class="err">Game updated: automation rules were checked against ${esc(ANALYZED_BUILD)}, live is ${esc(game.build)}. Ask for a re-check.</div>`;
  }
  ui.render(html);
  return { result, utilities };
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
