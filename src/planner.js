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

export function plan(sim, { bank, horizon, depth = 3, beam = 5 }) {
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
