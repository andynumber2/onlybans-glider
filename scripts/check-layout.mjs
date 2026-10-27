// Offline layout check for the overlay panel: no horizontal overflow, ever.
// Runs the local game copy (research/site/, served in place of onlybans.wtf with
// all other network blocked) in headless Chromium, injects the built
// userscript, pushes the bank through several magnitudes so numbers get long,
// opens every <details>, and fails if any part of the panel is wider than the
// panel. Vertical scrolling is fine; horizontal scrolling is not.
// Usage: npm run check:layout (also run by npm run build:check).
import { mkdir } from 'node:fs/promises';
import { openOfflineGame } from './offline-game.mjs';

const BANKS = [2e4, 5e12, 3e24, 7e36];
// The graph window opens with a synthetic 3 h run seeded into IndexedDB. The
// game's all-time bans are set to the run's last value so the graph does not
// take the first live sample for a new game and start over.
const GRAPH_END = 4e37;
const { browser, page, errors } = await openOfflineGame({
  settings: { graph: { open: true, x: 420, y: 12, w: 560, h: 340, span: 0 } },
  init: end => new Promise((resolve, reject) => {
    window.OnlyBans.G.s.bansAllTime = end;
    const points = [];
    const n = 2160;
    const t0 = Date.now() - n * 5000;
    let seq = 0;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      if (i % 300 === 299) seq++;
      const all = 10 ** (3 + 34.6 * f ** 0.8 + 0.3 * Math.sin(i / 40));
      points.push({ t: t0 + i * 5000, all: i === n - 1 ? end : all, bps: all / 2000, seq, boost: i % 97 < 4 });
    }
    const req = indexedDB.open('onlybans-glider', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(points, 'graph');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }),
  initArg: GRAPH_END,
});

const failures = [];
await mkdir('research/e2e', { recursive: true });
for (const bank of BANKS) {
  // Throwaway offline game: buy buildings directly so rates and prices get as
  // long as the bank, then open every section.
  await page.evaluate(async b => {
    const src = document.querySelector('script[type="module"][src*="/assets/index-"]').src;
    const logic = Object.values(await import(src)).find(v => v && typeof v.calculateGains === 'function');
    const G = logic.G;
    G.s.bans = b * 50;
    const ids = Object.keys(G.s.buildings);
    for (let round = 0; round < 60; round++) {
      for (const id of ids) logic.buyBuilding(id, 5);
    }
    logic.checkUnlocks();
    G.s.bans = b;
    for (const d of document.querySelectorAll('#obh details')) d.open = true;
  }, bank);
  await page.click('#obh [data-act="refresh"]');
  await page.waitForTimeout(3000);
  // Any element wider than its own box (outside an ellipsis cell), or the
  // scrolling body wider than its viewport, is a horizontal scrollbar.
  const wide = await page.evaluate(() => {
    const body = document.querySelector('#obh .body');
    const out = [];
    if (body.scrollWidth > body.clientWidth + 1) {
      out.push(`.body scrollWidth ${body.scrollWidth} > clientWidth ${body.clientWidth}`);
    }
    const right = body.getBoundingClientRect().right;
    for (const el of body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > right + 1) out.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}" ends ${Math.round(r.right - right)}px past the panel`);
    }
    return out.slice(0, 8);
  });
  await page.screenshot({ path: `research/e2e/layout-${bank.toExponential(0)}.png`, clip: await page.$eval('#obh', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }) });
  if (wide.length) failures.push(`bank ${bank.toExponential(0)}:\n  ` + wide.join('\n  '));
}

// The graph window: open, drawn, and nothing in it wider than the window.
const graphIssues = await page.evaluate(() => {
  const win = document.querySelector('#obh .obhGraph');
  if (!win || !win.classList.contains('open')) return ['graph window not open'];
  const out = [];
  if (win.scrollWidth > win.clientWidth + 1) out.push(`graph scrollWidth ${win.scrollWidth} > clientWidth ${win.clientWidth}`);
  const right = win.getBoundingClientRect().right;
  for (const el of win.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > right + 1) out.push(`graph ${el.tagName.toLowerCase()} ends ${Math.round(r.right - right)}px past the window`);
  }
  return out.slice(0, 8);
});
await page.screenshot({ path: 'research/e2e/layout-graph.png', clip: await page.$eval('#obh .obhGraph', el => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}) });
if (graphIssues.length) failures.push('graph:\n  ' + graphIssues.join('\n  '));
await browser.close();

if (errors.length) failures.push('page errors: ' + errors.slice(0, 3).join(' | '));
if (failures.length) {
  console.log('FAIL: horizontal overflow\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`PASS: no horizontal overflow at ${BANKS.length} bank sizes (screenshots in research/e2e/)`);
