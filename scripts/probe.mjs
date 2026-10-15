// Loads the live game headless and reports what the overlay can bind to.
// Run this after a game update to see whether the bindings still hold.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await (await browser.newContext({ bypassCSP: true })).newPage();
await page.goto('https://onlybans.wtf/', { waitUntil: 'load' });
await page.waitForFunction(() => window.OnlyBans && window.OnlyBans.G);

const report = await page.evaluate(async () => {
  const src = document.querySelector('script[type="module"][src*="/assets/index-"]').src;
  const mod = await import(src);
  const out = { src, exports: Object.keys(mod).length };
  for (const [name, val] of Object.entries(mod)) {
    if (val && typeof val === 'object' && typeof val.calculateGains === 'function') {
      out.logicExport = name;
      out.logicKeys = Object.keys(val);
      out.sameG = val.G === window.OnlyBans.G;
    }
    if (Array.isArray(val) && val.length && typeof val[0] === 'object' && 'baseCost' in val[0] && 'baseBps' in val[0]) {
      out.buildingsExport = name;
      out.buildings = val.map(b => `${b.id}:${b.baseCost}:${b.baseBps}`);
    }
    if (Array.isArray(val) && val.length && typeof val[0] === 'object' && typeof val[0].unlock === 'function' && 'kind' in val[0]) {
      out.upgradesExport = name;
      out.upgradeCount = val.length;
      const kinds = {};
      for (const u of val) kinds[u.kind] = (kinds[u.kind] ?? 0) + 1;
      out.upgradeKinds = kinds;
      out.upgradeSample = Object.keys(val[0]);
    }
  }
  const G = window.OnlyBans.G;
  out.stateKeys = Object.keys(G.s);
  out.bps = G.bps;
  out.rawBps = G.rawBps;
  return out;
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
