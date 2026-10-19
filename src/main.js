// Entry point: wait for the game, bind to it, replan on a timer.

const REPLAN_MS = 2000;
const PLANNER_CPU_SHARE = 0.05;
const BUY_NOW_ROWS = 6;
const OPS_MS = 400;
const STATS_MS = 1000;

// Planner timing clock. The simulator fakes performance.now and supplies the
// real wall clock as window.__realNow.
function realNow() {
  if (window.__realNow) return window.__realNow();
  return performance.now();
}

async function waitForGame() {
  for (let i = 0; i < 300; i++) {
    if (window.OnlyBans && window.OnlyBans.G && window.OnlyBans.G.s) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('window.OnlyBans never appeared (game changed or failed to load)');
}

async function start() {
  let game = null;
  const stats = await createStats();
  const ui = createOverlay({
    onChange: () => tick(),
    onRefresh: () => rebind(),
    onCopyStats: () => navigator.clipboard.writeText(stats.exportJson()),
    onResetStats: () => stats.reset(),
  });
  bindInputSettings(() => ui.settings);

  async function rebind() {
    try {
      await waitForGame();
      game = await bindGame(window);
      tick();
    } catch (e) {
      game = null;
      ui.render(`<div class="err">Bind failed: ${esc(e.message)}\nRun scripts/probe.mjs to see what changed.</div>`);
    }
  }

  let autoBought = 0;
  // Longest real-time gap between replans since the last stats snapshot.
  // Chrome throttles timers in hidden tabs to about once a minute.
  const loopHealth = { last: 0, maxGapMs: 0, hiddenSeen: false };

  async function tick() {
    if (!game || game.G.ascending) return;
    // A hidden tab only matters for display; auto mode keeps buying.
    if (document.hidden && !ui.settings.auto) return;
    let out;
    const t0 = realNow();
    try {
      out = render(game, ui, autoBought, stats);
    } catch (e) {
      ui.render(`<div class="err">Planner error: ${esc(e.stack ?? e.message)}</div>`);
      return;
    }
    const plannerMs = realNow() - t0;
    if (ui.settings.auto) autoBought += await autoBuy(game, out.result.path, out.utilities, ui.settings.ops);
    return plannerMs;
  }

  await rebind();
  // Replan on a CPU budget: the planner runs on the game's main thread, so
  // wait at least PLANNER_CPU_SHARE⁻¹ × its own run time between replans.
  // Only the planner's own compute counts, not the auto-buyer's click pauses.
  const replanLoop = async () => {
    const now = realNow();
    if (loopHealth.last) loopHealth.maxGapMs = Math.max(loopHealth.maxGapMs, now - loopHealth.last);
    loopHealth.last = now;
    if (document.hidden) loopHealth.hiddenSeen = true;
    const spent = (await tick()) ?? 0;
    setTimeout(replanLoop, Math.max(REPLAN_MS, spent / PLANNER_CPU_SHARE));
  };
  replanLoop();
  startHammer({ get G() { return game ? game.G : { ascending: true }; } }, () => ui.settings);
  setInterval(() => {
    if (!game || !ui.settings.auto) return;
    const did = runOps(game, ui.settings.ops);
    if (did) {
      ui.log(did);
      stats.action(did);
    }
  }, OPS_MS);
  // Stats record whether or not AUTO is on, so manual play can be compared.
  setInterval(() => {
    if (!game) return;
    const diag = {
      hidden: document.hidden || loopHealth.hiddenSeen, maxReplanGapS: Math.round(loopHealth.maxGapMs / 1000),
      buyer: buyerState.stop,
    };
    if (stats.tick(game.G, projectedHeat(game.G, ui.settings.ops), diag)) {
      loopHealth.maxGapMs = 0;
      loopHealth.hiddenSeen = false;
    }
    ui.renderStats(statsHtml(stats.summary()));
  }, STATS_MS);
}

function statsHtml(sum) {
  const tiers = TIER_NAMES.map((name, i) => `${name} ${sum.counts[i]}`).join(' · ');
  let html = `<div>Waves: ${sum.waves} · ${tiers}</div>`;
  html += `<div>Avg income (last 10 min): ${fmtNum(sum.avgBps)}/s</div>`;
  const w = sum.lastWave;
  if (w) {
    html += `<div>Last wave #${w.n}: ${TIER_NAMES[w.tier] ?? '?'} · charge ${Math.round(w.f * 100)}%` +
      ` · notch ${w.notch} · ${w.audited ? 'audited' : 'not audited'}` +
      ` · heat ${w.heat?.toFixed(1)} (projected ${w.projectedHeat?.toFixed(1) ?? '?'})</div>`;
  }
  return html;
}

function render(game, ui, autoBought, stats) {
  const { settings } = ui;
  const bank = game.G.s.bans;
  const t0 = realNow();
  // While the hammer clicker runs, value click upgrades at its click rate.
  let clicksPerSec = settings.clicksPerSec;
  if (settings.auto && settings.ops.hammer) clicksPerSec = Math.max(clicksPerSec, hammerCps());
  const result = withSandbox(game, { clicksPerSec }, sim =>
    plan(sim, { bank, horizon: settings.horizon, depth: settings.depth, beam: settings.beam }));
  const ms = realNow() - t0;

  const steps = groupSteps(result.path, itemKey);
  const first = steps[0];
  highlightBuilding(first && first.item.type === 'building' ? first.item.def.index : null);

  const buyNow = summarizeBuyNow(result.path);
  let html = '';
  if (!first) {
    html += result.rate > 0
      ? `<div class="next">Nothing pays back within this horizon. <b>Save.</b></div>`
      : `<div class="next">No income yet. <b>Click the banhammer.</b></div>`;
  } else if (buyNow.length) {
    const total = buyNow.reduce((sum, b) => sum + b.price, 0);
    const biggest = [...buyNow].sort((a, b) => b.price - a.price).slice(0, BUY_NOW_ROWS);
    html += `<div class="next">Buy now (${fmtNum(total)} bans):`;
    for (const b of biggest) {
      html += `<div><b>${esc(itemLabel(b.item))}</b> ×${b.count} <span class="muted">${fmtNum(b.price)}</span></div>`;
    }
    if (buyNow.length > biggest.length) {
      html += `<div class="muted">+${buyNow.length - biggest.length} cheaper items</div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="next">Next: <b>${esc(itemLabel(first.item))}</b>${first.count > 1 ? ' ×' + first.count : ''}
      <div class="muted">${fmtNum(first.price)} bans · ${first.at < 1 ? 'buy now' : 'in ' + fmtTime(first.at)}
      · +${fmtNum(first.gain)}/s</div></div>`;
  }

  // Buy-now steps are summarized above; the path table shows what comes after.
  const later = buyNow.length ? steps.filter(s => s.at > 0) : steps.slice(1);
  if (later.length) {
    html += `<h4>Then</h4><table><tr><th>Buy</th><th>at</th><th>rate after</th></tr>`;
    for (const s of later) {
      html += `<tr><td>${esc(itemLabel(s.item))}${s.count > 1 ? ' ×' + s.count : ''}</td>
        <td>${fmtTime(s.at)}</td><td>${fmtNum(s.rateAfter)}/s</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<h4>Best single buys</h4><table><tr><th>Item</th><th>cost</th><th>+/s</th><th>payback</th><th>wait</th></tr>`;
  for (const c of result.candidates.slice(0, 8)) {
    html += `<tr><td title="${esc(c.item.def.name)}">${esc(itemLabel(c.item))}</td><td>${fmtNum(c.price)}</td>
      <td>${fmtNum(c.gain)}</td><td>${fmtTime(c.payback)}</td><td>${fmtTime(c.wait)}</td></tr>`;
  }
  html += `</table>`;

  const utilities = utilityUpgrades(game, { clicksPerSec });
  if (utilities.length) {
    html += `<h4>Utility upgrades (bought at ≤${UTILITY_MAX_SECONDS / 60} min of income)</h4><table>`;
    for (const u of utilities.slice(0, 6)) {
      const secs = result.rate > 0 ? u.price / result.rate : Infinity;
      html += `<tr><td title="${esc(u.def.desc ?? '')}">${esc(iconText(u.def.icon))} ${esc(u.def.name)}</td>
        <td>${fmtNum(u.price)}</td><td>${fmtTime(secs)} of income</td></tr>`;
    }
    html += `</table>`;
  }

  const special = specialUpgrades(game);
  if (special.length) {
    html += `<h4 title="Escalates all three, skips Détente, and calls a truce only when perception reaches 80 (near a review bomb)">Arms race (auto: escalate ×3)</h4>`;
    html += special.map(u => `<div>${esc(iconText(u.icon))} ${esc(u.name)}</div>`).join('');
  }

  const seq = sequelStatus(game.G, settings.ops);
  html += `<h4>Sequel (auto: ships at ×${settings.ops.sequelGain ?? SHIP_GAIN} production)</h4>`;
  if (seq.ship) html += `<div><b>Shipping now</b> · +${fmtNum(seq.pending)} ⭐</div>`;
  if (seq.target) {
    // Nothing planned: production stays flat, so bans grow linearly at the
    // current rate. Otherwise project the recent growth trend.
    let eta = '';
    if (!result.path.length) {
      const left = seq.target.bansAllTime - game.G.s.bansAllTime;
      if (result.rate > 0) eta = ` · idle, ~${fmtTime(left / result.rate)}`;
    } else {
      const etaMs = trendEta(stats.snapshots(), seq.target.bansAllTime, Date.now());
      if (etaMs === null) eta = ' · ETA measuring';
      else if (etaMs === Infinity) eta = ' · ETA: no growth';
      else eta = ` · <span title="Projected from the last 30 min of all-time bans growth; usually early as growth slows">~${fmtTime(etaMs / 1000)}</span>`;
    }
    html += `<div>+${fmtNum(seq.target.pending)} ⭐ at ${fmtNum(seq.target.bansAllTime)} all-time${eta}</div>`;
  }
  if (seq.buys.length) html += `<div class="muted">Buys: ${seq.buys.map(esc).join(', ')}</div>`;

  ui.renderRate(`${fmtNum(result.rate)}/s`);
  let status = `<div>Bank ${fmtNum(bank)} · planner ${ms.toFixed(0)}ms · ${esc(game.build)}</div>`;
  if (settings.auto) status += `<div>Auto: ${autoBought} bought this session · ${esc(buyerState.stop || 'starting')}</div>`;
  ui.renderStatus(status);
  if (game.build !== ANALYZED_BUILD) {
    html += `<div class="err">Game updated: automation rules were checked against ${esc(ANALYZED_BUILD)}, live is ${esc(game.build)}. Ask for a re-check.</div>`;
  }
  ui.render(html);
  return { result, utilities };
}

// Everything affordable right now, merged per item, in first-purchase order.
function summarizeBuyNow(path) {
  const byKey = new Map();
  for (const s of path) {
    if (s.at > 0) break;
    const k = itemKey(s.item);
    const entry = byKey.get(k) ?? { item: s.item, count: 0, price: 0 };
    entry.count++;
    entry.price += s.price;
    byKey.set(k, entry);
  }
  return [...byKey.values()];
}

start();
