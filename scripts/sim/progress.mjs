// Progress bars for a running (or finished) experiments.mjs batch.
// Usage: node scripts/sim/progress.mjs
import { readFile } from 'node:fs/promises';
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

export function renderProgress(progress) {
  const runs = Object.entries(progress.runs);
  const done = runs.reduce((a, [, r]) => a + r.done, 0);
  const total = runs.reduce((a, [, r]) => a + r.total, 0);
  const frac = total ? done / total : 0;
  const elapsed = Date.now() - progress.started;
  let eta = '?';
  if (frac > 0.01 && frac < 1) eta = fmtDuration(elapsed / frac - elapsed);
  if (frac >= 1) eta = 'done';
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
    const progress = JSON.parse(await readFile('research/sim-runs/progress.json', 'utf8'));
    console.log(renderProgress(progress));
  } catch {
    console.log('No batch progress yet (research/sim-runs/progress.json missing).');
  }
}
