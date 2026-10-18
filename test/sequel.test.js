import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prestigeStars, prestigeBuys, sequelPlan } from '../src/planner.js';

test('stars are the exact integer cube root of bansAllTime / 1e12', () => {
  assert.equal(prestigeStars(0), 0);
  assert.equal(prestigeStars(999e9), 0);
  assert.equal(prestigeStars(1e12), 1);
  assert.equal(prestigeStars(27e12), 3);
  assert.equal(prestigeStars(27e12 - 1), 2);
  assert.equal(prestigeStars(7.7164688275347236e25), 42573);
});

test('buys review tiers first and reserves for the next tier', () => {
  assert.deepEqual(prestigeBuys(new Set(), 12), ['legacy', 'reputation1']);
  assert.deepEqual(prestigeBuys(new Set(), 1123), ['legacy', 'reputation1', 'reputation2']);
  const big = prestigeBuys(new Set(), 42573);
  assert.ok(big.includes('reputation2') && !big.includes('reputation3'));
  assert.ok(big.includes('starterMods') && big.includes('luckyReports2') && big.includes('offline2'));
  assert.ok(!big.includes('luckyReports3') && !big.includes('offline3'));
  assert.ok(prestigeBuys(new Set(), 42580, { spendAll: true }).includes('offline3'));
});

test('requirements gate purchases', () => {
  const buys = prestigeBuys(new Set(), 200);
  assert.ok(buys.indexOf('starterMacros') < buys.indexOf('starterMods') || !buys.includes('starterMods'));
  assert.deepEqual(prestigeBuys(new Set(), 0), []);
});

test('ships only when production would at least quadruple', () => {
  const none = new Set();
  assert.equal(sequelPlan({ level: 0, reputation: 0, owned: none, bansAllTime: 1e20 }).ship, false); // 464 stars: x1.23
  const first = sequelPlan({ level: 0, reputation: 0, owned: none, bansAllTime: 7.7164688275347236e25 });
  assert.equal(first.pending, 42573);
  assert.ok(first.ship && first.multAfter > 100);
  const owned = new Set(['legacy', 'reputation1', 'reputation2']);
  // x2 from more stars alone is not enough...
  assert.equal(sequelPlan({ level: 42573, reputation: 40098, owned, bansAllTime: 6.3e26 }).ship, false);
  // ...but Very Positive becoming affordable (share 25% -> 50%) is.
  assert.equal(sequelPlan({ level: 42573, reputation: 40098, owned, bansAllTime: 1.47e27 }).ship, true);
  assert.equal(sequelPlan({ level: 42573, reputation: 0, owned, bansAllTime: 0 }).pending, 0);
});
