// Live check of auto mode: purchases happen via store clicks and show up in
// the game's recorded input log (localStorage "click2ban-lb").
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const script = await readFile('dist/onlybans-glider.user.js', 'utf8');
const browser = await chromium.launch();
const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('https://onlybans.wtf/', { waitUntil: 'load' });
await page.waitForFunction(() => window.OnlyBans && window.OnlyBans.G);

// Dismiss the intro if present by picking the "Get Funded" start.
await page.getByText('GET FUNDED').click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1000);
await page.evaluate(() => {
  localStorage.setItem('onlybans-glider-settings', JSON.stringify({ auto: true }));
  window.OnlyBans.G.s.bans = 5e4;
});

const counts = () => page.evaluate(() => {
  const s = window.OnlyBans.G.s;
  let log = { recording: null, b: 0, u: 0 };
  try {
    const lb = JSON.parse(localStorage.getItem('click2ban-lb') ?? 'null');
    if (lb) {
      const actions = [...(lb.open ?? []), ...(lb.pending ?? []).flatMap(p => JSON.parse(p.batch))];
      log = {
        recording: lb.recording, ineligible: lb.ineligible ?? null,
        b: actions.filter(a => a[1] === 'b').length,
        u: actions.filter(a => a[1] === 'u').length,
      };
    }
  } catch (e) { log.err = String(e); }
  return {
    buildings: Object.values(s.buildings).reduce((n, b) => n + b.amount, 0),
    upgrades: s.upgradesBought.size,
    bans: Math.round(s.bans),
    log,
  };
});

const before = await counts();
await page.addScriptTag({ content: script });
await page.waitForTimeout(12000);
await page.keyboard.press('Meta+s');
await page.waitForTimeout(500);
const raw = await page.evaluate(() => {
  const lb = JSON.parse(localStorage.getItem('click2ban-lb') ?? 'null');
  if (!lb) return null;
  return { keys: Object.keys(lb), open: (lb.open ?? []).slice(0, 12), pending: (lb.pending ?? []).length,
    firstBatch: lb.pending && lb.pending[0] ? lb.pending[0].batch.slice(0, 300) : null };
});
console.log('raw log', JSON.stringify(raw));
const after = await counts();
await page.screenshot({ path: 'research/e2e/auto.png' });
const footer = await page.$eval('#obh .content', el => el.innerText.split('\n').slice(-2).join(' | '));
await browser.close();

console.log('before', JSON.stringify(before));
console.log('after ', JSON.stringify(after));
console.log('panel ', footer);
if (errors.length) console.log('page errors:', errors);
const bought = after.buildings - before.buildings + after.upgrades - before.upgrades;
console.log(bought > 0 ? `PASS: auto bought ${bought}` : 'FAIL: nothing bought');
