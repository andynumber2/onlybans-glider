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

// lazy: after each buy-now purchase, re-measure only the candidates that could
// rank first (lazyTop) instead of every candidate. From the 2026-10-19 save,
// 120 game-minutes, seeds 7-18: 6x fewer calculateGains calls per replan, and
// 36.142 vs 36.143 log10 bans (5 better, 6 worse, 1 tie). false is for tests.
export function plan(sim, { bank, horizon, depth = 3, beam = 5, lazy = true }) {
  const obj = objective(horizon);
  const rateStart = sim.rate();
  const ranked = rankCandidates(sim, { t: 0, bank, rate: rateStart }, obj);
  const gains = new Map();
  for (const c of ranked) gains.set(gainKey(c.item), gainEntry(c.item, c.price, c.gain, rateStart));

  // Phase 1: while the best-scoring item is affordable now and pays back
  // within the objective's break-even (2H), buy it. Late game this can be
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
function objective(horizon) {
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

export function waitFor(price, bank, rate) {
  if (bank >= price) return 0;
  if (!(rate > 0)) return Infinity;
  return (price - bank) / rate;
}

// Collapse consecutive identical purchases: [A, A, B] -> [{A x2}, {B x1}].
export function groupSteps(steps, keyOf) {
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
export const PRESTIGE = [
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
export const SHIP_GAIN = 2;
// With Golden picks (and its meltdown chain) a sequel's ramp is short, so a
// bigger jump per ship pays. Fresh run to the 5e37 cap, seeds 7-13
// (2026-10-25, v0.26.0): ×1.5 11.57 / ×2 9.13 / ×3 7.20 / ×4 7.50 / ×5 6.45 /
// ×6 6.52 / ×8 6.47 game hours; flat from ×5, ×6 is the middle.
export const SHIP_GAIN_PICKS = 6;

export function prestigeStars(bansAllTime) {
  if (!(bansAllTime >= 1e12)) return 0;
  const x = bansAllTime / 1e12;
  let t = Math.floor(Math.cbrt(x));
  while ((t + 1) ** 3 <= x) t++;
  while (t ** 3 > x) t--;
  return t;
}

export function prestigeShare(owned) {
  return TIERS.reduce((sum, p) => sum + (owned.has(p.key) ? p.share : 0), 0);
}

// What to buy with `reputation`, in purchase order.
export function prestigeBuys(owned, reputation, { spendAll = false } = {}) {
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
export function sequelPlan({ level, reputation, owned, bansAllTime }, { gain = SHIP_GAIN, spendAll = false } = {}) {
  const pending = Math.max(0, prestigeStars(bansAllTime) - level);
  const now = shipCheck(level, reputation, owned, pending, gain, spendAll);
  const target = now.ship ? null : shipTarget(level, reputation, owned, pending, gain, spendAll);
  return { pending, ...now, target };
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
export function trendEta(snaps, targetBans, now, { windowMs = 30 * 60e3, minPoints = 10 } = {}) {
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
