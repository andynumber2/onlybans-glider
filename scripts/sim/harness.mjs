// Offline simulator: runs the real game bundle in Node under jsdom with a fake
// clock, optionally with the Glider userscript injected. Nothing touches the
// network: fetch is stubbed and the bundle is loaded from research/site/.
//
// One process = one simulation (the game module is a singleton).
import { JSDOM } from 'jsdom';
import FakeTimers from '@sinonjs/fake-timers';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance as realPerf } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const idlUtils = createRequire(import.meta.url)('jsdom/lib/jsdom/living/generated/utils.js');
const SITE = resolve('research/site');

// Small seeded PRNG (mulberry32) so runs are repeatable.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// Anything the bundle touches that jsdom or Node lacks.
function installBrowserGlobals(w, clock) {
  const passthrough = [
    'window', 'document', 'location', 'history', 'localStorage', 'sessionStorage', 'navigator',
    'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'Element', 'Node', 'Text', 'DocumentFragment',
    'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'FocusEvent', 'getComputedStyle', 'DOMParser',
    'Image', 'MutationObserver', 'NodeList', 'HTMLButtonElement', 'HTMLInputElement', 'SVGElement',
  ];
  for (const k of passthrough) define(k, k === 'window' ? w : w[k]);
  // Bare calls like addEventListener("pagehide", ...) target window in a browser.
  for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) define(k, w[k].bind(w));

  // Timers: one fake clock drives Node globals and the jsdom window alike.
  for (const k of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    w[k] = clock[k].bind(clock);
  }
  Object.defineProperty(w, 'performance', { value: globalThis.performance, configurable: true });
  // Real wall clock for the userscript's planner timing, so its CPU budget
  // throttles replans here as it does in the browser.
  w.__realNow = () => realPerf.now();
  // No layout in jsdom, so the userscript's click hit-test is skipped here.
  w.__noLayout = true;
  Object.defineProperty(w, 'Date', { value: globalThis.Date, configurable: true, writable: true });

  class PointerEvent extends w.MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  define('PointerEvent', PointerEvent);
  w.PointerEvent = PointerEvent;

  const noop = () => {};
  const stubObserver = class { observe() {} unobserve() {} disconnect() {} };
  define('IntersectionObserver', stubObserver);
  define('ResizeObserver', stubObserver);
  w.IntersectionObserver = stubObserver;
  w.ResizeObserver = stubObserver;
  w.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop });
  define('matchMedia', w.matchMedia);
  w.scrollTo = noop;
  define('scrollTo', noop);

  // Canvas: every method is a no-op; measureText returns a width.
  const ctx2d = new Proxy({}, {
    get(target, prop) {
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData' || prop === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return () => ({ addColorStop: noop });
      }
      if (prop in target) return target[prop];
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  w.HTMLCanvasElement.prototype.getContext = () => ctx2d;
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  // Web Animations: jsdom has none; animations finish at once.
  w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel: noop, finish: noop });
  w.Element.prototype.getAnimations = () => [];
  // No layout engine: give every element the same box so click geometry
  // (hammer, evaders) is self-consistent.
  w.Element.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 400, bottom: 700, width: 400, height: 700, x: 0, y: 0,
  });

  // Audio: silent.
  const audioNode = new Proxy(function () {}, {
    get: (t, p) => {
      if (p === Symbol.toPrimitive || p === 'valueOf') return () => 0;
      if (p === 'connect') return () => audioNode;
      if (p === 'currentTime') return clock.now / 1000;
      return audioNode;
    },
    apply: () => audioNode,
    construct: () => audioNode,
    set: () => true,
  });
  define('AudioContext', class { constructor() { return audioNode; } });
  w.AudioContext = globalThis.AudioContext;
  w.webkitAudioContext = globalThis.AudioContext;

  // Network: never leaves the machine.
  const offline = () => Promise.reject(new Error('offline simulator'));
  define('fetch', offline);
  w.fetch = offline;
  w.navigator.sendBeacon = () => true;
  define('indexedDB', undefined);
}

// Patches the game's action dispatcher (the function every recorded input goes
// through, found by content: `function NAME(e,t){switch(e[0]){case"c":`) so
// each call is reported to globalThis.__obAction(action, ui), and exports it
// as __dispatch so a replay can apply logged actions the way the server does.
function hookDispatcher(src) {
  const m = src.match(/function (\w+)\(e,t\)\{switch\(e\[0\]\)\{case"c":/);
  if (!m) throw new Error('action dispatcher not found in bundle');
  const name = m[1];
  const hooked = `function ${name}(e,t){globalThis.__obAction&&globalThis.__obAction(e,t);switch(e[0]){case"c":`;
  return src.replace(m[0], hooked) + `\nexport{${name} as __dispatch};\n`;
}

// save: text of a game save exactly as localStorage holds it under
// `click2ban-save` (plain JSON; copy it in the browser console with
// `copy(localStorage.getItem('click2ban-save'))`). The fake clock starts one
// second after the save's lastSave so the game grants no offline earnings.
// rafMs: animation frame period (16 = the browser's 60 fps). The game's frame
// loop only draws, but it is the largest CPU cost, so 50 ms runs about 30%
// faster; the game's DOM (button states, pop-ups) then refreshes less often.
// 50 vs 16 showed no consistent score difference (2026-10-19, 6 seeds).
export async function createSim({ seed = 1, startMs = null, userscript = null, settings = null, hookActions = false, bundle = null, save = null, rafMs = 50 } = {}) {
  if (startMs === null) {
    startMs = Date.UTC(2026, 9, 15);
    if (save) startMs = JSON.parse(save).lastSave + 1000;
  }
  const html = await readFile(resolve(SITE, 'index.html'), 'utf8');
  // bundle: an older build in research/site/ (e.g. index-RhCrl34K.js) instead of the current one.
  const bundleName = bundle ?? html.match(/assets\/(index-[\w-]+\.js)/)[1];
  // Serve it from an assets/ path like the live site, which is how the
  // userscript recognizes the game's script tag. The hooked copy gets its own
  // name so parallel plain runs never load it.
  await mkdir(resolve(SITE, 'assets'), { recursive: true });
  let assetPath = resolve(SITE, 'assets', bundleName);
  if (hookActions) {
    assetPath = resolve(SITE, 'assets', bundleName.replace(/\.js$/, '-hook.js'));
    await writeFile(assetPath, hookDispatcher(await readFile(resolve(SITE, bundleName), 'utf8')));
  } else {
    await copyFile(resolve(SITE, bundleName), assetPath);
  }
  const bundleUrl = pathToFileURL(assetPath).href;

  const clock = FakeTimers.withGlobal(globalThis).install({
    now: startMs,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  Math.random = seeded(seed);

  const dom = new JSDOM(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ''), {
    url: 'https://onlybans.wtf/',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  installBrowserGlobals(w, clock);
  w.Math.random = Math.random;
  // Animation frames on the fake clock (Node has none; fake-timers' own are
  // fixed at 16 ms).
  const raf = cb => clock.setTimeout(() => cb(performance.now()), rafMs);
  const caf = id => clock.clearTimeout(id);
  define('requestAnimationFrame', raf);
  define('cancelAnimationFrame', caf);
  w.requestAnimationFrame = raf;
  w.cancelAnimationFrame = caf;
  // jsdom configures its selector engine to allow duplicate ids, so every
  // querySelector('#x') walks the whole tree (about 19% of a run's CPU).
  // Without that, it uses the document's id index. The game has no duplicate ids.
  w.document.querySelector('html');
  idlUtils.implForWrapper(w.document)._nwsapi.configure({ IDS_DUPES: false });

  // The userscript finds the bundle through this tag and re-imports its URL.
  const tag = w.document.createElement('script');
  tag.type = 'module';
  tag.setAttribute('src', bundleUrl);
  w.document.head.appendChild(tag);

  if (settings) w.localStorage.setItem('onlybans-glider-settings', JSON.stringify(settings));
  if (save) w.localStorage.setItem('click2ban-save', save);
  const mod = await import(bundleUrl);
  const logic = Object.values(mod).find(v => v && typeof v.calculateGains === 'function');

  if (userscript) {
    const text = await readFile(userscript, 'utf8');
    (0, eval)(text);
  }

  return {
    clock, window: w, logic, G: logic.G, bundleName, dispatch: mod.__dispatch ?? null,
    // Advance game time in chunks, letting promises settle between them.
    async run(seconds, onSecond) {
      for (let s = 0; s < seconds; s++) {
        clock.tick(1000);
        await new Promise(r => setImmediate(r));
        if (onSecond) onSecond(s);
      }
    },
  };
}
