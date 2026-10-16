// Offline check of "Anti anti-cheat" (src/input.js), which the simulator can't
// test because jsdom has no layout. Runs the local game copy in headless
// Chromium (scripts/offline-game.mjs) with AUTO on and money in the bank:
//   1. Human mode, a test pop-up covering the page: no hammer clicks and no
//      purchases get through.
//   2. Pop-up removed: clicking and buying resume.
//   3. Anti anti-cheat off, pop-up back: the hammer clicks through it at about
//      14/s, never more than 15 in a second, and the game's auto-clicker flag
//      stays off.
// Usage: npm run check:stealth (also part of npm run release).
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

const failures = [];

// 1. Covered: nothing gets through.
await popup(true);
await fund();
await page.waitForTimeout(500);
const before = await state();
await page.waitForTimeout(8000);
const covered = await state();
if (covered.clicks !== before.clicks) failures.push(`human mode: ${covered.clicks - before.clicks} hammer clicks went through the pop-up`);
if (covered.owned !== before.owned) failures.push(`human mode: ${covered.owned - before.owned} purchases went through the pop-up`);

// 2. Uncovered: buying (immediate with money in the bank) and clicking resume.
await popup(false);
let resumed = null;
for (let i = 0; i < 20 && !resumed; i++) {
  await page.waitForTimeout(1000);
  const now = await state();
  if (now.owned > covered.owned && now.clicks > covered.clicks) resumed = now;
}
if (!resumed) failures.push('human mode: clicking and buying did not both resume within 20 s after the pop-up closed');

// 3. Off: the hammer clicks through the pop-up, steady and under 15/s.
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

await browser.close();
if (errors.length) failures.push('page errors: ' + errors.slice(0, 3).join(' | '));
if (failures.length) {
  console.log('FAIL: anti anti-cheat\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`PASS: pop-up blocked all clicks in human mode, clicks resumed, steady ${perSecond.join(',')} clicks/s with it off`);
