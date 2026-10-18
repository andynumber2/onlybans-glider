// Every click the automation makes goes through here. With "Anti anti-cheat"
// on (settings.stealth, the default) it only clicks what a person could: the
// point clicked must show the target itself, not a pop-up or anything else
// above it. The same setting turns on the human pacing elsewhere (reaction
// delays in ops.js, hammer bursts, gaps between purchases in auto.js).
//
// None of this can make an event trusted: script-made events always carry
// isTrusted === false. The game doesn't check it today (scripts/fetch.sh
// warns if a new build starts to).

let getInputSettings = () => ({ stealth: true });

export function bindInputSettings(getSettings) {
  getInputSettings = getSettings;
}

export function humanMode() {
  return getInputSettings().stealth !== false;
}

// The simulator runs the game in jsdom, which has no layout; it sets
// window.__noLayout so clicks skip the hit-test there. A hidden tab skips it
// too: live, with the VDI window hidden, every hit-test failed for 5.7 h
// (likely nothing is drawn, so every point reads as empty), and no pop-up can be in the
// way of a click nobody is watching. Pacing stays human.
function canHitTest() {
  return !window.__noLayout && !document.hidden && typeof document.elementsFromPoint === 'function';
}

// The topmost element at a viewport point, ignoring this script's own panel
// (the game can't see it, and a person would just move it).
function topmostAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!el.closest('#obh')) return el;
  }
  return null;
}

// Where to click el: the given point, or its center. Null when a person
// couldn't click it there (human mode only): no box, off screen, or covered.
function clickPoint(el, x, y) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  const px = x ?? r.left + r.width / 2;
  const py = y ?? r.top + r.height / 2;
  if (!humanMode() || !canHitTest()) return { x: px, y: py };
  if (!r.width || !r.height) return null;
  if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) return null;
  const top = topmostAt(px, py);
  if (!top || !(top === el || el.contains(top))) return null;
  return { x: px, y: py };
}

// Scrolls el into view first in human mode (a person scrolls to a store row
// before clicking it).
export function reveal(el) {
  if (el && humanMode() && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

// Returns false, without clicking, when the click is blocked.
export function click(el) {
  if (!clickPoint(el)) return false;
  el.click();
  return true;
}

// Pointerdown at a viewport point on whichever of `targets` a person would
// hit there (e.g. the evader canvas or the hammer's hit area above it; the
// game hit-tests evaders from both). Outside human mode, targets[0].
export function pointerDownAt(x, y, targets) {
  let el = targets[0];
  if (humanMode() && canHitTest()) {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const top = topmostAt(x, y);
    el = top && targets.find(t => t && (t === top || t.contains(top)));
    if (!el) return false;
  }
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return true;
}

// For elements that listen to pointerdown only (hammer, shimmers, repairs,
// the evader canvas). x/y default to the element's center.
export function pointerDown(el, x, y) {
  const p = clickPoint(el, x, y);
  if (!p) return false;
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));
  return true;
}
