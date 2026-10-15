// Automation for everything besides purchases. Every action is a click on the
// game's own UI, so it runs the same recorded handler a human click does.
// Each routine waits a random reaction delay after its target becomes
// actionable, so nothing fires on the exact tick it becomes possible.

export const OPS = [
  { key: 'hammer', label: 'Click the banhammer (stops when clicks are negligible)' },
  { key: 'pizza', label: 'Pizza party (feed everyone)' },
  { key: 'streamer', label: 'Streamer minigames (speedrun, react, launch)' },
  { key: 'region', label: 'Wrong region: pick the right flag' },
  { key: 'legends', label: 'Legends (ZABURUFF, BENZON, crew)' },
  { key: 'bugs', label: 'Squash crawling bugs' },
  { key: 'evaders', label: 'Pop ban evaders' },
  { key: 'weird', label: 'Weird events (coup, strike, you are banned)' },
  { key: 'notch', label: 'Strictness notch (loosest that stays safe)' },
  { key: 'shimmers', label: 'Click bonus objects (skips red reports)' },
  { key: 'clip', label: 'Clip it! (live cheater stream)' },
  { key: 'relics', label: 'Evidence Seized: pick a relic' },
  { key: 'priority', label: 'Priority cases' },
  { key: 'tickets', label: 'Tickets & repairs' },
  { key: 'weekend', label: 'Weekends (work unless burnout high)' },
  { key: 'incidents', label: 'Other incidents (pay when it pays off)' },
  { key: 'coffee', label: 'Coffee run' },
  { key: 'callHammer', label: 'Call the Hammer' },
  { key: 'lever', label: 'Pull the Lever at high burnout' },
  { key: 'coinLock', label: 'Coin-Lock during dupe/economy meta' },
  { key: 'audit', label: 'Audits' },
  { key: 'report', label: 'Transparency reports (clean only)' },
  { key: 'dupes', label: 'Dupe outbreaks' },
  { key: 'banWaves', label: 'Ban waves (100%, audit first when possible)' },
];

export const OPS_DEFAULTS = Object.fromEntries(OPS.map(o => [o.key, true]));

// Tunables. Burnout is 0..100; humans lose burnout/200 of output.
const COFFEE_MAX_BURNOUT = 40; // the game's own "suggest" threshold
const WEEKEND_WORK_MAX_BURNOUT = 50; // crunch adds +20; stay under the 70 "hot" line
const LEVER_AT_BURNOUT = 70; // the game's "hot" threshold
const CLEAN_REPORT_RATIO = 0.35; // reality/perception below this = clean verdict
const REACTION_MS = [600, 2200];
const FAST_REACTION_MS = [250, 700]; // short-window prompts (clip it)
// A priority case pays double when "airtight" (enough hammer clicks seen).
// Hold the verdict for that while the hammer clicker runs, unless time is short.
const PRIORITY_MIN_SECONDS_LEFT = 2.5;
const TICKS_PER_SEC = 30;

// Relic preference given what this script automates. Priority cases are
// always ruled correctly, so the cat and little brother never trigger; only
// clean reports are published, so the sharpie only adds leak risk; evaders
// are not popped, so the mustache bin only makes them siphon more.
const RELIC_RANK = ['thermos', 'ringLight', 'lunchbox', 'tally', 'phil', 'loadedDie', 'cat', 'littleBrother'];
const RELIC_NAMES = {
  "Kevin's Night-Shift Thermos": 'thermos',
  "The Streamer's Ring Light": 'ringLight',
  "Grandma's Lunchbox": 'lunchbox',
  "The Auditor's Tally Counter": 'tally',
  'A Second Phil': 'phil',
  "The Tribunal's Loaded Die": 'loadedDie',
  'The Cat': 'cat',
  'The Little Brother': 'littleBrother',
};

// Incident choices: return the button index to press, or null to let the card
// expire (expiry picks option 1 for free). Costs are seconds of production.
const INCIDENTS = {
  // 60s / 120s to restore a stopped department: pay only if the production
  // lost over the remaining stoppage is worth more than the fee.
  employeeQuits: (inc, game) => payIfStoppageCostsMore(inc, game, 'quit:'),
  vendorLapse: (inc, game) => payIfStoppageCostsMore(inc, game, 'vendor:'),
  excelLimit: () => 0, // 300s for a permanent ×1.5 on Log Analysts
  streamerAccusation: () => 0, // 60s: Perception -10, credibility +3
  falsePositive: () => 0, // 30s: Perception -12, credibility +4 (vs +4 / -8)
  wrongfulBans: () => 0, // 60s: Perception -6, credibility +3 (vs +5 / -5)
  cheatSeller: () => 0, // 120s for a 50-80% shot at +400s of bans
  cheatSellerLawsuit: () => 0, // 300s for +1500s of bans, Perception -8
};
// Leadership's "turn it all off" card: option 0 switches the anti-cheat off,
// option 1 costs 60s for nothing. Letting it expire is the free option 1.

// Pays (0) when the output lost over the remaining stoppage exceeds the fee,
// otherwise explicitly waits it out (1, free).
function payIfStoppageCostsMore(inc, game, prefix) {
  const b = inc.building;
  const buff = game.G.s.buffs.find(x => x.key === prefix + b);
  const fee = inc.choice.costs[0];
  if (!buff || game.G.s.bans < fee) return 1;
  const lostPerSec = buffCost(game, buff.key);
  return lostPerSec * (buff.time / TICKS_PER_SEC) > fee ? 0 : 1;
}

const LAUNCH_DROP_SECONDS = 1.5;

// Notch controller. Wave heat = 100 × innocent share × f^1.5 × (1.3 − 0.6 ×
// credibility/100) × a 0.7–1.3 roll; verdict tiers start at heat 5/15/35/70.
// Tier 1 is a mild ×0.85 for 60 s; tier 2+ costs real production and
// perception, so keep the worst-case roll under 15 with margin.
const NOTCH_HEAT_HIGH = 12;
const NOTCH_HEAT_LOW = 4;
const HEAT_WORST_ROLL = 1.3;
const AUDIT_KEEPS = 0.3; // a 5/5 audit scrubs about 75% of innocents
const NOTCH_MIN_METER = 0.15; // too little pile to judge before this
const NOTCH_STEP_MS = [4000, 8000]; // new pile only reflects the notch slowly

const PIZZA_REACTION_MS = [120, 320];
const PIZZA_CUTS_EACH = 4;

// Hold a charged wave this long at most for the audit cooldown to finish.
const AUDIT_WAIT_SECONDS = 20;

// Satisfies the game's prerequisites: identify<-page, hotfix/ban<-identify,
// rollback<-hotfix+coinlock, community<-hotfix+leadership.
// Duped gold stops growing once the hotfix ships, so get there first. Gold
// stays under 60 by then, so leadership adds no harm afterwards.
const DUPE_ORDER = ['page', 'identify', 'hotfix', 'leadership', 'coinlock', 'ban', 'rollback', 'community'];

// Weird events with a choice: button index to press.
const WEIRD = {
  modCoup: () => 1, // pay 30 s of production to end 40 s of "only Moderators work"
  youAreBanned: () => 1, // "I AM the anti-cheat": 60% for +600 s vs a sure +180 s
  cheaterStrike: () => 0, // ×4 for 30 s vs ×0.1 until the strike ends
};
const DUPE_LABELS = {
  page: 'Page the on-call engineer',
  coinlock: 'COIN-LOCK the economy',
  identify: 'Find the exploit in the logs',
  hotfix: 'Ship the hotfix',
  ban: 'Ban the duper accounts',
  rollback: 'Roll back the duped gold',
  leadership: 'Brief leadership',
  community: 'Post to the community',
};

const since = new Map();
const delays = new Map();

// True once `eligible` has held continuously for this key's reaction delay.
function ready(key, eligible, range = REACTION_MS) {
  if (!eligible) {
    since.delete(key);
    delays.delete(key);
    return false;
  }
  const now = performance.now();
  if (!since.has(key)) {
    since.set(key, now);
    delays.set(key, range[0] + Math.random() * (range[1] - range[0]));
  }
  if (now - since.get(key) < delays.get(key)) return false;
  since.delete(key);
  delays.delete(key);
  return true;
}

function usable(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el || el.disabled || el.classList.contains('hidden')) return null;
  return el;
}

function press(el) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  el.click();
}

// Incident cards carry no id; match the card by its title.
function incidentCard(inc) {
  for (const card of document.querySelectorAll('.incident')) {
    const b = card.querySelector('.incHead b');
    if (b && b.textContent === inc.title) return card;
  }
  return null;
}

const ROUTINES = {
  shimmers(G) {
    for (const el of document.querySelectorAll('#shimmers .shimmer:not(.wrath)')) {
      if (ready('shimmer:' + shimmerKey(el), true)) {
        // Shimmers listen for pointerdown only.
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        return 'clicked bonus';
      }
    }
    return null;
  },

  // 75 s to feed 12 seats 2 slices + 1 soda each (36 servings) plus 12 cuts
  // and 12 sodas. Payout scales with the fraction fed, so keep it moving:
  // serve whenever possible, otherwise cut a pizza, otherwise open a soda.
  pizza(G) {
    const p = G.s.party;
    if (!p) {
      const done = document.querySelector('.pzResult:not(.hidden) .pzDone');
      if (!ready('pizza-done', !!done)) return null;
      done.click();
      return 'pizza: back to banning';
    }
    if (!ready('pizza:' + p.fed + ':' + p.cuts + ':' + p.opened, true, PIZZA_REACTION_MS)) return null;
    let seat = p.want.findIndex(w => w > 0);
    if (seat >= 0 && p.slices <= 0) seat = -1;
    if (seat < 0 && p.sodas > 0) seat = p.soda.findIndex(n => n > 0);
    if (seat >= 0) {
      const el = document.querySelector(`.pzTable .pzSeat[data-i="${seat}"]`);
      if (el) {
        el.click();
        return `pizza: fed ${p.fed + 1}/36`;
      }
    }
    const pizza = p.pcuts.findIndex(c => c < PIZZA_CUTS_EACH);
    if (pizza >= 0 && p.slices <= 0) {
      document.querySelectorAll('.pzPizza')[pizza]?.click();
      return 'pizza: cut';
    }
    if (p.opened < p.want.length) {
      document.querySelector('.pzCooler')?.click();
      return 'pizza: soda';
    }
    if (pizza >= 0) document.querySelectorAll('.pzPizza')[pizza]?.click();
    return null;
  },

  // Wave launch alarm: the right region is in state; each wrong flag adds
  // innocents to the pending wave and Perception +2.
  region(G) {
    const reg = G.s.truth.region;
    const flag = reg ? document.querySelector(`#regionRoom .rgFlag[data-r="${reg.ans}"]`) : null;
    if (!ready('region', !!flag, FAST_REACTION_MS)) return null;
    flag.click();
    return 'region: picked the right flag';
  },

  legends() {
    const el = usable('#zaburuff') ?? usable('#benzon') ??
      [...document.querySelectorAll('.crewLegend')].find(e => usable(e));
    if (!ready('legend:' + (el ? el.id || el.className : ''), !!el)) return null;
    el.click();
    return 'legend: ' + (el.id || el.title.split(',')[0]);
  },

  bugs() {
    const bug = document.querySelector('#bugLayer .crawlBug');
    if (!ready('bug', !!bug, FAST_REACTION_MS)) return null;
    bug.click();
    return 'squashed a bug';
  },

  // Evaders are drawn on the canvas; the game hit-tests pointerdowns there.
  // Position math mirrors the game's own layout (yp/bp).
  evaders(G) {
    const ev = G.s.evaders[0];
    if (!ready('evader:' + (ev ? ev.id + ':' + ev.hp : ''), !!ev)) return null;
    const canvas = document.querySelector('#leftCanvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const z = Math.max(50, Math.min(Math.min(w, h * 0.6) * 0.29, (h - 230) / 3.4, 160));
    const cx = w * 0.46;
    const cy = Math.max(h * 0.46, 120 + 2.1 * z);
    const dist = z * (2.75 - 1.45 * ev.close);
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true,
      clientX: rect.left + cx + Math.cos(ev.angle) * dist,
      clientY: rect.top + cy + Math.sin(ev.angle) * dist,
    }));
    return 'hit an evader';
  },

  weird(G) {
    const wd = G.s.weird;
    const policy = wd && wd.choice && wd.choice.chosen === undefined ? WEIRD[wd.key] : null;
    if (!ready('weird:' + (wd ? wd.id : ''), !!policy)) return null;
    const pick = policy(wd);
    const btns = wd.key === 'youAreBanned'
      ? document.querySelectorAll('.banBtn')
      : document.querySelectorAll('.wActions .incBtn');
    const btn = usable(btns[pick]);
    if (!btn) return null;
    btn.click();
    return `${wd.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
  },

  streamer(G) {
    const wd = G.s.weird;
    if (!wd || !wd.x) return null;
    if (wd.key === 'banSpeedrun') {
      // Each alt is clickable for 2.4 s; 8 bans in 50 s wins.
      const alt = document.querySelector('.lcMsgs .lcAlt.active');
      if (!ready('speedrun:' + wd.x[0], !!alt, FAST_REACTION_MS)) return null;
      alt.click();
      return 'speedrun: banned an alt';
    }
    if (wd.key === 'devsReact') {
      // The good clip's index is wd.x[1]; each poll is open 10 s.
      const btn = wd.v > 0 ? usable(`.lcCtl button[data-arg="${wd.x[1]}"]`) : null;
      if (!ready('react:' + wd.x[0], !!btn)) return null;
      btn.click();
      return 'devs react: picked the good clip';
    }
    if (wd.key === 'cheatLaunch') {
      // The stream's end tick is pre-rolled in wd.x[1]; payout grows with
      // buyers, so drop the wave just before it ends.
      const left = (wd.x[1] - wd.x[0]) / TICKS_PER_SEC;
      const btn = wd.v === 0 && left <= LAUNCH_DROP_SECONDS ? usable('.lcCtl button[data-arg]') : null;
      if (!ready('launch', !!btn, [30, 120])) return null;
      btn.click();
      return `cheat launch: dropped with ${Math.floor(wd.n)} buyers`;
    }
    return null;
  },

  // Looser notch = meter fills faster (more ×3+ waves per hour) but adds more
  // innocents, which raise the wave's heat and risk a bad verdict. Step
  // looser while the pile's projected heat (after a perfect audit, worst-case
  // roll) stays low; step stricter when it climbs toward the tier-2 line.
  notch(G, enabled) {
    const t = G.s.truth;
    if (!t.pile || G.s.waveMeter < NOTCH_MIN_METER) return null;
    const heat = projectedHeat(G, enabled);
    let dir = 0;
    if (heat > NOTCH_HEAT_HIGH) dir = -1;
    else if (heat < NOTCH_HEAT_LOW) dir = 1;
    let btn = null;
    if (dir < 0) btn = usable('#nPrev');
    if (dir > 0) btn = usable('#nNext');
    if (!ready('notch:' + t.notch + ':' + dir, !!btn, NOTCH_STEP_MS)) return null;
    btn.click();
    return `notch ${dir < 0 ? 'stricter' : 'looser'} (projected heat ${heat.toFixed(1)})`;
  },

  // The hammer clicker runs on its own faster loop (startHammer); nothing here.
  hammer() {
    return null;
  },

  clip(G) {
    const live = G.s.weird && G.s.weird.key === 'caughtLive';
    const btn = live ? usable('.liveChat .lcClip.ready') : null;
    if (!ready('clip', !!btn, FAST_REACTION_MS)) return null;
    btn.click();
    return 'clipped it';
  },

  relics() {
    const offer = document.querySelector('#relicOffer');
    const open = !!offer && !offer.classList.contains('hidden') && !!offer.querySelector('.offerCards');
    if (!ready('relic', open)) return null;
    let best = null;
    let bestRank = Infinity;
    for (const card of offer.querySelectorAll('.offerCard')) {
      const id = RELIC_NAMES[card.querySelector('.offerName')?.textContent.trim()];
      const rank = RELIC_RANK.indexOf(id);
      if (rank >= 0 && rank < bestRank) {
        best = card;
        bestRank = rank;
      }
    }
    // Nothing worth taking: leave it in the bag for 2 minutes of bans.
    const btn = best ?? offer.querySelector('.offerFoot button[data-i="3"]');
    if (!btn) return null;
    btn.click();
    return best ? 'relic: ' + RELIC_RANK[bestRank] : 'relic: left in the bag';
  },

  priority(G, enabled) {
    const cur = G.s.priority && G.s.priority.cur;
    const waitForAirtight = enabled.hammer && cur && cur.hits < cur.need &&
      cur.t / TICKS_PER_SEC > PRIORITY_MIN_SECONDS_LEFT;
    const eligible = !!cur && !cur.verdict && !waitForAirtight;
    if (!ready('priority:' + (cur ? cur.id : ''), eligible)) return null;
    const btn = usable(cur.guilty ? '#priorityBox .pBan' : '#priorityBox .pLegit');
    if (!btn) return null;
    btn.click();
    return cur.guilty ? 'priority: ban' : 'priority: legit';
  },

  tickets(G) {
    for (const inc of G.s.incidents) {
      if (inc.ticket && !inc.ticket.done) {
        if (!ready('ticket:' + inc.id, true)) continue;
        const btns = incidentCard(inc)?.querySelectorAll('.ticketBtn');
        const btn = btns && usable(btns[inc.ticket.answer]);
        if (btn) {
          btn.click();
          return 'ticket answered';
        }
      }
      if (inc.repair && inc.repair.hits < inc.repair.need) {
        if (!ready('repair:' + inc.id + ':' + inc.repair.hits, true)) continue;
        const lit = incidentCard(inc)?.querySelector('.repairBtn.lit');
        if (lit) {
          lit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          return 'repair hit';
        }
      }
    }
    return null;
  },

  weekend(G) {
    const inc = G.s.incidents.find(i => i.key === 'weekend' && i.choice && i.choice.chosen === undefined);
    if (!ready('weekend:' + (inc ? inc.id : ''), !!inc)) return null;
    const work = G.s.staff.burnout <= WEEKEND_WORK_MAX_BURNOUT;
    const btn = incidentCard(inc)?.querySelectorAll('.incBtn')[work ? 0 : 1];
    if (!usable(btn)) return null;
    btn.click();
    return work ? 'weekend: work' : 'weekend: off';
  },

  incidents(G, enabled, game) {
    for (const inc of G.s.incidents) {
      if (!inc.choice || inc.choice.chosen !== undefined) continue;
      const policy = INCIDENTS[inc.key];
      const pick = policy ? policy(inc, game) : null;
      if (pick === null || G.s.bans < inc.choice.costs[pick]) continue;
      if (!ready('incident:' + inc.id, true)) continue;
      const btn = incidentCard(inc)?.querySelectorAll('.incBtn')[pick];
      if (!usable(btn)) continue;
      btn.click();
      return `${inc.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
    }
    return null;
  },

  coffee(G) {
    const st = G.s.staff;
    const ok = st.burnout < COFFEE_MAX_BURNOUT && !st.week.weekend && st.lever.party <= 0;
    const btn = usable('#coffeeBtn');
    if (!ready('coffee', ok && !!btn)) return null;
    btn.click();
    return 'coffee run';
  },

  callHammer() {
    const btn = usable('#hammerBtn');
    if (!ready('callHammer', !!btn)) return null;
    btn.click();
    return 'called the hammer';
  },

  lever(G) {
    const btn = usable('#leverBtn');
    if (!ready('lever', !!btn && G.s.staff.burnout >= LEVER_AT_BURNOUT)) return null;
    btn.click();
    return 'pulled the lever';
  },

  coinLock(G) {
    const meta = G.s.meta && G.s.meta.cur;
    const btn = usable('#coinBtn');
    if (!ready('coin', !!btn && (meta === 'duping' || meta === 'economy'))) return null;
    btn.click();
    return 'coin-lock';
  },

  audit(G) {
    const truth = G.s.truth;
    const panel = document.querySelector('.auRows');
    const open = panel && !panel.closest('.hidden') && truth.audit && truth.audit.cases;
    if (open) {
      // Rows default to "keep banned"; clear the innocent ones, then submit.
      const rows = [...document.querySelectorAll('.auRow')];
      for (const row of rows) {
        const c = truth.audit.cases[+row.dataset.i];
        const clear = row.querySelector('button[data-v="1"]');
        if (c && !c.g && clear && !clear.classList.contains('on')) {
          if (!ready('audit-row:' + row.dataset.i, true)) return null;
          clear.click();
          return 'audit: cleared one';
        }
      }
      const submit = usable('.auSubmit');
      if (!ready('audit-submit', !!submit)) return null;
      submit.click();
      return 'audit submitted';
    }
    const btn = usable('#auditBtn');
    const pile = truth.pile;
    if (!ready('audit-start', !!btn && !(pile && pile.audited))) return null;
    btn.click();
    return 'audit started';
  },

  report(G) {
    const ratio = G.s.reality / Math.max(1, G.s.perception);
    const btn = usable('#repBtn');
    if (!ready('report', !!btn && ratio < CLEAN_REPORT_RATIO)) return null;
    btn.click();
    return 'transparency report';
  },

  // Launch at 100%. The wave bonus grows roughly linearly with charge while
  // holding raises the perception target and the odds of a bad verdict, so
  // this beats Agentic AI's 200% auto-launch too. Audit first only when an
  // audit is possible soon; early game (no Moderator) launches right away.
  banWaves(G, enabled) {
    const truth = G.s.truth;
    const pile = truth.pile;
    const btn = usable('#waveBtn');
    const charged = !!btn && G.s.waveMeter >= 1;
    const auditSoon = enabled.audit && G.s.buildings.moderator.amount > 0 &&
      !(pile && pile.audited) && truth.auditCd / TICKS_PER_SEC <= AUDIT_WAIT_SECONDS;
    if (!ready('wave', charged && !auditSoon)) return null;
    btn.click();
    return 'launched ban wave';
  },

  // Work the response cards in dependency order, fastest path, no playbook
  // (it voids the flawless bonus). Leadership first: it adds harm once the
  // duped gold passes 60.
  dupes(G, enabled, game) {
    const d = game.dupe;
    const room = document.querySelector('#dupeRoom');
    if (!d || !d.active || !room || room.classList.contains('hidden')) return null;
    const step = DUPE_ORDER.find(k => !d.done.includes(k));
    if (!step) return null;
    const logs = room.querySelectorAll('.drLogs .drLog');
    if (step === 'identify' && logs.length) {
      if (!ready('dupe-log', true, FAST_REACTION_MS)) return null;
      logs[d.answer]?.click();
      return 'dupe: picked log line';
    }
    // The COIN-LOCK card counts as done while the ability is active.
    const card = [...room.querySelectorAll('.drCard')].find(c => c.querySelector('b')?.textContent === DUPE_LABELS[step]);
    if (!usable(card) || !ready('dupe:' + step, true, FAST_REACTION_MS)) return null;
    card.click();
    return 'dupe: ' + step;
  },
};

// Banhammer clicker. The game accepts one click per tick and at most 20 per
// second, and flags more than 15 in a second as an auto-clicker. Every click
// is a recorded input, so stay well under that and stop when clicks stop
// mattering (late game, unless a priority case needs evidence).
export const HAMMER_CPS = 8;
const HAMMER_MIN_SHARE = 0.01; // clicks must add at least 1% of passive income

export function startHammer(game, getSettings) {
  const loop = () => {
    const settings = getSettings();
    if (settings.auto && settings.ops.hammer && hammerWorthwhile(game.G)) clickHammer();
    const jitter = 0.7 + Math.random() * 0.6;
    setTimeout(loop, (1000 / HAMMER_CPS) * jitter);
  };
  loop();
}

function hammerWorthwhile(G) {
  if (G.ascending) return false;
  const cur = G.s.priority && G.s.priority.cur;
  if (cur && !cur.verdict && cur.hits < cur.need) return true;
  return G.clickPower * HAMMER_CPS >= HAMMER_MIN_SHARE * G.bps;
}

function clickHammer() {
  const el = document.querySelector('#hammerHit');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = r.left + r.width * (0.35 + Math.random() * 0.3);
  const y = r.top + r.height * (0.35 + Math.random() * 0.3);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

// Worst-case heat of the wave currently charging, after the audit the
// automation would run. Shared by the notch controller and the stats log.
export function projectedHeat(G, enabled) {
  const t = G.s.truth;
  if (!t.pile) return null;
  const innocentShare = t.pile.inn / Math.max(0.001, G.s.waveMeter);
  const auditing = enabled.audit && G.s.buildings.moderator.amount > 0 && !t.pile.audited;
  const scrub = auditing ? AUDIT_KEEPS : 1;
  return 100 * innocentShare * scrub * HEAT_WORST_ROLL * (1.3 - 0.6 * t.cred / 100);
}

let shimmerSeq = 0;
const shimmerIds = new WeakMap();
function shimmerKey(el) {
  if (!shimmerIds.has(el)) shimmerIds.set(el, ++shimmerSeq);
  return shimmerIds.get(el);
}

// Runs at most one action per call, in OPS order. Returns a log line or null.
export function runOps(game, enabled) {
  const G = game.G;
  if (G.ascending) return null;
  for (const { key } of OPS) {
    if (!enabled[key]) continue;
    try {
      const did = ROUTINES[key](G, enabled, game);
      if (did) return did;
    } catch (e) {
      return `${key} error: ${e.message}`;
    }
  }
  return null;
}
