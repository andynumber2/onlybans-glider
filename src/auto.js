// Auto mode: executes the planner's buy-now steps by clicking the game's own
// store elements. Each click runs the same handler a human click does, so the
// purchase goes through the game's input recorder like any other input.

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
export const UTILITY_MAX_SECONDS = 600;

let busy = false;
// Why the last cycle stopped buying, for the panel and the stats export.
export const buyerState = { stop: '' };

// Returns the number of purchases made. Never overlaps itself.
export async function autoBuy(game, path, utilities = [], ops = {}) {
  if (busy) {
    buyerState.stop = 'previous cycle still running';
    return 0;
  }
  busy = true;
  try {
    reserve = auditReserve(game.G, ops);
    const arms = armsRacePick(game);
    if (arms && !game.G.ascending && clickUpgrade(game, arms)) return 1;
    const util = utilities.find(u => canAfford(game, u.price) && u.price <= UTILITY_MAX_SECONDS * game.G.bps);
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
      if (clicks >= MAX_CLICKS_PER_CYCLE) buyerState.stop = 'click cap for this cycle';
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

export function armsRacePick(game) {
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
