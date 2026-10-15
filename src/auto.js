// Auto mode: executes the planner's buy-now steps by clicking the game's own
// store elements. Each click runs the same handler a human click does, so the
// purchase goes through the game's input recorder like any other input.

const MAX_CLICKS_PER_CYCLE = 15;
const CLICK_GAP_MS = [120, 260];
// Utility upgrades (no production effect) are bought once they cost no more
// than this many seconds of current income. Checked before the production
// path so steady buying never starves them.
export const UTILITY_MAX_SECONDS = 600;

let busy = false;

// Returns the number of purchases made. Never overlaps itself.
export async function autoBuy(game, path, utilities = []) {
  if (busy) return 0;
  busy = true;
  try {
    const arms = armsRacePick(game);
    if (arms && !game.G.ascending && clickUpgrade(game, arms)) return 1;
    const util = utilities.find(u => u.price <= game.G.s.bans && u.price <= UTILITY_MAX_SECONDS * game.G.bps);
    if (util && !game.G.ascending && clickUpgrade(game, util.def)) return 1;
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
    return price <= s.bans && price <= maxSeconds * G.bps;
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
