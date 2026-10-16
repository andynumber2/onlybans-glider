// Opens the local game copy (research/site/, from scripts/fetch.sh) in headless
// Chromium, served in place of onlybans.wtf with all other network blocked,
// and injects the built userscript. Shared by the offline browser checks.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'research/site';

export async function openOfflineGame({ viewport = { width: 1400, height: 900 }, settings = null, start = false } = {}) {
  const script = await readFile('dist/onlybans-glider.user.js', 'utf8');
  const bundlePath = (await readFile(path.join(SITE, 'LATEST'), 'utf8')).trim();
  const indexHtml = await readFile(path.join(SITE, 'index.html'), 'utf8');

  const browser = await chromium.launch();
  const context = await browser.newContext({ bypassCSP: true, viewport });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'onlybans.wtf') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: indexHtml });
    if (/^\/assets\/index-.*\.js$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(bundlePath, 'utf8') });
    }
    if (/^\/assets\/[\w.-]+\.css$/.test(url.pathname)) {
      const body = await readFile(path.join(SITE, url.pathname)).catch(() => null);
      if (body) return route.fulfill({ contentType: 'text/css', body });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('https://onlybans.wtf/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.OnlyBans && window.OnlyBans.G);
  await page.evaluate(({ settings, start }) => {
    if (start) [...document.querySelectorAll('button')].find(b => /GET FUNDED/i.test(b.textContent))?.click();
    if (settings) localStorage.setItem('onlybans-glider-settings', JSON.stringify(settings));
  }, { settings, start });
  await page.addScriptTag({ content: script });
  await page.waitForSelector('#obh .content:not(.muted)', { timeout: 20000 });
  return { browser, page, errors };
}
