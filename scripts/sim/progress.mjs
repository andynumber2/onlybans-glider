// Progress bars for a running (or finished) experiments.mjs batch.
// Usage: node scripts/sim/progress.mjs
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const WIDTH = 30;

function bar(fraction) {
  const filled = Math.round(fraction * WIDTH);
  return '█'.repeat(filled) + '░'.repeat(WIDTH - filled);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

// updated: when progress.json was last written (its mtime), or null when the
// caller is the live batch itself.
export function renderProgress(progress, updated = null) {
  const runs = Object.entries(progress.runs);
  const done = runs.reduce((a, [, r]) => a + r.done, 0);
  const total = runs.reduce((a, [, r]) => a + r.total, 0);
  const frac = total ? done / total : 0;
  // experiments.mjs rewrites the file every 2 s; an unfinished batch whose
  // file is older than STALE_MS has died (its numbers are frozen).
  const STALE_MS = 10000;
  const stale = updated !== null && frac < 1 && Date.now() - updated > STALE_MS;
  const now = stale ? updated : Date.now();
  const elapsed = now - progress.started;
  let eta = '?';
  if (frac > 0.01 && frac < 1) eta = fmtDuration(elapsed / frac - elapsed);
  if (frac >= 1) eta = 'done';
  if (stale) eta = `-  STALE: last update ${fmtDuration(Date.now() - updated)} ago, batch not running`;
  const nameWidth = Math.max(...runs.map(([id]) => id.length));
  const lines = runs.map(([id, r]) => {
    const f = r.total ? r.done / r.total : 0;
    const mark = r.finished ? ' ✓' : '';
    return `${id.padEnd(nameWidth)} ${bar(f)} ${String(Math.round(f * 100)).padStart(3)}%${mark}`;
  });
  lines.push(`${'TOTAL'.padEnd(nameWidth)} ${bar(frac)} ${String(Math.round(frac * 100)).padStart(3)}%  elapsed ${fmtDuration(elapsed)}  eta ${eta}`);
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = 'research/sim-runs/progress.json';
    const progress = JSON.parse(await readFile(file, 'utf8'));
    console.log(renderProgress(progress, (await stat(file)).mtimeMs));
  } catch {
    console.log('No batch progress yet (research/sim-runs/progress.json missing).');
  }
}
