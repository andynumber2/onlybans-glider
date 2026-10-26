// Offline check of "Anti anti-cheat" (src/input.js), which the simulator can't
// test because jsdom has no layout. Runs the local game copy in headless
// Chromium (scripts/offline-game.mjs) with AUTO on and money in the bank:
//   1. Human mode, a test pop-up covering the page: no hammer clicks and no
//      purchases get through.
//   2. Pop-up removed: clicking and buying resume.
//   3. Anti anti-cheat off, pop-up back: the hammer clicks through it at about
//      14/s, never more than 15 in a second, and the game's auto-clicker flag
//      stays off.
// When a step fails, it saves a screenshot and the page state at that moment
// (what covers the hammer, overlays, buffs, the panel's status and log) to
// research/e2e/stealth-fail-<step>.png and .json.
// Usage: npm run check:stealth (also part of npm run release).
import { mkdir, writeFile } from 'node:fs/promises';
import { openOfflineGame } from './offline-game.mjs';

const { browser, page, errors } = await openOfflineGame({ settings: { auto: true, stealth: true }, start: true });

// Throwaway offline game: money so the auto-buyer has purchases to make.
const fund = () => page.evaluate(() => { window.OnlyBans.G.s.bans = 1e7; });
const state = () => page.evaluate(() => {
  const s = window.OnlyBans.G.s;
  return {
    clicks: s.clicks,
    owned: Object.values(s.buildings).reduce((a, b) => a + b.amount, 0),
    flagged: s.achievements.has('autoClicker'),
  };
});
const popup = on => page.evaluate(show => {
  document.querySelector('#testPopup')?.remove();
  if (!show) return;
  const el = Object.assign(document.createElement('div'), { id: 'testPopup' });
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.4)';
  document.body.appendChild(el);
}, on);

async function capture(step) {
  await mkdir('research/e2e', { recursive: true });
  await page.screenshot({ path: `research/e2e/stealth-fail-${step}.png`, fullPage: true });
  const info = await page.evaluate(() => {
    const G = window.OnlyBans.G;
    const s = G.s;
    const describe = el => {
      if (!el) return null;
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(' ').filter(Boolean).join('.') : '';
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
    };
    const hammer = document.querySelector('#hammerHit');
    const r = hammer?.getBoundingClientRect();
    const top = r && r.width ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    const overlays = [...document.querySelectorAll('body *')].filter(el => {
      const cs = getComputedStyle(el);
      return (cs.position === 'fixed' || cs.position === 'absolute') && Number(cs.zIndex) >= 100 &&
        cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetWidth > 0;
    }).map(describe).slice(0, 30);
    const panel = document.querySelector('#obh');
    return {
      time: new Date().toISOString(), hidden: document.hidden, ascending: !!G.ascending,
      clicks: s.clicks, owned: Object.values(s.buildings).reduce((a, b) => a + b.amount, 0), bans: s.bans,
      hammerRect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null, hammerCoveredBy: describe(top),
      overlays, buffs: s.buffs.map(b => b.key), weird: s.weird?.key ?? null, incidents: (s.incidents ?? []).map(i => i.key),
      settings: localStorage.getItem('onlybans-glider-settings'),
      panelLog: [...(panel?.querySelectorAll('.opsLog > *') ?? [])].slice(0, 15).map(el => el.textContent),
      panelText: panel?.textContent.slice(0, 2000) ?? null,
    };
  });
  await writeFile(`research/e2e/stealth-fail-${step}.json`, JSON.stringify({ ...info, pageErrors: errors.slice(0, 10) }, null, 2));
}

const failures = [];
const failedSince = n => failures.length > n;

// 1. Covered: nothing gets through.
await popup(true);
await fund();
await page.waitForTimeout(500);
const before = await state();
await page.waitForTimeout(8000);
const covered = await state();
if (covered.clicks !== before.clicks) failures.push(`human mode: ${covered.clicks - before.clicks} hammer clicks went through the pop-up`);
if (covered.owned !== before.owned) failures.push(`human mode: ${covered.owned - before.owned} purchases went through the pop-up`);
if (failedSince(0)) await capture('covered');

// 2. Uncovered: buying (immediate with money in the bank) and clicking resume.
await popup(false);
let resumed = null;
for (let i = 0; i < 20 && !resumed; i++) {
  await page.waitForTimeout(1000);
  const now = await state();
  if (now.owned > covered.owned && now.clicks > covered.clicks) resumed = now;
}
if (!resumed) {
  failures.push('human mode: clicking and buying did not both resume within 20 s after the pop-up closed');
  await capture('resume');
}

// 3. Off: the hammer clicks through the pop-up, steady and under 15/s.
const beforeOff = failures.length;
await page.evaluate(() => document.querySelector('#obh [data-flag="stealth"]').click());
await popup(true);
await page.waitForTimeout(1000);
const perSecond = [];
let last = (await state()).clicks;
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(1000);
  const now = (await state()).clicks;
  perSecond.push(now - last);
  last = now;
}
const total = perSecond.reduce((a, x) => a + x, 0);
if (total < 50) failures.push(`stealth off: only ${total} hammer clicks in 6 s (${perSecond.join(',')})`);
if (Math.max(...perSecond) > 15) failures.push(`stealth off: over 15 clicks in a second (${perSecond.join(',')})`);
if ((await state()).flagged) failures.push('stealth off: the game flagged the auto-clicker');
if (failedSince(beforeOff)) await capture('off');

await browser.close();
if (errors.length) failures.push('page errors: ' + errors.slice(0, 3).join(' | '));
if (failures.length) {
  console.log('FAIL: anti anti-cheat\n  ' + failures.join('\n  ') + '\n  (screenshots and page state: research/e2e/stealth-fail-*)');
  process.exit(1);
}
console.log(`PASS: pop-up blocked all clicks in human mode, clicks resumed, steady ${perSecond.join(',')} clicks/s with it off`);
