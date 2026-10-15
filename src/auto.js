// Auto mode: executes the planner's buy-now steps by clicking the game's own
// store elements. Each click runs the same handler a human click does, so the
// purchase goes through the game's input recorder like any other input.

const MAX_CLICKS_PER_CYCLE = 15;
const CLICK_GAP_MS = [120, 260];

let busy = false;

// Returns the number of purchases made. Never overlaps itself.
export async function autoBuy(game, path) {
  if (busy) return 0;
  busy = true;
  try {
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
