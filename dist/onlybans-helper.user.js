// ==UserScript==
// @name         OnlyBans planner
// @namespace    onlybans-strategy
// @version      0.2.0
// @description  Read-only overlay that plans the most efficient purchases in onlybans.wtf
// @match        *://onlybans.wtf/*
// @match        *://*.onlybans.wtf/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
'use strict';

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
// Objective: maximize  bank(H) + rate(H) * H.
// The tail term values production for one more horizon, so a purchase is worth
// making when it pays back within roughly (2H - time until affordable).

// Cap on purchases made in the "spend now" phase, to bound planning time.
const MAX_NOW_BUYS = 100;

function plan(sim, { bank, horizon, depth = 3, beam = 5 }) {
  const rateStart = sim.rate();
  const ranked = rankCandidates(sim, { t: 0, bank, rate: rateStart }, horizon);

  // Phase 1: while the best-scoring item is affordable now and pays back
  // within the objective's break-even (2H), buy it. Late game this can be
  // dozens of purchases, which a depth-limited search would never reach.
  const nowSteps = [];
  let nowBank = bank;
  try {
    let top = ranked[0];
    while (top && top.wait === 0 && top.payback < 2 * horizon && nowSteps.length < MAX_NOW_BUYS) {
      sim.apply(top.item);
      nowBank -= top.price;
      nowSteps.push({ item: top.item, price: top.price, at: 0, gain: top.gain, rateAfter: top.rateAfter });
      top = rankCandidates(sim, { t: 0, bank: nowBank, rate: top.rateAfter }, horizon)[0];
    }
    const ahead = lookahead(sim, nowBank, horizon, depth, beam);
    return { rate: rateStart, path: [...nowSteps, ...ahead], candidates: ranked };
  } finally {
    for (let i = 0; i < nowSteps.length; i++) sim.undo();
  }
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
  for (const val of Object.values(mod)) {
    if (val && typeof val === 'object' && typeof val.calculateGains === 'function' && val.G) logic = val;
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

  return { logic, G: logic.G, buildings, upgrades, build: script.src.split('/').pop() };
}

// Runs fn(sim) with the live state temporarily mutated, then restores it.
// Synchronous on purpose: the game loop cannot interleave with us.
function withSandbox(game, { clicksPerSec = 0 } = {}, fn) {
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

// ---- src/overlay.js ----
// Overlay panel. Read-only: it never clicks, buys, or edits game state.

const SETTINGS_KEY = 'onlybans-helper-settings';
const HORIZONS = [
  ['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['12h', 43200], ['2d', 172800],
];
const DEFAULTS = { auto: false, horizon: 900, clicksPerSec: 0, depth: 3, beam: 5, collapsed: false, x: 12, y: 12 };

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

const CSS = `
#obh { position: fixed; z-index: 99999; width: 340px; font: 12px/1.35 ui-monospace, Menlo, monospace;
  color: #e6ebff; background: rgba(10,13,24,.94); border: 2px solid #f5c542; border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,.6); }
#obh header { display: flex; gap: 6px; align-items: center; padding: 4px 6px; background: #f5c542;
  color: #111; cursor: move; user-select: none; font-weight: 700; }
#obh header span { flex: 1; }
#obh header button { all: unset; cursor: pointer; padding: 0 4px; font-weight: 700; }
#obh header button[data-act="auto"] { border: 1px solid #111; border-radius: 3px; font-size: 10px; }
#obh header button[data-act="auto"].on { background: #c62828; color: #fff; border-color: #c62828; }
#obh .body { padding: 6px 8px; max-height: 70vh; overflow: auto; }
#obh.collapsed .body { display: none; }
#obh .controls { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
#obh select, #obh input { background: #1a2036; color: #e6ebff; border: 1px solid #39425f; font: inherit; }
#obh input { width: 44px; }
#obh .next { font-size: 14px; padding: 6px; margin-bottom: 6px; background: #1d2a1a; border-left: 4px solid #6fdc6f; }
#obh .next b { color: #6fdc6f; }
#obh .muted { color: #8592b3; }
#obh table { width: 100%; border-collapse: collapse; margin-top: 4px; }
#obh th, #obh td { padding: 1px 3px; text-align: right; white-space: nowrap; }
#obh th:first-child, #obh td:first-child { text-align: left; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
#obh th { color: #8592b3; font-weight: 400; border-bottom: 1px solid #39425f; }
#obh h4 { margin: 8px 0 2px; color: #f5c542; font-size: 12px; }
#obh .err { color: #ff6b6b; white-space: pre-wrap; }
#buildings .product.obh-pick { outline: 3px solid #6fdc6f; outline-offset: -3px; }
`;

function createOverlay({ onChange, onRefresh }) {
  const settings = loadSettings();
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'obh';
  root.style.left = settings.x + 'px';
  root.style.top = settings.y + 'px';
  if (settings.collapsed) root.classList.add('collapsed');
  root.innerHTML = `
    <header><span>OnlyBans planner</span>
      <button data-act="auto" title="Auto-buy the plan's buy-now list">AUTO</button>
      <button data-act="refresh" title="Replan now">⟳</button>
      <button data-act="collapse" title="Collapse">–</button></header>
    <div class="body">
      <div class="controls">
        <label>Horizon <select data-set="horizon">${HORIZONS.map(([l, v]) =>
          `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>Clicks/s <input data-set="clicksPerSec" type="number" min="0" max="20" step="1"></label>
        <label>Depth <input data-set="depth" type="number" min="1" max="5" step="1"></label>
      </div>
      <div class="content muted">Binding to game…</div>
    </div>`;
  document.body.appendChild(root);

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
  root.querySelector('[data-act="collapse"]').addEventListener('click', () => {
    settings.collapsed = !settings.collapsed;
    root.classList.toggle('collapsed', settings.collapsed);
    saveSettings(settings);
  });
  makeDraggable(root, root.querySelector('header'), (x, y) => {
    settings.x = x;
    settings.y = y;
    saveSettings(settings);
  });

  const content = root.querySelector('.content');
  return {
    settings,
    render(html) {
      content.classList.remove('muted');
      content.innerHTML = html;
    },
  };
}

function makeDraggable(el, handle, onDrop) {
  let start = null;
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    start = { x: e.clientX - el.offsetLeft, y: e.clientY - el.offsetTop };
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
    onDrop(el.offsetLeft, el.offsetTop);
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

const MAX_CLICKS_PER_CYCLE = 15;
const CLICK_GAP_MS = [120, 260];

let busy = false;

// Returns the number of purchases made. Never overlaps itself.
async function autoBuy(game, path) {
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

// ---- src/main.js ----
// Entry point: wait for the game, bind to it, replan on a timer.

const REPLAN_MS = 2000;
const BUY_NOW_ROWS = 6;

async function waitForGame() {
  for (let i = 0; i < 300; i++) {
    if (window.OnlyBans && window.OnlyBans.G && window.OnlyBans.G.s) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('window.OnlyBans never appeared (game changed or failed to load)');
}

async function start() {
  let game = null;
  const ui = createOverlay({
    onChange: () => tick(),
    onRefresh: () => rebind(),
  });

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

  async function tick() {
    if (!game || game.G.ascending) return;
    // A hidden tab only matters for display; auto mode keeps buying.
    if (document.hidden && !ui.settings.auto) return;
    let result;
    try {
      result = render(game, ui, autoBought);
    } catch (e) {
      ui.render(`<div class="err">Planner error: ${esc(e.stack ?? e.message)}</div>`);
      return;
    }
    if (ui.settings.auto) autoBought += await autoBuy(game, result.path);
  }

  await rebind();
  setInterval(tick, REPLAN_MS);
}

function render(game, ui, autoBought) {
  const { settings } = ui;
  const bank = game.G.s.bans;
  const t0 = performance.now();
  const result = withSandbox(game, settings, sim =>
    plan(sim, { bank, horizon: settings.horizon, depth: settings.depth, beam: settings.beam }));
  const ms = performance.now() - t0;

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

  const special = specialUpgrades(game);
  if (special.length) {
    html += `<h4>Not planned (arms race)</h4>`;
    html += special.map(u => `<div>${esc(iconText(u.icon))} ${esc(u.name)}</div>`).join('');
  }

  html += `<div class="muted" style="margin-top:6px">rate ${fmtNum(result.rate)}/s (no buffs) · bank ${fmtNum(bank)}
    · ${ms.toFixed(0)}ms · ${esc(game.build)}</div>`;
  if (settings.auto) html += `<div class="muted">auto: ${autoBought} bought this session</div>`;
  ui.render(html);
  return result;
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
