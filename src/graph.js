// Live graph of the run: all-time bans and earned/s, in a floating window
// opened from the Stats section. Samples every 5 s whether or not the window
// is open, and draws only while it is open.
//
// The window lives inside #obh, so human-mode clicks pass through it like
// they do through the panel (topmostAt in input.js).

const GRAPH_DOC = 'graph';
const GRAPH_SAMPLE_MS = 5000;
const GRAPH_PERSIST_MS = 30000;
// Past this many points, every other point in the older half is dropped, so a
// long run keeps its whole history at coarser resolution (about 100 KB).
const GRAPH_MAX_POINTS = 4000;
// A longer gap between points (tab closed, page reloading) breaks the lines.
const GRAPH_GAP_MS = 10 * 60e3;
const GRAPH_SPANS = [['15m', 900], ['1h', 3600], ['run', 0]];
const GRAPH_MIN = { w: 260, h: 180 };
const GRAPH_COLORS = {
  all: '#f5c542', earned: '#6fdc6f', bps: '#5a79c8', grid: '#2a3150', text: '#8592b3',
  sequel: '#ff6b6b', boost: 'rgba(190,120,255,.18)',
};

export async function createGraph() {
  let points = [];
  try {
    const saved = await idb('readonly', s => s.get(GRAPH_DOC));
    if (Array.isArray(saved)) points = saved;
  } catch {}
  let dirty = false;
  let lastSample = 0;
  // A boost seen on any 1 s tick since the last point, so short ones show.
  let boostSeen = false;
  let onPoint = null;

  const persist = () => {
    if (!dirty) return;
    dirty = false;
    idb('readwrite', s => s.put(points, GRAPH_DOC)).catch(() => {});
  };
  setInterval(persist, GRAPH_PERSIST_MS);
  window.addEventListener('pagehide', persist);

  return {
    // Called about once a second from the stats timer.
    sample(G, boost) {
      boostSeen = boostSeen || boost;
      const now = Date.now();
      if (now - lastSample < GRAPH_SAMPLE_MS) return;
      lastSample = now;
      const s = G.s;
      // A new game (a verified start wipes the save) starts a new graph.
      const last = points[points.length - 1];
      if (last && s.bansAllTime < last.all / 2) points = [];
      points.push({ t: now, all: s.bansAllTime, bps: G.bps, seq: s.prestige.sequels, boost: boostSeen });
      boostSeen = false;
      if (points.length > GRAPH_MAX_POINTS) {
        const half = Math.floor(points.length / 2);
        points = points.slice(0, half).filter((_, i) => i % 2 === 0).concat(points.slice(half));
      }
      dirty = true;
      if (onPoint) onPoint();
    },

    reset() {
      points = [];
      dirty = true;
      persist();
      if (onPoint) onPoint();
    },

    // Builds the window inside parent. opts: the saved settings.graph object,
    // save() to store it, onOpen(open) when it opens or closes.
    mount(parent, opts, save, onOpen) {
      const win = document.createElement('div');
      win.className = 'obhGraph';
      win.innerHTML = `
        <div class="gHead"><span class="gTitle">Graph</span><span class="gNow"></span>
          <select title="Time window">${GRAPH_SPANS.map(([l, v]) => `<option value="${v}">${l}</option>`).join('')}</select>
          <button data-act="graphClose" title="Hide graph">×</button></div>
        <canvas></canvas>`;
      parent.appendChild(win);
      const canvas = win.querySelector('canvas');
      const now = win.querySelector('.gNow');
      const span = win.querySelector('select');
      span.value = opts.span;

      const draw = () => {
        if (!opts.open) return;
        now.textContent = graphNowText(points);
        drawGraph(canvas, points, opts.span);
      };
      const place = () => {
        const w = Math.max(GRAPH_MIN.w, Math.min(opts.w, window.innerWidth - 8));
        const h = Math.max(GRAPH_MIN.h, Math.min(opts.h, window.innerHeight - 8));
        win.style.width = w + 'px';
        win.style.height = h + 'px';
        win.style.left = Math.min(Math.max(0, opts.x), Math.max(0, window.innerWidth - w)) + 'px';
        win.style.top = Math.min(Math.max(0, opts.y), Math.max(0, window.innerHeight - 32)) + 'px';
      };
      const setOpen = open => {
        opts.open = open;
        win.classList.toggle('open', open);
        save();
        onOpen(open);
        if (open) {
          place();
          draw();
        }
      };

      span.addEventListener('change', () => {
        opts.span = Number(span.value);
        save();
        draw();
      });
      win.querySelector('[data-act="graphClose"]').addEventListener('click', () => setOpen(false));
      makeDraggable(win, win.querySelector('.gHead'), () => {
        const r = win.getBoundingClientRect();
        opts.x = r.left;
        opts.y = r.top;
        save();
      });
      // Resizing (CSS resize handle) redraws, and saves the size once it settles.
      let resizeTimer = null;
      new ResizeObserver(() => {
        if (!opts.open) return;
        draw();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          opts.w = win.offsetWidth;
          opts.h = win.offsetHeight;
          save();
        }, 500);
      }).observe(win);
      window.addEventListener('resize', () => {
        if (opts.open) place();
      });
      onPoint = draw;
      setOpen(opts.open);
      return { setOpen };
    },
  };
}

// Earned bans per second between consecutive points (includes golden lumps,
// which never show in production), stamped at the later point.
function earnedRates(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = (b.t - a.t) / 1000;
    if (dt > 0 && b.all > a.all) out.push({ t: b.t, v: (b.all - a.all) / dt });
  }
  return out;
}

function graphNowText(points) {
  if (!points.length) return '';
  const rates = earnedRates(points.slice(-2));
  const all = fmtNum(points[points.length - 1].all);
  if (!rates.length) return all;
  return `${all} · ${fmtNum(rates[0].v)}/s`;
}

function drawGraph(canvas, points, spanSec) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!w || !h || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';
  if (points.length < 2) {
    ctx.fillStyle = GRAPH_COLORS.text;
    ctx.fillText('Collecting… (a point every 5 s)', 8, 14);
    return;
  }

  const start = points[0].t;
  const end = points[points.length - 1].t;
  const from = spanSec ? Math.max(start, end - spanSec * 1000) : start;
  const vis = points.filter(p => p.t >= from);
  const rates = earnedRates(points).filter(r => r.t >= from);
  const left = 40;
  const right = 6;
  const top = 4;
  const bottom = 16;
  const gap = 14;
  const plotH = (h - top - bottom - gap) / 2;
  const x = t => left + (t - from) / Math.max(1, end - from) * (w - left - right);
  const plots = [
    { top, series: [{ label: 'all-time bans', pts: vis.map(p => ({ t: p.t, v: p.all })), color: GRAPH_COLORS.all, width: 1.5 }] },
    {
      top: top + plotH + gap, series: [
        { label: 'production/s', pts: vis.map(p => ({ t: p.t, v: p.bps })), color: GRAPH_COLORS.bps, width: 1 },
        { label: 'earned/s', pts: rates, color: GRAPH_COLORS.earned, width: 1.5 },
      ],
    },
  ];

  // Boost bands: from the previous point to each point that saw a boost.
  ctx.fillStyle = GRAPH_COLORS.boost;
  for (let i = 1; i < vis.length; i++) {
    if (!vis[i].boost) continue;
    const x0 = x(vis[i - 1].t);
    const x1 = Math.max(x0 + 1, x(vis[i].t));
    for (const p of plots) ctx.fillRect(x0, p.top, x1 - x0, plotH);
  }

  for (const p of plots) drawPlot(ctx, p, plotH, left, w - right, x);

  // Sequel ships.
  ctx.strokeStyle = GRAPH_COLORS.sequel;
  ctx.beginPath();
  for (let i = 1; i < vis.length; i++) {
    if (vis[i].seq === vis[i - 1].seq) continue;
    const xs = Math.round(x(vis[i].t)) + 0.5;
    ctx.moveTo(xs, top);
    ctx.lineTo(xs, top + 2 * plotH + gap);
  }
  ctx.stroke();

  // Time axis: elapsed since the graph's first point.
  const stepMin = niceStep((end - from) / 60e3 / 5);
  ctx.fillStyle = GRAPH_COLORS.text;
  ctx.textAlign = 'center';
  const firstTick = Math.ceil((from - start) / 60e3 / stepMin) * stepMin;
  for (let m = firstTick; start + m * 60e3 <= end; m += stepMin) {
    // Keep each label inside the canvas.
    const label = elapsedLabel(m);
    const half = ctx.measureText(label).width / 2;
    const xm = Math.min(Math.max(x(start + m * 60e3), half), w - half);
    ctx.fillText(label, xm, h - bottom / 2);
  }
  ctx.textAlign = 'left';
}

// One log10 plot: decade grid lines with labels, then each series.
function drawPlot(ctx, plot, height, x0, x1, x) {
  const vals = [];
  for (const s of plot.series) for (const p of s.pts) if (p.v > 0) vals.push(Math.log10(p.v));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (!vals.length) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1) {
    lo -= 0.5;
    hi += 0.5;
  }
  const y = v => plot.top + height - (Math.log10(v) - lo) / (hi - lo) * height;

  const step = Math.max(1, Math.ceil((hi - lo) / 4));
  ctx.strokeStyle = GRAPH_COLORS.grid;
  ctx.fillStyle = GRAPH_COLORS.text;
  ctx.textAlign = 'right';
  ctx.beginPath();
  for (let k = Math.ceil(lo / step) * step; k <= hi; k += step) {
    const yk = Math.round(y(10 ** k)) + 0.5;
    ctx.moveTo(x0, yk);
    ctx.lineTo(x1, yk);
    ctx.fillText(`1e${k}`, x0 - 3, yk);
  }
  ctx.stroke();
  ctx.textAlign = 'left';
  // Legend: each series' name in its own color.
  let lx = x0 + 4;
  for (const s of plot.series) {
    ctx.fillStyle = s.color;
    ctx.fillText(s.label, lx, plot.top + 7);
    lx += ctx.measureText(s.label).width + 10;
  }

  for (const s of plot.series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    let prev = null;
    for (const p of s.pts) {
      if (!(p.v > 0)) {
        prev = null;
        continue;
      }
      if (prev && p.t - prev.t <= GRAPH_GAP_MS) ctx.lineTo(x(p.t), y(p.v));
      else ctx.moveTo(x(p.t), y(p.v));
      prev = p;
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

function niceStep(min) {
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440]) if (s >= min) return s;
  return 2880;
}

function elapsedLabel(min) {
  if (min < 60) return `${min}m`;
  const mm = String(min % 60).padStart(2, '0');
  return `${Math.floor(min / 60)}h${mm}`;
}
