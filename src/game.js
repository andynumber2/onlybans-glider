// Binds to the running game and provides a what-if sandbox for the planner.
//
// The game's bundle is an ES module. Importing the same URL returns the
// already-running instance, so we get the live tables without copying any
// numbers. Export names are minified and change between builds, so each export
// is identified by its contents instead.

// Upgrade kinds with side effects beyond production (arms race mechanics).
// Shown to the player but never auto-planned.
export const SPECIAL_KINDS = new Set(['escalation', 'truce', 'detente']);

export async function bindGame(win) {
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

export function withSandbox(game, { clicksPerSec = 0, bundles = true, goldenScale = 1 } = {}, fn) {
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
      return (G.rawBps + clicksPerSec * G.clickPower) * (1 + goldenScale * goldenShare(s) + waveShare(s));
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

// Hidden setting goldenEvScale (only with Golden picks): multiplies this share
// in the planner's rate, since picks plus the meltdown chain make a report
// worth far more than these all-clicked estimates (sim sweep, CLAUDE.md).
export function goldenShare(s) {
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
export const GOLD_RANK = ['meltdown', 'botFarmRaid', 'ringTakedown', 'bustedProvider', 'banWave', 'caughtOnStream', 'hotfix', 'exploitLeak', 'cheatUpdate'];

// The effect a click on this golden report (chain 0) would give right now.
// Mirrors the game's pick (`CT(wrath)`, build ClLVmN6W): clicking draws from
// the game's own RNG `s.rng` and nothing draws before the pick, so the
// answer is exact as long as the click is applied at once (not queued behind
// a leaderboard check-in). Reads state only.
export function predictGolden(game, shimmer) {
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
export function waveShare(s) {
  let depts = 0;
  for (const b of Object.values(s.buildings)) if (b.amount > 0) depts++;
  let fill = 240 / (1 + 0.04 * depts);
  if (s.upgradesBought.has('tool:dashboard')) fill /= 1.3;
  const mult = Math.round(3 + 1.5 * (WAVE_LAUNCH_AT - 1));
  return ((mult - 1) * 30) / (WAVE_LAUNCH_AT * fill);
}

export function armsStage(s) {
  const ar = s.armsRace;
  if (!ar || ar.detente || ar.truceT > 0) return 0;
  return ar.stage;
}

// Unlocked, unbought upgrades that add nothing to production as calculated
// (golden report frequency, audit tools, etc.). The planner can't value
// these, so they're bought by a price rule instead (see auto.js).
export function utilityUpgrades(game, opts) {
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
export function buffCost(game, buffKey) {
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

export function itemKey(item) {
  return item.type + ':' + item.def.id;
}

export function itemLabel(item) {
  if (item.type === 'bundle') return `${iconText(item.def.icon)} ${item.label}`.trim();
  return `${iconText(item.def.icon)} ${item.def.name}`.trim();
}

// Some icons are sprite tokens ("sprite:NAME") drawn by the game; skip those.
export function iconText(icon) {
  if (!icon || icon.startsWith('sprite:')) return '';
  return icon;
}

// Special upgrades the player can buy right now, listed separately.
export function specialUpgrades(game) {
  const s = game.G.s;
  return game.upgrades.filter(u =>
    SPECIAL_KINDS.has(u.kind) && s.upgradesUnlocked.has(u.id) && !s.upgradesBought.has(u.id));
}
