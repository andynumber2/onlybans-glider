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
export function withSandbox(game, { clicksPerSec = 0 } = {}, fn) {
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
export function buffCost(game, buffKey) {
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

export function itemKey(item) {
  return item.type + ':' + item.def.id;
}

export function itemLabel(item) {
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
