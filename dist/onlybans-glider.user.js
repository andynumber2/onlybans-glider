// ==UserScript==
// @name         OnlyBans Glider
// @namespace    onlybans-glider
// @version      0.25.0
// @description  Purchase planner and automation for onlybans.wtf
// @match        *://onlybans.wtf/*
// @match        *://*.onlybans.wtf/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
'use strict';
const ANALYZED_BUILD = 'index-ClLVmN6W.js';
const VERSION = '0.25.0';

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
//
// With `deadline` (seconds) the objective is instead the bans earned by then:
// earned(D) = bank + spent + rate * (D - t) at a path's end. All-time bans are
// what sequel stars and the cap count, and neither the bank nor buildings
// survive a ship, so D is the time to the next ship or the cap (main.js).
// Spending is free in this objective; it only costs the purchases it delays.

// Cap on purchases made in the "spend now" phase, to bound planning time.
const MAX_NOW_BUYS = 100;

// lazy: after each buy-now purchase, re-measure only the candidates that could
// rank first (lazyTop) instead of every candidate. From the 2026-10-19 save,
// 120 game-minutes, seeds 7-18: 6x fewer calculateGains calls per replan, and
// 36.142 vs 36.143 log10 bans (5 better, 6 worse, 1 tie). false is for tests.
function plan(sim, { bank, horizon, depth = 3, beam = 5, lazy = true, deadline = null }) {
  const obj = objective(horizon, deadline);
  const rateStart = sim.rate();
  const ranked = rankCandidates(sim, { t: 0, bank, rate: rateStart }, obj);
  const gains = new Map();
  for (const c of ranked) gains.set(gainKey(c.item), gainEntry(c.item, c.price, c.gain, rateStart));

  // Phase 1: while the best-scoring item is affordable now and pays back
  // within the objective's break-even (2H, or the deadline), buy it. Late game this can be
  // dozens of purchases, which a depth-limited search would never reach.
  // A bundle that isn't affordable yet is still worth working toward: buy its
  // next part now if that part is affordable (the rest stays ranked next time).
  const nowSteps = [];
  let nowBank = bank;
  let applied = 0;
  let rateNow = rateStart;
  try {
    let top = ranked[0];
    while (top && top.payback < obj.breakEven && nowSteps.length < MAX_NOW_BUYS) {
      let parts = [top.item];
      if (top.item.type === 'bundle') parts = top.wait === 0 ? top.item.parts : top.item.parts.slice(0, 1);
      else if (top.wait > 0) break;
      const rateBefore = rateNow;
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
      rateNow = rateAfter;
      const last = nowSteps[nowSteps.length - 1];
      last.gain = rateAfter - rateBefore;
      last.rateAfter = rateAfter;
      const node = { t: 0, bank: nowBank, rate: rateAfter };
      if (lazy) {
        // An upgrade changes other candidates' gains unevenly: measure all
        // again. A department's own upgrades (tier ×2s etc.) gain with its
        // count, so they are measured again when it grows.
        if (parts.some(part => part.type === 'upgrade')) gains.clear();
        const grown = new Set(parts.map(part => part.def.id));
        for (const [key, g] of gains) {
          if (grown.has(g.building)) gains.delete(key);
          else g.fresh = false;
        }
        top = lazyTop(sim, node, obj, gains);
      } else {
        top = rankCandidates(sim, node, obj)[0];
      }
    }
    const ahead = lookahead(sim, nowBank, obj, depth, beam);
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
function lookahead(sim, bank, obj, depth, beam) {
  const rate0 = sim.rate();
  const root = { t: 0, bank, rate: rate0, spent: 0 };
  const holdValue = obj.leaf(root);
  const ranked = rankCandidates(sim, root, obj);

  for (const c of ranked.slice(0, beam)) {
    const sub = descend(sim, c, root, obj, depth - 1, beam);
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

// The value of a path's end node and how far ahead candidates are considered.
function objective(horizon, deadline) {
  if (deadline > 0) {
    return { limit: deadline, breakEven: deadline, leaf: n => n.bank + n.spent + n.rate * (deadline - n.t) };
  }
  return { limit: horizon, breakEven: 2 * horizon, leaf: n => n.bank + n.rate * (horizon - n.t) + n.rate * horizon };
}

// Score every candidate at a node: wait time plus payback time.
function rankCandidates(sim, node, obj) {
  const out = [];
  for (const item of sim.candidates()) {
    const price = sim.price(item);
    if (!(price >= 0) || !isFinite(price)) continue;
    const wait = waitFor(price, node.bank, node.rate);
    if (node.t + wait > obj.limit) continue;
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

// The best-scoring candidate, like rankCandidates(...)[0], but re-measuring
// only the candidates that could be best. `gains` holds each candidate's last
// measured gain and the rate it was measured at. A stale gain is scaled by the
// rate change since then (a change in the global multiplier scales every gain
// alike); the best estimate is measured again until the best one is fresh.
// Exact when a building purchase never raises another candidate's gain by
// more than the rate rose, apart from that department's own upgrades. It can
// miss a complement (a pair or synergy partner, another department's bundle)
// until the next upgrade purchase clears `gains`.
function lazyTop(sim, node, obj, gains) {
  const list = [];
  for (const item of sim.candidates()) {
    const price = sim.price(item);
    if (!(price >= 0) || !isFinite(price)) continue;
    const wait = waitFor(price, node.bank, node.rate);
    if (node.t + wait > obj.limit) continue;
    const key = gainKey(item);
    let g = gains.get(key);
    if (!g || g.price !== price) {
      g = measureGain(sim, item, price, node.rate);
      gains.set(key, g);
    }
    list.push({ item, price, wait, g });
  }
  for (;;) {
    let best = null;
    for (const c of list) {
      const gain = c.g.fresh ? c.g.gain : c.g.gain * node.rate / c.g.rateAt;
      if (!(gain > 0)) continue;
      const score = c.wait + c.price / gain;
      if (!best || score < best.score) best = { c, gain, score };
    }
    if (!best) return undefined;
    const { c, gain, score } = best;
    if (c.g.fresh) {
      return { item: c.item, price: c.price, wait: c.wait, gain, rateAfter: node.rate + gain, payback: c.price / gain, score };
    }
    c.g = measureGain(sim, c.item, c.price, node.rate);
    gains.set(gainKey(c.item), c.g);
  }
}

function measureGain(sim, item, price, rate) {
  sim.apply(item);
  const gain = sim.rate() - rate;
  sim.undo();
  return gainEntry(item, price, gain, rate);
}

function gainEntry(item, price, gain, rateAt) {
  const building = item.type === 'upgrade' ? item.def.building : undefined;
  return { price, gain, rateAt, fresh: true, building };
}

// A bundle's parts change as its department grows, so its length is part of the key.
function gainKey(item) {
  const key = item.type + ':' + item.def.id;
  return item.type === 'bundle' ? key + ':' + item.parts.length : key;
}

function descend(sim, cand, node, obj, depthLeft, beam) {
  const t = node.t + cand.wait;
  const bank = node.bank + node.rate * cand.wait - cand.price;
  const step = {
    item: cand.item,
    price: cand.price,
    at: t,
    gain: cand.gain,
    rateAfter: cand.rateAfter,
  };
  const here = { t, bank, rate: cand.rateAfter, spent: node.spent + cand.price };
  const leaf = obj.leaf(here);

  if (depthLeft <= 0) return { value: leaf, steps: [step] };

  sim.apply(cand.item);
  try {
    let best = { value: leaf, steps: [] };
    for (const c of rankCandidates(sim, here, obj).slice(0, beam)) {
      const sub = descend(sim, c, here, obj, depthLeft - 1, beam);
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

// Prestige ("Ship a Sequel"). Read from code (build B688DHuD): stars =
// integer cbrt(bansAllTime / 1e12); shipping adds stars − level to both
// level (kept) and reputation (spent here). Production ×(1 + level × 1% ×
// share), where share sums the owned review tiers. The order matches the
// game's crate order on the "Between Games" screen.
const PRESTIGE = [
  { key: 'legacy', price: 1 },
  { key: 'reputation1', price: 11, requires: 'legacy', share: 0.05 },
  { key: 'reputation2', price: 1111, requires: 'reputation1', share: 0.2 },
  { key: 'reputation3', price: 111111, requires: 'reputation2', share: 0.25 },
  { key: 'reputation4', price: 11111111, requires: 'reputation3', share: 0.25 },
  { key: 'reputation5', price: 1111111111, requires: 'reputation4', share: 0.25 },
  { key: 'starterMacros', price: 50, requires: 'legacy' },
  { key: 'starterMods', price: 150, requires: 'starterMacros' },
  { key: 'offline1', price: 1, requires: 'legacy' },
  { key: 'offline2', price: 100, requires: 'offline1' },
  { key: 'offline3', price: 10000, requires: 'offline2' },
  { key: 'luckyReports1', price: 77, requires: 'legacy' },
  { key: 'luckyReports2', price: 777, requires: 'luckyReports1' },
  { key: 'luckyReports3', price: 7777, requires: 'luckyReports2' },
  { key: 'cheapUpgrades', price: 99, requires: 'legacy' },
  { key: 'cheapBuildings', price: 99, requires: 'legacy' },
];
const PRESTIGE_BY_KEY = Object.fromEntries(PRESTIGE.map(p => [p.key, p]));
// Purchase priority: the review tiers (the production bonus) first, then the
// rest by value per star.
const PRESTIGE_PRIORITY = ['legacy', 'reputation1', 'reputation2', 'reputation3', 'reputation4', 'reputation5',
  'starterMacros', 'starterMods', 'cheapBuildings', 'cheapUpgrades', 'luckyReports1', 'luckyReports2',
  'luckyReports3', 'offline1', 'offline2', 'offline3'];
const TIERS = PRESTIGE.filter(p => p.share);
// A non-tier item is bought only if it leaves enough reputation for the next
// review tier, or costs at most this share of that tier's price.
const RESERVE_FREE_SHARE = 0.01;
// Ship once production after the sequel (incl. the shop buys) is at least
// this many times the current one. Simulated from the user's late save
// (2026-10-18, seeds 7-9): 3 h, never 26.15 / ×2 27.05 / ×4 27.17 log10
// bans; 6 h, ×4 29.41 vs a gain-per-hour (marginal = average) rule 28.19,
// which shipped 5-6 small sequels because waves make gains bursty.
// Late game (2026-10-19 save, sequel 7) income is linear once production
// plateaus, so ×4 (64× all-time bans) stopped shipping. 24 h, seeds 7-15:
// ×1.6 37.68 / ×2 37.73 / ×4 37.41; ×2 beat ×4 on all 9 seeds.
const SHIP_GAIN = 2;

function prestigeStars(bansAllTime) {
  if (!(bansAllTime >= 1e12)) return 0;
  const x = bansAllTime / 1e12;
  let t = Math.floor(Math.cbrt(x));
  while ((t + 1) ** 3 <= x) t++;
  while (t ** 3 > x) t--;
  return t;
}

function prestigeShare(owned) {
  return TIERS.reduce((sum, p) => sum + (owned.has(p.key) ? p.share : 0), 0);
}

// What to buy with `reputation`, in purchase order.
function prestigeBuys(owned, reputation, { spendAll = false } = {}) {
  const have = new Set(owned);
  const buys = [];
  let rep = reputation;
  let progress = true;
  while (progress) {
    progress = false;
    for (const key of PRESTIGE_PRIORITY) {
      const p = PRESTIGE_BY_KEY[key];
      if (have.has(key) || (p.requires && !have.has(p.requires)) || p.price > rep) continue;
      if (!p.share && !spendAll) {
        const next = TIERS.find(t => !have.has(t.key));
        if (next && p.price > next.price * RESERVE_FREE_SHARE && rep - p.price < next.price) continue;
      }
      have.add(key);
      buys.push(key);
      rep -= p.price;
      progress = true;
      break;
    }
  }
  return buys;
}

// Should we ship now, and what would it buy? `owned` is a Set of keys.
// When not shipping yet, `target` says when we would: the fewest pending
// stars that pass the ship rule, and the all-time bans that give them.
//
// With `cap` (the game's all-time bans cap) and `rate` (all-time bans per game
// second, null while unknown), the last ship before the cap is timed by
// `endgameShip` instead of the ×gain rule.
function sequelPlan({ level, reputation, owned, bansAllTime }, { gain = SHIP_GAIN, spendAll = false, cap = null, rate = null, rampS = SHIP_RAMP_S } = {}) {
  const pending = Math.max(0, prestigeStars(bansAllTime) - level);
  const now = shipCheck(level, reputation, owned, pending, gain, spendAll);
  const target = now.ship ? null : shipTarget(level, reputation, owned, pending, gain, spendAll);
  // Shipping at ×gain multiplies stars by about gain, so all-time bans by
  // gain³ before the next one: if that is past the cap, this ship is the last.
  const gainAt = now.ship ? bansAllTime : target?.bansAllTime ?? Infinity;
  if (!cap || gainAt * gain ** 3 < cap) return { pending, ...now, target };
  const endgame = rate > 0 ? endgameShip({ level, reputation, owned, bansAllTime }, cap, rate, { spendAll, rampS }) : null;
  return { pending, ...now, ship: !!endgame?.ship, target: null, endgame };
}

// Income lost to the ramp after a launch, in game seconds of the income before
// it (measured ~90-100 min in one shipped run, 2026-10-19).
const SHIP_RAMP_S = 95 * 60;

// The ship point (all-time bans) that reaches `cap` soonest when it is the
// last ship: flat income `rate` until then, `rampS` lost to the ramp, then
// income × (multAfter / multNow). Compared on a log grid from now to the cap
// against never shipping. `ship` is true when now is the best point.
function endgameShip({ level, reputation, owned, bansAllTime }, cap, rate, { spendAll = false, rampS = SHIP_RAMP_S, points = 60 } = {}) {
  const tStay = Math.max(0, cap - bansAllTime) / rate;
  let best = { at: cap, seconds: tStay };
  let nowSeconds = null;
  for (let i = 0; i < points; i++) {
    const at = bansAllTime * (cap / bansAllTime) ** (i / points);
    const pending = prestigeStars(at) - level;
    if (pending <= 0) continue;
    const { multNow, multAfter } = shipCheck(level, reputation, owned, pending, Infinity, spendAll);
    const seconds = (at - bansAllTime) / rate + rampS + (cap - at) / (rate * multAfter / multNow);
    if (i === 0) nowSeconds = seconds;
    if (seconds < best.seconds) best = { at, seconds };
  }
  return { ship: best.at === bansAllTime, bestAt: best.at, seconds: best.seconds, nowSeconds, stay: tStay };
}

function shipCheck(level, reputation, owned, pending, gain, spendAll) {
  const multNow = 1 + level * 0.01 * prestigeShare(owned);
  const buys = prestigeBuys(owned, reputation + pending, { spendAll });
  const after = new Set([...owned, ...buys]);
  const multAfter = 1 + (level + pending) * 0.01 * prestigeShare(after);
  return { buys, multNow, multAfter, ship: pending > 0 && multAfter >= multNow * gain };
}

// More pending stars never lower multAfter (review tiers are bought first),
// so the ship point is found by doubling, then bisecting.
function shipTarget(level, reputation, owned, pending, gain, spendAll) {
  const ships = p => shipCheck(level, reputation, owned, p, gain, spendAll).ship;
  let lo = pending;
  let hi = Math.max(1, pending * 2);
  while (!ships(hi)) {
    lo = hi;
    hi *= 2;
    if (hi > 2 ** 60) return null;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ships(mid)) hi = mid;
    else lo = mid;
  }
  const stars = level + hi;
  let bans = stars ** 3 * 1e12;
  while (prestigeStars(bans) < stars) bans *= 1 + 1e-15;
  return { pending: hi, bansAllTime: bans };
}

// Milliseconds until all-time bans reach `targetBans`, extrapolating the
// least-squares trend of log10(all-time bans) over the recent snapshots
// ({t, all, sequels}) of the current sequel. Usually early: growth in log
// space slows as a run matures. null: too few points; Infinity: no growth.
function trendEta(snaps, targetBans, now, { windowMs = 30 * 60e3, minPoints = 10 } = {}) {
  const last = snaps[snaps.length - 1];
  if (!last) return null;
  const pts = snaps.filter(x => x.t >= now - windowMs && x.sequels === last.sequels && x.all > 0);
  if (pts.length < minPoints) return null;
  const n = pts.length;
  const mt = pts.reduce((a, x) => a + x.t, 0) / n;
  const my = pts.reduce((a, x) => a + Math.log10(x.all), 0) / n;
  let sty = 0;
  let stt = 0;
  for (const x of pts) {
    sty += (x.t - mt) * (Math.log10(x.all) - my);
    stt += (x.t - mt) ** 2;
  }
  const slope = sty / stt;
  if (!(slope > 0)) return Infinity;
  const left = Math.log10(targetBans) - Math.log10(last.all);
  return Math.max(0, left / slope - (now - last.t));
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
  // All-time bans cap (build B3MWvSJR on): the only number export this large.
  let cap = null;
  for (const val of Object.values(mod)) {
    if (typeof val === 'number' && val >= 1e30 && isFinite(val)) cap = Math.max(cap ?? 0, val);
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

  return { logic, G: logic.G, buildings, upgrades, dupe, relics, cap, build: script.src.split('/').pop() };
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

// Golden report effects, best first (our estimate: meltdown ×666 for 6 s, a
// bot storm of ~25 bots worth 1-7 min of production each, a report chain,
// up to 15 min of production, ×7 for 77 s, ... production halved last).
// scripts/sim/harness.mjs GOLD_RANK must match.
const GOLD_RANK = ['meltdown', 'botFarmRaid', 'ringTakedown', 'bustedProvider', 'banWave', 'caughtOnStream', 'hotfix', 'exploitLeak', 'cheatUpdate'];

// The effect a click on this golden report (chain 0) would give right now.
// Mirrors the game's pick (`CT(wrath)`, build ClLVmN6W): clicking draws from
// the game's own RNG `s.rng` and nothing draws before the pick, so the
// answer is exact as long as the click is applied at once (not queued behind
// a leaderboard check-in). Reads state only.
function predictGolden(game, shimmer) {
  const s = game.G.s;
  let rng = s.rng >>> 0;
  const C = () => {
    rng = (rng + 1831565813) >>> 0;
    let t = rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let list;
  if (shimmer.wrath) {
    list = ['cheatUpdate', 'bustedProvider', 'exploitLeak'];
    if (C() < 0.3) list.push('meltdown', 'ringTakedown', 'botFarmRaid');
    if (s.lastEffect && C() < 0.8) {
      const i = list.indexOf(s.lastEffect);
      if (i >= 0) list.splice(i, 1);
    }
  } else {
    list = ['banWave', 'bustedProvider'];
    if (C() < 0.1) list.push('caughtOnStream');
    if (C() < 0.25 && game.buildings.some(b => (s.buildings[b.id]?.amount ?? 0) >= 10)) list.push('hotfix');
    if (C() < 0.03 && s.bansEarned >= 1e5) list.push('ringTakedown', 'botFarmRaid');
    if (s.lastEffect && list.length > 1 && C() < 0.8) {
      const i = list.indexOf(s.lastEffect);
      if (i >= 0) list.splice(i, 1);
    }
  }
  return list[Math.floor(C() * list.length)];
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
// window.__noLayout so clicks skip the hit-test there. A hidden tab skips it
// too: live, with the VDI window hidden, every hit-test failed for 5.7 h
// (likely nothing is drawn, so every point reads as empty), and no pop-up can be in the
// way of a click nobody is watching. Pacing stays human.
function canHitTest() {
  return !window.__noLayout && !document.hidden && typeof document.elementsFromPoint === 'function';
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
  { key: 'sequel', label: 'Ship sequels (when production would at least ×2) and buy the Reputation shop' },
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
// During a ×2+ boost a wave launches at 100%: its multiplier stacks on the boost.
function effectiveLaunchAt(G, enabled) {
  if (productionBoost(G) >= 2) return 1;
  return waveLaunchAt(enabled);
}
// Skipping the audit to catch a boost is only worth it when the wave would
// stay below tier 2 (APPEALS at most) without one.
const SKIP_AUDIT_MAX_HEAT = 15;

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

// The game sets these buttons' `disabled` in its render loop, which stops in a
// hidden tab, so right after use a button still reads as ready and every press
// is refused (thousands of refused coin-locks in the input log). Gate on the
// same timers the game checks.
const STAFF_BUSY = {
  '#coinBtn': (st) => st.coinLock.cd > 0 || st.coinLock.t > 0,
  '#coffeeBtn': (st) => st.coffee.cd > 0 || st.coffee.t > 0,
  '#hammerBtn': (st) => st.hammer.cd > 0,
  '#leverBtn': (st) => st.lever.cd > 0 || st.lever.party > 0,
};

function staffButton(G, sel) {
  if (STAFF_BUSY[sel](G.s.staff)) return null;
  return usable(sel);
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
  shimmers(G, enabled, game) {
    const els = document.querySelectorAll('#shimmers .shimmer');
    const pick = enabled.goldenPick && goldenPickState.on;
    if (pick) {
      const off = checkGoldenPick(G);
      if (off) return off;
    }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      // Golden report look-ahead: elements and G.shimmers are in the same
      // order (both added at spawn, removed at pop or expiry).
      const sh = pick && els.length === G.shimmers.length ? G.shimmers[i] : null;
      if (sh && sh.type === 'golden' && sh.chain === 0 && el.classList.contains('wrath') === !!sh.wrath) {
        if (!goldenNoticed.has(el)) {
          if (!ready('shimmer:' + shimmerKey(el), true)) continue;
          goldenNoticed.add(el);
        }
        const effect = predictGolden(game, sh);
        // Anomaly Detection (bought before the look-ahead was on; it resets
        // at the next sequel) pops the report itself 2.5 s after it appears.
        let left = sh.life;
        if (G.s.upgradesBought.has('tool:anomaly')) left = Math.min(left, Math.floor(2.5 * TICKS_PER_SEC) - (sh.maxLife - sh.life));
        const lastChance = left <= GOLDEN_LAST_CHANCE_TICKS;
        if (GOLD_RANK.indexOf(effect) > GOLDEN_TAKE_RANK && !(lastChance && !GOLDEN_NEVER.has(effect))) continue;
        const before = G.s.eventsClicked;
        if (!pointerDown(el)) return null;
        goldenPickState.pending = { effect, clicked: before };
        goldenPickState.picks++;
        // Applied at once unless queued behind a check-in; check now, before
        // another click (or Anomaly Detection) overwrites lastEffect.
        if (G.s.eventsClicked > goldenPickState.pending.clicked) return checkGoldenPick(G) ?? `golden ${effect}`;
        return `golden ${effect}`;
      }
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
    const btn = staffButton(G, '#coffeeBtn');
    if (!ready('coffee', ok && !!btn)) return null;
    if (!click(btn)) return null;
    return 'coffee run';
  },

  callHammer(G) {
    const btn = staffButton(G, '#hammerBtn');
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
    const btn = staffButton(G, '#leverBtn');
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

  // Ship a Sequel when sequelPlan says so (src/planner.js), confirm, buy the
  // Reputation shop one crate at a time, then launch.
  sequel(G, enabled, game) {
    const p = G.s.prestige;
    const opts = sequelOptions(enabled, G, game.cap);
    if (G.ascending) {
      const screen = document.querySelector('#ascendScreen');
      if (!screen) return null;
      // Crates carry no key; they are rendered in PRESTIGE order.
      const crates = screen.querySelectorAll('.prestigeGrid .crate');
      const [next] = crates.length === PRESTIGE.length ? prestigeBuys(p.upgrades, p.reputation, opts) : [];
      if (next) {
        const crate = crates[PRESTIGE.findIndex(x => x.key === next)];
        if (!ready('sequel:buy:' + next, true)) return null;
        if (!click(crate)) return null;
        return 'prestige: ' + next;
      }
      const launch = usable(screen.querySelector('#launchSequel'));
      if (!ready('sequel:launch', !!launch)) return null;
      if (!click(launch)) return null;
      return 'launched sequel ' + p.sequels;
    }
    const confirm = [...document.querySelectorAll('#modal:not(.hidden) .buttons button')]
      .find(b => b.textContent === 'Ship it!');
    if (confirm) {
      if (!ready('sequel:confirm', true)) return null;
      if (!click(confirm)) return null;
      return 'shipped a sequel';
    }
    const plan = sequelStatus(G, enabled, game.cap);
    const btn = usable('#sequelButton');
    if (!ready('sequel:ship', !!btn && plan.ship)) return null;
    if (!click(btn)) return null;
    return `ship? +${plan.pending} ⭐, ×${plan.multNow.toFixed(2)} → ×${plan.multAfter.toFixed(2)}`;
  },

  coinLock(G) {
    const meta = G.s.meta && G.s.meta.cur;
    const btn = staffButton(G, '#coinBtn');
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
    const nearLaunch = G.s.waveMeter >= AUDIT_AT_METER * effectiveLaunchAt(G, enabled);
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
    const charged = !!btn && G.s.waveMeter >= effectiveLaunchAt(G, enabled);
    const auditOpen = !!(truth.audit && truth.audit.cases);
    const auditSoon = auditOpen || (enabled.audit && G.s.buildings.moderator.amount > 0 &&
      !(pile && pile.audited) && truth.auditCd / TICKS_PER_SEC <= AUDIT_WAIT_SECONDS);
    // The wave's ×3+ multiplies into an active boost, so don't wait for the
    // audit then, unless one is already open or the pile is dirty enough
    // that an unaudited wave would be tier 2+ (early in a run, after a sequel).
    const dirty = (projectedHeat(G, { ...enabled, audit: false }) ?? 0) >= SKIP_AUDIT_MAX_HEAT;
    const waitForAudit = auditOpen || (auditSoon && (boost < 2 || dirty));
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

// Bans to keep unspent so the next audit can be paid. Read from code: an
// audit costs 20 s of raw production (at least 25 bans/s), halved by the SQL
// tool. Without this reserve the auto-buyer spends the bank to zero early in a
// run, the audit never fires, and projectedHeat (which counts on it) lets the
// notch run loose: a SCANDAL wave right after a sequel launch.
function auditReserve(G, enabled) {
  if (!enabled.audit || G.s.buildings.moderator.amount <= 0) return 0;
  if (G.s.truth.pile && G.s.truth.pile.audited) return 0;
  let cost = Math.max(G.rawBps * 20, 25 * 20);
  if (G.s.upgradesBought.has('tool:sql')) cost *= 0.5;
  return Math.ceil(cost);
}

// Hidden experiment flags: ops.sequelGain (ship ratio), ops.sequelSpendAll,
// ops.sequelEndgame (time the last ship before the cap by endgameShip).
function sequelOptions(enabled, G, cap) {
  const opts = { gain: enabled.sequelGain ?? SHIP_GAIN, spendAll: !!enabled.sequelSpendAll };
  if (enabled.sequelEndgame && cap) Object.assign(opts, { cap, rate: incomeRate(G) });
  return opts;
}

function sequelStatus(G, enabled, cap) {
  const p = G.s.prestige;
  return sequelPlan({ level: p.level, reputation: p.reputation, owned: p.upgrades, bansAllTime: G.s.bansAllTime },
    sequelOptions(enabled, G, cap));
}

// All-time bans per game second over the last INCOME_WINDOW game minutes of
// the current sequel, from one sample per game minute; null until
// INCOME_MIN minutes are in (waves make shorter windows too bursty).
const INCOME_WINDOW = 30;
const INCOME_MIN = 20;
const incomeSamples = [];
function incomeRate(G) {
  const last = incomeSamples[incomeSamples.length - 1];
  if (last && last.sequels !== G.s.prestige.sequels) incomeSamples.length = 0;
  if (!incomeSamples.length || G.T - incomeSamples[incomeSamples.length - 1].T >= 60 * TICKS_PER_SEC) {
    incomeSamples.push({ T: G.T, all: G.s.bansAllTime, sequels: G.s.prestige.sequels });
    if (incomeSamples.length > INCOME_WINDOW + 1) incomeSamples.shift();
  }
  const first = incomeSamples[0];
  const newest = incomeSamples[incomeSamples.length - 1];
  const seconds = (newest.T - first.T) / TICKS_PER_SEC;
  if (seconds < INCOME_MIN * 60) return null;
  return (newest.all - first.all) / seconds;
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

// Golden report look-ahead (panel toggle ops.goldenPick, off by default):
// a detectability choice like Anti anti-cheat. Click when the
// predicted effect (predictGolden in src/game.js) ranks in GOLD_RANK's top
// GOLDEN_TAKE_RANK + 1, or in the report's last 2 s anything but the two bad
// ones (a report may expire instead; that costs nothing). The RNG moves on
// most ticks, so each 400 ms poll is a fresh pick. Sim ceiling (best of 10
// picks): fresh run to the cap 43.7 -> 12.6 game hours. This look-ahead
// (seeds 7-13): 39.3 -> 12.2 game hours, faster on 7 of 7, 0 mismatches.
const GOLDEN_TAKE_RANK = 2; // meltdown, botFarmRaid, ringTakedown
const GOLDEN_LAST_CHANCE_TICKS = 2 * TICKS_PER_SEC;
const GOLDEN_NEVER = new Set(['exploitLeak', 'cheatUpdate']);
const goldenNoticed = new WeakSet();
// Self-check: each click's prediction against the effect the game applied.
// A changed build, or a click queued behind a leaderboard check-in (applied
// after the server's reseed), shows up as mismatches; 3 in the last 20
// turn the look-ahead off for the session.
const goldenPickState = { on: true, pending: null, results: [], picks: 0, mismatches: 0 };
// For the panel and the stats export.
function goldenPickStatus(G) {
  const { on, picks, mismatches, results } = goldenPickState;
  return { on, picks, mismatches, recentMisses: results.filter(ok => !ok).length, recent: results.length,
    anomaly: G.s.upgradesBought.has('tool:anomaly') };
}
function checkGoldenPick(G) {
  const p = goldenPickState.pending;
  if (!p || G.s.eventsClicked <= p.clicked) return null;
  goldenPickState.pending = null;
  const r = goldenPickState.results;
  r.push(G.s.lastEffect === p.effect);
  if (G.s.lastEffect !== p.effect) goldenPickState.mismatches++;
  if (r.length > 20) r.shift();
  if (r.filter(ok => !ok).length < 3) return G.s.lastEffect === p.effect ? null : `golden mismatch ${p.effect} got ${G.s.lastEffect}`;
  goldenPickState.on = false;
  return 'golden prediction off (3 mismatches)';
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
  // Between games only the sequel routine (shop, launch) has anything to do.
  if (G.ascending) {
    if (!enabled.sequel) return null;
    try {
      return ROUTINES.sequel(G, enabled, game);
    } catch (e) {
      return `sequel error: ${e.message}`;
    }
  }
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
// Minute snapshots for the last two hours (the sequel ETA reads 30 minutes),
// then one an hour for a week. Keeps the export and each persist small.
const MINUTE_SPAN_MS = 2 * 3600e3;
const HOUR_MS = 3600e3;
const MAX_HOURLY = 168;
const MAX_WAVES = 50;
const MAX_RECENT_ACTIONS = 50;
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
  return { started: Date.now(), snapshots: [], waves: [], tierCounts: [], wavesSeen: 0, actionCounts: {}, recentActions: [] };
}

// Thins snapshots older than MINUTE_SPAN_MS to the first one in each hour.
function compactSnapshots(snaps, now) {
  const cutoff = now - MINUTE_SPAN_MS;
  const old = [];
  let lastHour = null;
  for (const x of snaps) {
    if (x.t >= cutoff) break;
    const hour = Math.floor(x.t / HOUR_MS);
    if (hour !== lastHour) old.push(x);
    lastHour = hour;
  }
  const recent = snaps.filter(x => x.t >= cutoff);
  return old.slice(-MAX_HOURLY).concat(recent);
}

// Drops fields from older builds that nothing reads any more.
function slimSnapshot({ t, T, all, verified, bps, rawBps, bans, waves, sequels, diag }) {
  return { t, T, all, verified, bps, rawBps, bans, waves, sequels, diag };
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
  // Migrate stores from before the size limits: count every saved wave, then trim.
  if (!data.wavesSeen && data.waves.length) {
    data.wavesSeen = data.waves.length;
    for (const w of data.waves) if (w.tier >= 0) data.tierCounts[w.tier] = (data.tierCounts[w.tier] ?? 0) + 1;
  }
  data.snapshots = compactSnapshots(data.snapshots.map(slimSnapshot), Date.now());
  data.waves = data.waves.slice(-MAX_WAVES);
  data.recentActions = data.recentActions.slice(-MAX_RECENT_ACTIONS);

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
    // Returns true when it took a minute snapshot (diag: loop health from main.js).
    tick(G, projectedHeat, diag = null) {
      const s = G.s;
      const t = s.truth;
      const now = Date.now();
      let snapped = false;
      if (now - lastSnapshot >= SNAPSHOT_MS) {
        lastSnapshot = now;
        snapped = true;
        data.snapshots.push({
          t: now, T: G.T, all: s.bansAllTime, verified: verifiedScore(),
          bps: G.bps, rawBps: G.rawBps, bans: s.bans, waves: s.wavesLaunched,
          sequels: s.prestige.sequels, diag,
        });
        data.snapshots = compactSnapshots(data.snapshots, now);
        dirty = true;
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
        data.wavesSeen++;
        if (pendingWave.tier >= 0) data.tierCounts[pendingWave.tier] = (data.tierCounts[pendingWave.tier] ?? 0) + 1;
        push(data.waves, pendingWave, MAX_WAVES);
        pendingWave = null;
      }
      return snapped;
    },

    summary() {
      const counts = TIER_NAMES.map((_, i) => data.tierCounts[i] ?? 0);
      const recent = data.snapshots.slice(-10);
      const avgBps = recent.length ? recent.reduce((a, x) => a + x.bps, 0) / recent.length : 0;
      return { waves: data.wavesSeen, counts, avgBps, lastWave: data.waves[data.waves.length - 1] };
    },

    // Minute snapshots, oldest first (read only).
    snapshots() {
      return data.snapshots;
    },

    // extra: live session state from other modules (e.g. golden picks).
    exportJson(extra = {}) {
      return JSON.stringify({ ...data, ...extra });
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
#obh details.ops { margin: 10px 0 0; border: 1px solid #39425f; padding: 2px 6px; }
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
        <label>Depth <input data-set="depth" type="number" min="1" max="5" step="1"></label>
      </div>
      <div class="content muted">Binding to game…</div>
      <details class="ops"><summary>Automation (runs while AUTO is on)</summary>
        <label class="stealth" title="Only click what a person could (nothing under a pop-up or off screen), with human reaction delays and hammer pacing. Off: instant reactions and a steady 14 clicks/s hammer."><input type="checkbox" data-flag="stealth"> <b>Anti anti-cheat</b> (human-like clicking)</label>
        <label class="stealth" title="Predicts each golden report's effect from the game's own RNG and clicks only when the roll is good (meltdown, bot storm, report chain), or anything harmless in its last 2 s. Sim, fresh run to the cap: 39 h to 12 h. A pattern of only good rolls is easy for the developer to spot."><input type="checkbox" data-op="goldenPick"> <b>Golden picks</b> (click when the roll is good)</label>
        ${OPS.filter(o => !o.experiment).map(o => `<label><input type="checkbox" data-op="${o.key}"> ${esc(o.label)}</label>`).join('')}
        <div class="opsLog"></div>
      </details>
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

// Replanning after 15 clicks beats working through the whole buy-now list:
// income grows fast after a sequel, and a stale list buys the wrong things.
// 30 min post-sequel sim, seeds 2/7/8/9: cap 100 earned 5-750x fewer bans
// than cap 15 on every seed (2026-10-18).
const MAX_CLICKS_PER_CYCLE = 15;
// The store's own quantity toggles. A run of identical planned buildings is
// bought with one click at the largest size it fills (one recorded action,
// all or nothing, like a person clicking x10). Without this, buying one item
// per click fell far behind income after a sequel (bank at ~19 min of income).
const BULK_SIZES = [100, 10];
const CLICK_GAP_MS = [120, 260]; // human mode only (src/input.js)
// Buy only once the bank clears the price by this factor. The leaderboard
// server replays our inputs and may compute bans a hair differently (another
// JS engine's Math.pow etc.); a purchase it can't afford is rejected there and
// its copy of the game falls behind for good.
const BUY_MARGIN = 1 + 1e-6;

let reserve = 0; // bans held back for the next audit (auditReserve in src/ops.js)

function canAfford(game, price) {
  return game.G.s.bans - reserve >= price * BUY_MARGIN;
}
// Utility upgrades (no production effect) are bought once they cost no more
// than this many seconds of current income. Checked before the production
// path so steady buying never starves them.
const UTILITY_MAX_SECONDS = 600;

let busy = false;
// Why the last cycle stopped buying, for the panel and the stats export.
const buyerState = { stop: '' };

// Returns the number of purchases made. Never overlaps itself.
async function autoBuy(game, path, utilities = [], ops = {}) {
  if (busy) {
    buyerState.stop = 'previous cycle still running';
    return 0;
  }
  busy = true;
  try {
    reserve = auditReserve(game.G, ops);
    const arms = armsRacePick(game);
    if (arms && !game.G.ascending && clickUpgrade(game, arms)) return 1;
    // Anomaly Detection pops golden reports itself 2.5 s after they appear,
    // which takes the pick away from the golden look-ahead (ops.goldenPick).
    const util = utilities.find(u => canAfford(game, u.price) && u.price <= UTILITY_MAX_SECONDS * game.G.bps &&
      !(ops.goldenPick && u.def.id === 'tool:anomaly'));
    if (util && !game.G.ascending && clickUpgrade(game, util.def)) return 1;
    // The buy-now prefix is bought this cycle in any order, so identical
    // buildings in it are grouped into bulk clicks.
    const queue = [];
    for (const step of path) {
      if (step.at > 0) break;
      queue.push(step);
    }
    let clicks = 0;
    let bought = 0;
    buyerState.stop = 'all planned buys done';
    if (!queue.length) buyerState.stop = path.length ? `next buy in ${Math.round(path[0].at)}s` : 'nothing planned';
    while (queue.length && clicks < MAX_CLICKS_PER_CYCLE && !game.G.ascending) {
      const step = queue[0];
      let ok = false;
      let count = 1;
      if (step.item.type === 'building') {
        const def = step.item.def;
        const run = queue.filter(s => s.item.type === 'building' && s.item.def === def).length;
        count = BULK_SIZES.find(n => n <= run && canAfford(game, game.logic.buildingPrice(def.id, n))) ?? 1;
        if (!canAfford(game, game.logic.buildingPrice(def.id, count))) {
          buyerState.stop = `can't afford ${def.name}${reserve > 0 ? ' (audit reserve)' : ''}`;
          break;
        }
        ok = clickBuilding(game, def, count);
        if (ok) {
          let left = count;
          for (let j = 0; j < queue.length && left > 0;) {
            if (queue[j].item.type === 'building' && queue[j].item.def === def) {
              queue.splice(j, 1);
              left--;
            } else j++;
          }
        }
      } else {
        if (!canAfford(game, step.price)) {
          buyerState.stop = `can't afford ${step.item.def.name}${reserve > 0 ? ' (audit reserve)' : ''}`;
          break;
        }
        ok = clickUpgrade(game, step.item.def);
        if (ok) queue.shift();
      }
      if (!ok) break; // clickBuilding/clickUpgrade set buyerState.stop
      clicks++;
      bought += count;
      if (clicks >= MAX_CLICKS_PER_CYCLE) buyerState.stop = `${MAX_CLICKS_PER_CYCLE} buys done, replanning`;
      // Upgrade crates re-render after a purchase; the gap below covers it
      // (clickUpgrade refuses to click while the crates don't match).
      if (humanMode() || step.item.type === 'upgrade') await sleep(CLICK_GAP_MS[0] + Math.random() * (CLICK_GAP_MS[1] - CLICK_GAP_MS[0]));
    }
    return bought;
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

function clickBuilding(game, def, count = 1) {
  if (!ensureBuyQuantity(count)) {
    buyerState.stop = `Buy ×${count} toggle not clickable`;
    return false;
  }
  const row = document.querySelectorAll('#buildings .product')[def.index];
  if (!row || row.classList.contains('locked')) {
    buyerState.stop = `${def.name} row missing or locked`;
    return false;
  }
  reveal(row);
  if (click(row)) return true;
  buyerState.stop = `${def.name} row covered or off screen`;
  return false;
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
  if (idx < 0 || crates.length !== expected.length) {
    buyerState.stop = `upgrade crates don't match (${crates.length} shown, ${expected.length} expected)`;
    return false;
  }
  reveal(crates[idx]);
  if (click(crates[idx])) return true;
  buyerState.stop = `${def.name} crate covered or off screen`;
  return false;
}

// The building rows buy whatever the Buy/Sell + quantity toggles say.
// Set Buy x`count` so each click is exactly the planned purchase.
function ensureBuyQuantity(count) {
  for (const label of ['Buy', String(count)]) {
    const btn = [...document.querySelectorAll('#buyControls button')].find(b => b.textContent.trim() === label);
    if (!btn) return false;
    if (btn.classList.contains('on')) continue;
    // The toggles sit at the top of the scrolling store, often out of view.
    reveal(btn);
    if (!click(btn)) return false;
  }
  const on = [...document.querySelectorAll('#buyControls button.on')].map(b => b.textContent.trim());
  return on.includes('Buy') && on.includes(String(count));
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
    onCopyStats: () => navigator.clipboard.writeText(stats.exportJson(game ? { goldenPick: goldenPickStatus(game.G) } : {})),
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
  // Longest real-time gap between replans since the last stats snapshot.
  // Chrome throttles timers in hidden tabs to about once a minute.
  const loopHealth = { last: 0, maxGapMs: 0, hiddenSeen: false };

  async function tick() {
    if (!game || game.G.ascending) return;
    // A hidden tab only matters for display; auto mode keeps buying.
    if (document.hidden && !ui.settings.auto) return;
    let out;
    const t0 = realNow();
    try {
      out = render(game, ui, autoBought, stats);
    } catch (e) {
      ui.render(`<div class="err">Planner error: ${esc(e.stack ?? e.message)}</div>`);
      return;
    }
    const plannerMs = realNow() - t0;
    if (ui.settings.auto) autoBought += await autoBuy(game, out.result.path, out.utilities, ui.settings.ops);
    return plannerMs;
  }

  await rebind();
  // Replan on a CPU budget: the planner runs on the game's main thread, so
  // wait at least PLANNER_CPU_SHARE⁻¹ × its own run time between replans.
  // Only the planner's own compute counts, not the auto-buyer's click pauses.
  const replanLoop = async () => {
    const now = realNow();
    if (loopHealth.last) loopHealth.maxGapMs = Math.max(loopHealth.maxGapMs, now - loopHealth.last);
    loopHealth.last = now;
    if (document.hidden) loopHealth.hiddenSeen = true;
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
    const diag = {
      hidden: document.hidden || loopHealth.hiddenSeen, maxReplanGapS: Math.round(loopHealth.maxGapMs / 1000),
      buyer: buyerState.stop,
    };
    if (stats.tick(game.G, projectedHeat(game.G, ui.settings.ops), diag)) {
      loopHealth.maxGapMs = 0;
      loopHealth.hiddenSeen = false;
    }
    ui.renderStats(statsHtml(stats.summary()) + goldenStatusHtml(game, ui.settings));
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

// Golden picks (ops.goldenPick) status, under Last wave in Stats.
function goldenStatusHtml(game, settings) {
  if (!settings.ops.goldenPick) return '';
  const g = goldenPickStatus(game.G);
  if (!g.on) return `<div>Golden picks: off · ${g.picks} picks, ${g.mismatches} mismatches</div>`;
  let html = `<div>Golden picks: on · ${g.picks} picks, ${g.mismatches} mismatches</div>`;
  if (g.anomaly) html += '<div class="muted">Golden picks limited until next sequel (Anomaly Detection pops reports after 2.5 s)</div>';
  return html;
}

// Hidden experiment flag `deadline`: plan for bans earned by the next ship or
// the cap, whichever comes first (see plan() in src/planner.js). The ETA comes
// from the last 30 minutes' growth trend (usually early, so the planner errs
// short); until there is one, 2 × the horizon, the old break-even.
const MIN_DEADLINE_S = 60;
function planDeadline(game, settings, stats) {
  const seq = sequelStatus(game.G, settings.ops, game.cap);
  if (seq.ship) return MIN_DEADLINE_S;
  let target = seq.target?.bansAllTime ?? null;
  if (seq.endgame && seq.endgame.bestAt > game.G.s.bansAllTime) target = seq.endgame.bestAt;
  if (game.cap && !(target < game.cap)) target = game.cap;
  if (!target) return 2 * settings.horizon;
  const etaMs = trendEta(stats.snapshots(), target, Date.now());
  if (etaMs === null || etaMs === Infinity) return 2 * settings.horizon;
  return Math.max(MIN_DEADLINE_S, etaMs / 1000);
}

function render(game, ui, autoBought, stats) {
  const { settings } = ui;
  const bank = game.G.s.bans;
  const t0 = realNow();
  // While the hammer clicker runs, value click upgrades at its click rate.
  let clicksPerSec = settings.clicksPerSec;
  if (settings.auto && settings.ops.hammer) clicksPerSec = Math.max(clicksPerSec, hammerCps());
  const deadline = settings.deadline ? planDeadline(game, settings, stats) : null;
  const result = withSandbox(game, { clicksPerSec }, sim =>
    plan(sim, { bank, horizon: settings.horizon, depth: settings.depth, beam: settings.beam, deadline }));
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
    html += `<h4 title="Escalates all three, skips Détente, and calls a truce only when perception reaches 80 (near a review bomb)">Arms race (auto: escalate ×3)</h4>`;
    html += special.map(u => `<div>${esc(iconText(u.icon))} ${esc(u.name)}</div>`).join('');
  }

  const seq = sequelStatus(game.G, settings.ops, game.cap);
  html += `<h4>Sequel (auto: ships at ×${settings.ops.sequelGain ?? SHIP_GAIN} production)</h4>`;
  if (seq.ship) html += `<div><b>Shipping now</b> · +${fmtNum(seq.pending)} ⭐</div>`;
  if (seq.target) {
    // Nothing planned: production stays flat, so bans grow linearly at the
    // current rate. Otherwise project the recent growth trend.
    let eta = '';
    if (!result.path.length) {
      const left = seq.target.bansAllTime - game.G.s.bansAllTime;
      if (result.rate > 0) eta = ` · <span title="Nothing planned: all-time bans grow at the current rate">~${fmtTime(left / result.rate)}</span>`;
    } else {
      const etaMs = trendEta(stats.snapshots(), seq.target.bansAllTime, Date.now());
      if (etaMs === null) eta = ' · ETA measuring';
      else if (etaMs === Infinity) eta = ' · ETA: no growth';
      else eta = ` · <span title="Projected from the last 30 min of all-time bans growth; usually early as growth slows">~${fmtTime(etaMs / 1000)}</span>`;
    }
    html += `<div>+${fmtNum(seq.target.pending)} ⭐ at ${fmtNum(seq.target.bansAllTime)} all-time${eta}</div>`;
  }
  if (seq.endgame) {
    const e = seq.endgame;
    const when = e.bestAt >= game.cap ? 'never ship again' : `last ship at ${fmtNum(e.bestAt)} all-time`;
    html += `<div title="Flat income at the last 30 game-minutes' rate">Endgame: ${when} · cap in ~${fmtTime(e.seconds)} (never: ~${fmtTime(e.stay)})</div>`;
  } else if (seq.target === null && !seq.ship && settings.ops.sequelEndgame && game.cap) {
    html += '<div>Endgame: measuring income</div>';
  }
  if (seq.buys.length) html += `<div class="muted">Buys: ${seq.buys.map(esc).join(', ')}</div>`;

  ui.renderRate(`${fmtNum(result.rate)}/s`);
  let status = `<div>Bank ${fmtNum(bank)} · planner ${ms.toFixed(0)}ms · ${esc(game.build)}</div>`;
  if (deadline) status += `<div>Planning to: ${fmtTime(deadline)} (next ship or cap)</div>`;
  if (settings.auto) status += `<div>Auto: ${autoBought} bought this session · ${esc(buyerState.stop || 'starting')}</div>`;
  ui.renderStatus(status);
  if (settings.ops.goldenPick) {
    const g = goldenPickStatus(game.G);
    if (!g.on) html += `<div class="err">Golden picks: OFF, ${g.recentMisses} of the last ${g.recent} predictions missed. Ask for a re-check.</div>`;
  }
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
