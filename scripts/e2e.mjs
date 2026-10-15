// End-to-end check against the live game in a throwaway headless browser.
// Seeds a mid-game state with the game's own console cheats, injects the
// built userscript, and verifies: overlay renders, a plan exists, and the
// sandbox leaves game state untouched.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';

const script = await readFile('dist/onlybans-glider.user.js', 'utf8');
const browser = await chromium.launch();
const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto('https://onlybans.wtf/', { waitUntil: 'load' });
await page.waitForFunction(() => window.OnlyBans && window.OnlyBans.G);

// Seed: buy a spread of buildings so the planner has real choices.
await page.evaluate(async BANK => {
  const src = document.querySelector('script[type="module"][src*="/assets/index-"]').src;
  const mod = await import(src);
  const logic = Object.values(mod).find(v => v && typeof v.calculateGains === 'function');
  const G = logic.G;
  window.OnlyBans.cheat.addBans(5e6);
  const ids = Object.keys(G.s.buildings);
  for (let round = 0; round < 15; round++) {
    for (const id of ids.slice(0, 5)) logic.buyBuilding(id, 1);
  }
  logic.checkUnlocks();
  G.s.bans = Number(BANK);
}, process.env.BANK ?? '20000');

const snapshot = () => page.evaluate(() => {
  const s = window.OnlyBans.G.s;
  return JSON.stringify({
    amounts: Object.fromEntries(Object.entries(s.buildings).map(([k, v]) => [k, v.amount])),
    bought: [...s.upgradesBought].sort(),
    buffs: s.buffs.length,
  });
});

const before = await snapshot();
await page.addScriptTag({ content: script });
await page.waitForSelector('#obh .next', { timeout: 20000 });
await page.waitForTimeout(4500); // let a couple of replans run
const after = await snapshot();

const panel = await page.$eval('#obh .content', el => el.innerText);
await mkdir('research/e2e', { recursive: true });
await page.screenshot({ path: 'research/e2e/overlay.png' });
await browser.close();

console.log(panel);
console.log('---');
const failures = [];
if (before !== after) failures.push('game state changed during planning:\n' + before + '\n' + after);
if (!/Next:|Buy now/.test(panel)) failures.push('no recommendation rendered');
if (errors.length) failures.push('page errors: ' + errors.join(' | '));
if (failures.length) {
  console.log('FAIL\n' + failures.join('\n'));
  process.exit(1);
}
console.log('PASS: overlay rendered, plan produced, state untouched');
