import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, groupSteps, waitFor, trendEta, sequelPlan, endgameShip, PRESTIGE, SHIP_RAMP_S } from '../src/planner.js';

// Minimal Cookie Clicker style economy: price grows 15% per owned unit.
function mockSim(defs, { upgrades = [] } = {}) {
  const owned = Object.fromEntries(defs.map(d => [d.id, 0]));
  const bought = new Set();
  const stack = [];
  return {
    candidates: () => [
      ...defs.map(def => ({ type: 'building', def })),
      ...upgrades.filter(u => !bought.has(u.id)).map(def => ({ type: 'upgrade', def })),
    ],
    price: item => item.type === 'building'
      ? item.def.cost * Math.pow(1.15, owned[item.def.id])
      : item.def.price,
    rate: () => defs.reduce((sum, d) => {
      const mult = upgrades.filter(u => bought.has(u.id) && u.building === d.id).length ? 2 : 1;
      return sum + owned[d.id] * d.bps * mult;
    }, 0),
    apply(item) {
      if (item.type === 'building') {
        owned[item.def.id]++;
        stack.push(() => owned[item.def.id]--);
      } else {
        bought.add(item.def.id);
        stack.push(() => bought.delete(item.def.id));
      }
    },
    undo: () => stack.pop()(),
    owned,
  };
}

const key = i => i.type + ':' + i.def.id;

test('waitFor handles affordable, zero rate, and normal cases', () => {
  assert.equal(waitFor(10, 20, 0), 0);
  assert.equal(waitFor(10, 0, 0), Infinity);
  assert.equal(waitFor(10, 0, 2), 5);
});

test('prefers the better payback item when both are affordable', () => {
  const sim = mockSim([
    { id: 'cheap', cost: 10, bps: 0.1 },
    { id: 'good', cost: 100, bps: 5 },
  ]);
  sim.owned.cheap = 1;
  const r = plan(sim, { bank: 100, horizon: 600 });
  assert.equal(r.path[0].item.def.id, 'good');
});

test('ignores items that cannot be afforded within the horizon', () => {
  const sim = mockSim([
    { id: 'a', cost: 10, bps: 1 },
    { id: 'huge', cost: 1e12, bps: 1e9 },
  ]);
  sim.owned.a = 1;
  const r = plan(sim, { bank: 0, horizon: 300 });
  assert.ok(r.candidates.every(c => c.item.def.id !== 'huge'));
  assert.equal(r.path[0].item.def.id, 'a');
});

test('longer horizon allows saving for a big purchase', () => {
  const defs = [
    { id: 'small', cost: 100, bps: 0.5 },
    { id: 'big', cost: 5000, bps: 100 },
  ];
  const short = mockSim(defs);
  short.owned.small = 10;
  const rs = plan(short, { bank: 0, horizon: 60 });
  assert.ok(!rs.path.some(s => s.item.def.id === 'big'));

  const long = mockSim(defs);
  long.owned.small = 10;
  const rl = plan(long, { bank: 0, horizon: 7200 });
  assert.ok(rl.path.some(s => s.item.def.id === 'big'));
});

test('values upgrades through the rate function', () => {
  const sim = mockSim([{ id: 'b', cost: 1000, bps: 1 }], {
    upgrades: [{ id: 'x2', price: 50, building: 'b' }],
  });
  sim.owned.b = 20;
  const r = plan(sim, { bank: 50, horizon: 600 });
  assert.equal(r.path[0].item.def.id, 'x2');
});

test('sandbox state is fully restored after planning', () => {
  const sim = mockSim([{ id: 'a', cost: 10, bps: 1 }, { id: 'b', cost: 50, bps: 6 }]);
  sim.owned.a = 3;
  const before = sim.rate();
  plan(sim, { bank: 500, horizon: 900, depth: 4 });
  assert.equal(sim.rate(), before);
  assert.deepEqual(sim.owned, { a: 3, b: 0 });
});

test('spends a large bank on many buys now, beyond search depth', () => {
  const sim = mockSim([{ id: 'a', cost: 100, bps: 10 }]);
  sim.owned.a = 5;
  const r = plan(sim, { bank: 1e6, horizon: 900, depth: 3 });
  const now = r.path.filter(s => s.at === 0).length;
  assert.ok(now > 20, `expected many buys now, got ${now}`);
  assert.equal(sim.owned.a, 5);
});

test('buy-now phase skips items that do not pay back within 2H', () => {
  const sim = mockSim([{ id: 'slow', cost: 1e6, bps: 1 }]);
  const r = plan(sim, { bank: 1e7, horizon: 60 });
  assert.equal(r.path.length, 0);
});

// Sim where owning 10 of "a" unlocks a ×10 upgrade: one-at-a-time greedy
// prefers "b", but the bundle "a up to 10 + upgrade" pays back far faster.
function thresholdSim() {
  const owned = { a: 8, b: 0 };
  const bought = new Set();
  const stack = [];
  const a = { id: 'a', cost: 100, bps: 1 };
  const b = { id: 'b', cost: 100, bps: 1.2 };
  const up = { id: 'x10', price: 50 };
  const sim = {
    candidates() {
      const out = [{ type: 'building', def: a }, { type: 'building', def: b }];
      if (owned.a >= 10 && !bought.has('x10')) out.push({ type: 'upgrade', def: up });
      if (owned.a < 10 && !bought.has('x10')) {
        const parts = [];
        for (let i = owned.a; i < 10; i++) parts.push({ type: 'building', def: a });
        parts.push({ type: 'upgrade', def: up });
        out.push({ type: 'bundle', def: a, parts, label: 'a to 10 + x10' });
      }
      return out;
    },
    price(item) {
      if (item.type === 'bundle') {
        let total = 0;
        for (const p of item.parts) { total += sim.price(p); sim.apply(p); }
        for (let i = 0; i < item.parts.length; i++) sim.undo();
        return total;
      }
      if (item.type === 'upgrade') return item.def.price;
      return item.def.cost * Math.pow(1.15, owned[item.def.id] - (item.def.id === 'a' ? 8 : 0));
    },
    rate() {
      const mult = bought.has('x10') ? 10 : 1;
      return owned.a * a.bps * mult + owned.b * b.bps;
    },
    apply(item) {
      if (item.type === 'bundle') {
        const mark = stack.length;
        for (const p of item.parts) sim.apply(p);
        const undos = stack.splice(mark).reverse();
        stack.push(() => { for (const u of undos) u(); });
      } else if (item.type === 'building') {
        owned[item.def.id]++;
        stack.push(() => owned[item.def.id]--);
      } else {
        bought.add(item.def.id);
        stack.push(() => bought.delete(item.def.id));
      }
    },
    undo: () => stack.pop()(),
    owned, bought,
  };
  return sim;
}

test('bundles let the planner work toward a threshold unlock', () => {
  const sim = thresholdSim();
  const r = plan(sim, { bank: 500, horizon: 900 });
  assert.equal(r.path[0].item.def.id, 'a');
  assert.deepEqual(sim.owned, { a: 8, b: 0 });
  assert.equal(sim.bought.size, 0);
});

test('groupSteps collapses consecutive identical buys', () => {
  const a = { type: 'building', def: { id: 'a' } };
  const b = { type: 'building', def: { id: 'b' } };
  const g = groupSteps([
    { item: a, price: 1, at: 1, gain: 1, rateAfter: 2 },
    { item: a, price: 2, at: 3, gain: 1, rateAfter: 3 },
    { item: b, price: 5, at: 9, gain: 2, rateAfter: 5 },
  ], key);
  assert.equal(g.length, 2);
  assert.equal(g[0].count, 2);
  assert.equal(g[0].price, 3);
  assert.equal(g[0].at, 3);
});

test('trendEta extrapolates log growth of the current sequel', () => {
  const min = 60000;
  // 10x per 10 minutes, 20 points; an older sequel's points are ignored.
  const snaps = [{ t: 0, all: 1e40, sequels: 6 }];
  for (let i = 0; i < 20; i++) snaps.push({ t: (100 + i) * min, all: 1e30 * 10 ** (i / 10), sequels: 7 });
  const now = 119 * min;
  // Last point is 1e31.9; 1e33 is 1.1 decades away, i.e. 11 minutes.
  assert.ok(Math.abs(trendEta(snaps, 1e33, now) - 11 * min) < 1);
  assert.equal(trendEta(snaps.slice(0, 6), 1e33, 104 * min), null);
  const flat = snaps.map(x => ({ ...x, all: 1e30 }));
  assert.equal(trendEta(flat, 1e33, now), Infinity);
});

test('deadline objective counts earned bans, so spending is free', () => {
  // Income 1/s from 10 owned `a`. `b` costs 600 for +0.1/s: payback 6000 s.
  const sim = mockSim([{ id: 'a', cost: 1e9, bps: 0.1 }, { id: 'b', cost: 600, bps: 0.1 }]);
  sim.owned.a = 10;
  // Horizon 250 s (break-even 500 s): b does not pay back, save.
  assert.equal(plan(sim, { bank: 600, horizon: 250, depth: 1 }).path.length, 0);
  // 500 s left: buying b now adds 0.1 × 500 = 50 earned bans. Buy it.
  const r = plan(sim, { bank: 600, horizon: 250, depth: 1, deadline: 500 });
  assert.equal(r.path[0]?.item.def.id, 'b');
  // Nothing past the deadline is considered: with no bank, b is 600 s away.
  assert.equal(plan(sim, { bank: 0, horizon: 250, depth: 1, deadline: 500 }).path.length, 0);
});

test('sequelPlan times the last ship before the cap', () => {
  const state = { level: 1.81e8, reputation: 0, owned: new Set(PRESTIGE.map(p => p.key)), bansAllTime: 2.05e37 };
  // Cap far away: the ×2 rule decides, no endgame.
  assert.equal(sequelPlan(state, { cap: 1e45, rate: 1e33 }).endgame, undefined);
  // Next ×2 ship (~4.75e37) would be the last before 5e37: endgame mode.
  const unknown = sequelPlan(state, { cap: 5e37, rate: null });
  assert.equal(unknown.ship, false);
  assert.equal(unknown.endgame, null);
  // Slow income (cap ~83 h away): shipping beats never.
  const slow = sequelPlan(state, { cap: 5e37, rate: 1e32 });
  assert.ok(slow.endgame.seconds < slow.endgame.stay);
  assert.ok(slow.endgame.bestAt < 5e37);
  assert.equal(slow.ship, slow.endgame.bestAt === state.bansAllTime);
  // Cap closer than the ramp: never ship.
  const fast = endgameShip(state, 5e37, 3e37 / SHIP_RAMP_S);
  assert.equal(fast.ship, false);
  assert.equal(fast.bestAt, 5e37);
  assert.equal(fast.seconds, fast.stay);
});

test('lazy buy-now ranking matches the full ranking', () => {
  const pathKeys = r => r.path.map(s => key(s.item) + '@' + s.at.toFixed(6));
  const cases = [
    () => {
      const sim = mockSim([
        { id: 'a', cost: 10, bps: 0.5 },
        { id: 'b', cost: 120, bps: 7 },
        { id: 'c', cost: 1500, bps: 60 },
      ], { upgrades: [{ id: 'xa', price: 400, building: 'a' }, { id: 'xc', price: 9000, building: 'c' }] });
      sim.owned.a = 4;
      return sim;
    },
    thresholdSim,
  ];
  for (const make of cases) {
    for (const bank of [500, 1e4, 1e6]) {
      const full = plan(make(), { bank, horizon: 900, depth: 1, lazy: false });
      const lazy = plan(make(), { bank, horizon: 900, depth: 1 });
      assert.deepEqual(pathKeys(lazy), pathKeys(full));
    }
  }
});

test('lazy ranking measures fewer rates than the full ranking', () => {
  const defs = Array.from({ length: 12 }, (_, i) => ({ id: 'd' + i, cost: 10 * 8 ** i, bps: 0.5 * 6 ** i }));
  const counted = lazy => {
    const sim = mockSim(defs);
    sim.owned.d0 = 1;
    const rate = sim.rate;
    let n = 0;
    sim.rate = () => { n++; return rate(); };
    plan(sim, { bank: 1e9, horizon: 3600, depth: 1, lazy });
    return n;
  };
  const full = counted(false);
  const lazy = counted(true);
  assert.ok(lazy * 1.5 < full, `lazy ${lazy} vs full ${full}`);
});
