// Live chart of bans per second, for watching a run. Paste into the DevTools
// console on the game tab. Read-only: it samples window.OnlyBans.G once a
// second and never clicks or dispatches anything, so the input log (and the
// leaderboard replay) is untouched.
// Opens a pop-out window; if the browser blocks it, draws a small box in the
// page's bottom-right corner instead (it ignores the mouse, except its ✕).
// Remove it: click ✕, close the pop-out, or run  window.__obChart.stop()
(() => {
  if (window.__obChart) window.__obChart.stop();
  const G = window.OnlyBans && window.OnlyBans.G;
  if (!G) return console.log('live chart: game not found (window.OnlyBans.G)');
  const W = 520, H = 260, KEEP = 4 * 3600, SMOOTH = 10;

  let win = window.open('', 'obLiveChart', `width=${W + 20},height=${H + 60}`);
  let root;
  if (win && win.document) {
    win.document.title = 'Bans per second';
    win.document.body.innerHTML = '';
    win.document.body.style.cssText = 'margin:0;background:#11141c;color:#ccd;font:12px sans-serif';
    root = win.document.body;
  } else {
    win = null;
    root = document.createElement('div');
    root.style.cssText = `position:fixed;right:8px;bottom:8px;z-index:2147483646;background:#11141cee;color:#ccd;font:12px sans-serif;border:1px solid #334;pointer-events:none`;
    document.body.appendChild(root);
  }
  const doc = root.ownerDocument;
  const head = doc.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;padding:4px 8px';
  const label = doc.createElement('span');
  const close = doc.createElement('button');
  close.textContent = '✕';
  close.style.cssText = 'pointer-events:auto;background:none;border:0;color:#ccd;cursor:pointer;font-size:14px';
  head.append(label, close);
  const canvas = doc.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.display = 'block';
  root.append(head, canvas);
  const ctx = canvas.getContext('2d');

  // One sample a second: production (G.bps) and bans actually earned
  // (all-time bans delta, averaged over SMOOTH s, so golden lumps show).
  const samples = [];
  const ships = [];
  let lastSeq = G.s.prestige.sequels;
  const t0 = Date.now();
  const log = x => (x > 0 ? Math.log10(x) : null);
  function sample() {
    const t = (Date.now() - t0) / 1000;
    const all = G.s.bansAllTime;
    samples.push({ t, all, bps: G.bps });
    if (G.s.prestige.sequels !== lastSeq) {
      lastSeq = G.s.prestige.sequels;
      ships.push(t);
    }
    while (samples.length && samples[0].t < t - KEEP) samples.shift();
    while (ships.length && ships[0] < t - KEEP) ships.shift();
  }
  function earned(i) {
    const j = Math.max(0, i - SMOOTH);
    const a = samples[j], b = samples[i];
    return b.t > a.t ? (b.all - a.all) / (b.t - a.t) : null;
  }
  function draw() {
    ctx.fillStyle = '#11141c';
    ctx.fillRect(0, 0, W, H);
    if (samples.length < 2) return;
    const tMin = samples[0].t, tMax = samples[samples.length - 1].t;
    const pts = samples.map((s, i) => ({ t: s.t, p: log(s.bps), e: log(earned(i)) }));
    const ys = pts.flatMap(p => [p.p, p.e]).filter(y => y !== null);
    if (!ys.length) return;
    const lo = Math.floor(Math.min(...ys)), hi = Math.ceil(Math.max(...ys)) || lo + 1;
    const x = t => 40 + (W - 50) * (t - tMin) / Math.max(1, tMax - tMin);
    const y = v => H - 20 - (H - 30) * (v - lo) / Math.max(1, hi - lo);
    ctx.strokeStyle = '#2a3040';
    ctx.fillStyle = '#889';
    ctx.font = '11px sans-serif';
    const step = Math.max(1, Math.ceil((hi - lo) / 6));
    for (let v = lo; v <= hi; v += step) {
      ctx.beginPath(); ctx.moveTo(40, y(v)); ctx.lineTo(W - 10, y(v)); ctx.stroke();
      ctx.fillText('1e' + v, 2, y(v) + 4);
    }
    ctx.fillText(`${Math.round((tMax - tMin) / 60)} min shown`, W - 90, H - 5);
    ctx.strokeStyle = '#a66';
    for (const s of ships) { ctx.beginPath(); ctx.moveTo(x(s), 10); ctx.lineTo(x(s), H - 20); ctx.stroke(); }
    const line = (key, color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      let on = false;
      const every = Math.max(1, Math.floor(pts.length / (W - 50)));
      for (let i = 0; i < pts.length; i += every) {
        const v = pts[i][key];
        if (v === null) { on = false; continue; }
        if (on) ctx.lineTo(x(pts[i].t), y(v)); else ctx.moveTo(x(pts[i].t), y(v));
        on = true;
      }
      ctx.stroke();
    };
    line('e', '#e8c547');
    line('p', '#5fb3ff');
    const last = samples[samples.length - 1];
    label.textContent = `blue: production ${last.bps.toExponential(2)}/s · gold: earned (${SMOOTH} s avg) · red: sequel · all-time ${last.all.toExponential(2)}`;
  }

  const timer = setInterval(() => {
    if (win && win.closed) return stop();
    try { sample(); draw(); } catch (e) { console.log('live chart error, stopping:', e); stop(); }
  }, 1000);
  function stop() {
    clearInterval(timer);
    if (win && !win.closed) win.close();
    if (!win) root.remove();
    delete window.__obChart;
    console.log('live chart stopped');
  }
  close.onclick = stop;
  window.__obChart = { stop };
  console.log('live chart running; remove with window.__obChart.stop()');
})();
