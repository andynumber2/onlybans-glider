// Checks that the panel replans after the player buys the recommended item.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const script = await readFile('dist/onlybans-glider.user.js', 'utf8');
const browser = await chromium.launch();
const page = await (await browser.newContext({ bypassCSP: true })).newPage();
await page.goto('https://onlybans.wtf/', { waitUntil: 'load' });
await page.waitForFunction(() => window.OnlyBans && window.OnlyBans.G);
await page.evaluate(async () => {
  const mod = await import(document.querySelector('script[type="module"][src*="/assets/index-"]').src);
  const logic = Object.values(mod).find(v => v && typeof v.calculateGains === 'function');
  window.__logic = logic;
  window.__upgrades = Object.values(mod).find(v => Array.isArray(v) && v[0] && typeof v[0].unlock === 'function');
  window.__buildings = Object.values(mod).find(v => Array.isArray(v) && v[0] && 'baseCost' in Object(v[0]));
  window.OnlyBans.cheat.addBans(5e6);
  for (let i = 0; i < 15; i++) for (const id of Object.keys(logic.G.s.buildings).slice(0, 5)) logic.buyBuilding(id, 1);
  logic.checkUnlocks();
  logic.G.s.bans = 1e6;
});
await page.addScriptTag({ content: script });
await page.waitForSelector('#obh .next');
await page.waitForTimeout(2500);

const readNext = () => page.$eval('#obh .next', el => el.innerText.replace(/\s+/g, ' '));
const readFooter = () => page.$eval('#obh .content > .muted:last-child', el => el.innerText);

for (let round = 0; round < 4; round++) {
  const next = await readNext();
  const footer = await readFooter();
  console.log(`round ${round}: ${next} | ${footer}`);
  // Buy whatever is recommended, the way the store would.
  const bought = await page.evaluate(nextText => {
    const logic = window.__logic;
    const name = nextText.replace(/^Next:\s*/, '').split(/ \d|×/)[0].trim();
    const b = window.__buildings.find(d => name.endsWith(d.name));
    if (b) return 'building ' + b.id + ' ' + logic.buyBuilding(b.id, 1);
    const up = window.__upgrades.find(u => name.endsWith(u.name));
    if (up) return 'upgrade ' + up.id + ' ' + logic.buyUpgrade(up.id);
    return 'no match for ' + name;
  }, next);
  console.log('  ', bought);
  await page.waitForTimeout(2500);
}
await browser.close();
