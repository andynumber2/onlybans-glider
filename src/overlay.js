// Overlay panel: plan display, settings, and the automation toggles.

const SETTINGS_KEY = 'onlybans-glider-settings';
const HORIZONS = [
  ['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['12h', 43200], ['2d', 172800],
];
const DEFAULTS = {
  auto: false, horizon: 900, clicksPerSec: 0, depth: 3, beam: 5, collapsed: false,
  side: 'left', x: 12, y: 12, ops: {},
};
const LOG_LINES = 6;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...DEFAULTS, ...saved, ops: { ...OPS_DEFAULTS, ...(saved.ops ?? {}) } };
  } catch {
    return { ...DEFAULTS, ops: { ...OPS_DEFAULTS } };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

const CSS = `
#obh { position: fixed; z-index: 99999; width: min(340px, calc(100vw - 8px)); font: 12px/1.35 ui-monospace, Menlo, monospace;
  color: #e6ebff; background: rgba(10,13,24,.94); border: 2px solid #f5c542; border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,.6); }
#obh header { display: flex; gap: 6px; align-items: center; padding: 4px 6px; background: #f5c542;
  color: #111; cursor: move; user-select: none; font-weight: 700; }
#obh header span { flex: 1; }
#obh header button { all: unset; cursor: pointer; padding: 0 4px; font-weight: 700; }
#obh header button[data-act="auto"] { border: 1px solid #111; border-radius: 3px; font-size: 10px; }
#obh header button[data-act="auto"].on { background: #c62828; color: #fff; border-color: #c62828; }
#obh .body { padding: 6px 8px; max-height: 70vh; overflow: auto; }
#obh.collapsed .body { display: none; }
#obh .controls { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
#obh select, #obh input { background: #1a2036; color: #e6ebff; border: 1px solid #39425f; font: inherit; }
#obh input { width: 44px; }
#obh .next { font-size: 14px; padding: 6px; margin-bottom: 6px; background: #1d2a1a; border-left: 4px solid #6fdc6f; }
#obh .next b { color: #6fdc6f; }
#obh .muted { color: #8592b3; }
#obh table { width: 100%; border-collapse: collapse; margin-top: 4px; }
#obh th, #obh td { padding: 1px 3px; text-align: right; white-space: nowrap; }
#obh th:first-child, #obh td:first-child { text-align: left; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
#obh th { color: #8592b3; font-weight: 400; border-bottom: 1px solid #39425f; }
#obh h4 { margin: 8px 0 2px; color: #f5c542; font-size: 12px; }
#obh .err { color: #ff6b6b; white-space: pre-wrap; }
#obh details.ops { margin-bottom: 6px; border: 1px solid #39425f; padding: 2px 6px; }
#obh details.ops summary { cursor: pointer; color: #f5c542; }
#obh details.ops label { display: block; }
#obh details.ops input { width: auto; }
#obh .opsLog { color: #8592b3; margin-top: 4px; white-space: pre-wrap; }
#buildings .product.obh-pick { outline: 3px solid #6fdc6f; outline-offset: -3px; }
`;

export function createOverlay({ onChange, onRefresh, onCopyStats, onResetStats }) {
  const settings = loadSettings();
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'obh';
  if (settings.collapsed) root.classList.add('collapsed');
  root.innerHTML = `
    <header><span>OnlyBans Glider</span>
      <button data-act="auto" title="Auto-buy the plan's buy-now list">AUTO</button>
      <button data-act="refresh" title="Replan now">⟳</button>
      <button data-act="collapse" title="Collapse">–</button></header>
    <div class="body">
      <div class="controls">
        <label>Horizon <select data-set="horizon">${HORIZONS.map(([l, v]) =>
          `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>Clicks/s <input data-set="clicksPerSec" type="number" min="0" max="20" step="1"></label>
        <label>Depth <input data-set="depth" type="number" min="1" max="5" step="1"></label>
      </div>
      <details class="ops"><summary>Automation (runs while AUTO is on)</summary>
        ${OPS.map(o => `<label><input type="checkbox" data-op="${o.key}"> ${esc(o.label)}</label>`).join('')}
        <div class="opsLog"></div>
      </details>
      <details class="ops"><summary>Stats</summary>
        <div class="statsBody muted">Collecting…</div>
        <div class="controls"><button data-act="copyStats">Copy JSON</button>
          <button data-act="resetStats">Reset</button></div>
      </details>
      <div class="content muted">Binding to game…</div>
    </div>`;
  document.body.appendChild(root);
  place(root, settings);
  window.addEventListener('resize', () => place(root, settings));

  for (const el of root.querySelectorAll('[data-op]')) {
    el.checked = !!settings.ops[el.dataset.op];
    el.addEventListener('change', () => {
      settings.ops[el.dataset.op] = el.checked;
      saveSettings(settings);
    });
  }

  for (const el of root.querySelectorAll('[data-set]')) {
    el.value = settings[el.dataset.set];
    el.addEventListener('change', () => {
      const n = Number(el.value);
      if (isFinite(n) && n >= 0) settings[el.dataset.set] = n;
      saveSettings(settings);
      onChange(settings);
    });
  }
  const autoBtn = root.querySelector('[data-act="auto"]');
  const paintAuto = () => autoBtn.classList.toggle('on', settings.auto);
  paintAuto();
  autoBtn.addEventListener('click', () => {
    settings.auto = !settings.auto;
    paintAuto();
    saveSettings(settings);
    onChange(settings);
  });
  root.querySelector('[data-act="refresh"]').addEventListener('click', () => onRefresh());
  const copyBtn = root.querySelector('[data-act="copyStats"]');
  copyBtn.addEventListener('click', async () => {
    try {
      await onCopyStats();
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 2000);
  });
  root.querySelector('[data-act="resetStats"]').addEventListener('click', () => {
    if (confirm('Clear all recorded stats?')) onResetStats();
  });
  root.querySelector('[data-act="collapse"]').addEventListener('click', () => {
    settings.collapsed = !settings.collapsed;
    root.classList.toggle('collapsed', settings.collapsed);
    saveSettings(settings);
  });
  makeDraggable(root, root.querySelector('header'), () => {
    // Anchor to the nearer edge so a window resize keeps the panel in view.
    const rect = root.getBoundingClientRect();
    if (rect.left + rect.width / 2 > window.innerWidth / 2) {
      settings.side = 'right';
      settings.x = window.innerWidth - rect.right;
    } else {
      settings.side = 'left';
      settings.x = rect.left;
    }
    settings.y = rect.top;
    place(root, settings);
    saveSettings(settings);
  });

  const content = root.querySelector('.content');
  const opsLog = root.querySelector('.opsLog');
  const statsBody = root.querySelector('.statsBody');
  const logLines = [];
  return {
    settings,
    render(html) {
      content.classList.remove('muted');
      content.innerHTML = html;
    },
    renderStats(html) {
      statsBody.classList.remove('muted');
      statsBody.innerHTML = html;
    },
    log(line) {
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      logLines.unshift(`${t} ${line}`);
      logLines.length = Math.min(logLines.length, LOG_LINES);
      opsLog.replaceChildren(...logLines.map(l => Object.assign(document.createElement('div'), { textContent: l })));
    },
  };
}

// Positions the panel from its saved edge offset, clamped inside the viewport.
function place(root, settings) {
  const maxX = Math.max(0, window.innerWidth - root.offsetWidth);
  const maxY = Math.max(0, window.innerHeight - 32);
  const x = Math.min(Math.max(0, settings.x), maxX);
  const y = Math.min(Math.max(0, settings.y), maxY);
  if (settings.side === 'right') {
    root.style.left = 'auto';
    root.style.right = x + 'px';
  } else {
    root.style.right = 'auto';
    root.style.left = x + 'px';
  }
  root.style.top = y + 'px';
}

function makeDraggable(el, handle, onDrop) {
  let start = null;
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const rect = el.getBoundingClientRect();
    el.style.right = 'auto';
    el.style.left = rect.left + 'px';
    start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!start) return;
    el.style.left = Math.max(0, e.clientX - start.x) + 'px';
    el.style.top = Math.max(0, e.clientY - start.y) + 'px';
  });
  handle.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    onDrop();
  });
}

export function highlightBuilding(index) {
  for (const el of document.querySelectorAll('#buildings .product.obh-pick')) el.classList.remove('obh-pick');
  if (index === null) return;
  const row = document.querySelectorAll('#buildings .product')[index];
  if (row) row.classList.add('obh-pick');
}

export function fmtNum(n) {
  if (!isFinite(n)) return '∞';
  if (Math.abs(n) < 1000) return n < 10 ? n.toFixed(1) : Math.round(n).toString();
  const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  if (Math.abs(n) >= Math.pow(1000, units.length + 1)) return n.toExponential(3);
  let i = -1;
  while (Math.abs(n) >= 1000) {
    n /= 1000;
    i++;
  }
  return n.toFixed(n < 10 ? 2 : 1) + units[i];
}

export function fmtTime(sec) {
  if (!isFinite(sec)) return '∞';
  if (sec < 1) return 'now';
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm' + String(Math.round(sec % 60)).padStart(2, '0') + 's';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h' + String(Math.round((sec % 3600) / 60)).padStart(2, '0') + 'm';
  return (sec / 86400).toFixed(1) + 'd';
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
