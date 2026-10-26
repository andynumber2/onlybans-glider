// Automation for everything besides purchases. Every action is a click on the
// game's own UI, so it runs the same recorded handler a human click does.
// In human mode (src/input.js) each routine waits a random reaction delay
// after its target becomes actionable, and only clicks what is not covered.

export const OPS = [
  { key: 'hammer', label: 'Click the banhammer (stops when clicks are negligible)' },
  { key: 'pizza', label: 'Pizza party (feed everyone)' },
  { key: 'popups', label: 'Close pop-ups (judgment scroll, blue screen, welcome, field trip)' },
  { key: 'sequel', label: 'Ship sequels (when production would at least ×2, ×6 with Golden picks) and buy the Reputation shop' },
  { key: 'streamer', label: 'Streamer minigames (speedrun, react, launch)' },
  { key: 'region', label: 'Wrong region: pick the right flag' },
  { key: 'legends', label: 'Legends (ZABURUFF, BENZON, crew)' },
  { key: 'bugs', label: 'Squash crawling bugs' },
  { key: 'evaders', label: 'Pop ban evaders' },
  { key: 'weird', label: 'Weird events (coup, strike, you are banned)' },
  { key: 'notch', label: 'Strictness notch (loosest that stays safe)' },
  { key: 'shimmers', label: 'Click bonus objects (incl. red reports: higher EV)' },
  { key: 'clip', label: 'Clip it! (live cheater stream)' },
  { key: 'relics', label: 'Evidence Seized: pick a relic' },
  { key: 'priority', label: 'Priority cases' },
  { key: 'tickets', label: 'Tickets & repairs' },
  { key: 'weekend', label: 'Weekends (work unless burnout high)' },
  { key: 'incidents', label: 'Other incidents (pay when it pays off)' },
  { key: 'coffee', label: 'Coffee run' },
  { key: 'callHammer', label: 'Call the Hammer' },
  { key: 'lever', label: 'Pull the Lever (when ready; near-full burnout with the Thermos)' },
  { key: 'coinLock', label: 'Coin-Lock during dupe/economy meta' },
  { key: 'audit', label: 'Audits' },
  { key: 'report', label: 'Transparency reports (clean only)' },
  { key: 'dupes', label: 'Dupe outbreaks' },
  { key: 'banWaves', label: 'Ban waves (hold to 267%, audit first when possible)' },
];

export const OPS_DEFAULTS = Object.fromEntries(OPS.map(o => [o.key, o.default ?? true]));

// Tunables. Burnout is 0..100; humans lose burnout/200 of output.
const COFFEE_MAX_BURNOUT = 40; // the game's own "suggest" threshold
const WEEKEND_WORK_MAX_BURNOUT = 50; // crunch adds +20; stay under the 70 "hot" line
// Without the Thermos, pull whenever ready: the 900 s cooldown limits pulls,
// and each one trades 45 s of humans for 120 s of humans ×2 plus a burnout
// reset (read from code; untested in the simulator, where every seed owns
// the Thermos before the Lever unlocks).
const LEVER_AT_BURNOUT = 0;
const THERMOS_LEVER_AT = 95; // Thermos: tech ×(3 + burnout/10) during the party

function hasRelic(game, id) {
  return !!(game && game.relics && game.relics.owned.includes(id));
}

// Thermos strategy: let burnout climb (always work weekends, coffee whenever)
// and hold the Lever until burnout is near full. Simulated at about +32% vs
// the normal thresholds with the Thermos owned (3 seeds, 2 game-hours).
function thermosCrunch(game) {
  return hasRelic(game, 'thermos');
}

function kernelPanic(G) {
  return !!(G.s.weird && G.s.weird.key === 'kernelPanic');
}
const CLEAN_REPORT_RATIO = 0.35; // reality/perception below this = clean verdict
const REACTION_MS = [600, 2200];
const FAST_REACTION_MS = [250, 700]; // short-window prompts (clip it)
// A priority case pays double when "airtight" (enough hammer clicks seen).
// Hold the verdict for that while the hammer clicker runs, unless time is short.
const PRIORITY_MIN_SECONDS_LEFT = 2.5;
const TICKS_PER_SEC = 30;

// Relic preference given what this script automates. Golden reports are
// worth ~100% of production, so doubling them (glider monitors) is best.
// Evaders are popped within seconds, so the mustache bin's extra siphon
// never lands and each pop spawns a free golden report. The lunchbox fixes
// golden reports at 242 s and ignores the golden upgrades, so it loses once
// Anonymous Tip Line is owned. Priority cases are always ruled correctly, so
// the cat and little brother rarely trigger. Never offered here: pager,
// sharpie, loaded die (cursed/contraband come from other sources).
const RELIC_RANK = ['gliderMonitors', 'mustacheBin', 'thermos', 'ringLight', 'noteJar', 'lunchbox', 'tally', 'phil', 'cat', 'littleBrother'];
const RELIC_RANK_WITH_TIP_LINE = RELIC_RANK.filter(id => id !== 'lunchbox');
const RELIC_NAMES = {
  'The Glider Dev\'s Two 27" Monitors': 'gliderMonitors',
  'Bin of Confiscated Fake Mustaches': 'mustacheBin',
  'Jar of "pls unban" Notes': 'noteJar',
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
// perception, so keep the worst-case roll under 15 with margin: a wave that
// landed at heat 10 could have rolled up to 10 × 1.3 / 0.7 ≈ 18 on bad luck.
const NOTCH_HEAT_HIGH = 10;
const NOTCH_HEAT_LOW = 4;
const HEAT_WORST_ROLL = 1.3;
const AUDIT_KEEPS = 0.3; // a 5/5 audit scrubs about 75% of innocents
const notchState = { pending: false, lastHeat: 0, lastTier: 0 };

// An audit only scrubs innocents already in the pile, so run it just before
// launch. (Run at ~25% charge, it left 4-27% innocents in waves, 3 of 9
// TRENDING.) Launch waits for it when an audit is close.
const AUDIT_AT_METER = 0.85; // fraction of the launch point

// Wave meter level to launch at (1 = 100%). The multiplier is
// round(3 + 1.5 × (meter − 1)), so ×6 from 267% (read from code). Simulated
// 100/134/200/267%: 267% won on all 3 seeds, about 4.7× bans vs 100%
// (2 game-hours, 2026-10-15). Hidden knob ops.waveAt for further tests.
export const WAVE_LAUNCH_AT = 2.67;
function waveLaunchAt(enabled) {
  return enabled.waveAt ?? WAVE_LAUNCH_AT;
}
// During a ×2+ boost a wave launches at 100%: its multiplier stacks on the boost.
function effectiveLaunchAt(G, enabled) {
  if (productionBoost(G) >= 2) return 1;
  return waveLaunchAt(enabled);
}
// Skipping the audit to catch a boost is only worth it when the wave would
// stay below tier 2 (APPEALS at most) without one.
const SKIP_AUDIT_MAX_HEAT = 15;

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
// Outside human mode (Anti anti-cheat off) there is no delay.
function ready(key, eligible, range = REACTION_MS) {
  if (!eligible || !humanMode()) {
    since.delete(key);
    delays.delete(key);
    return eligible;
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

// The game sets these buttons' `disabled` in its render loop, which stops in a
// hidden tab, so right after use a button still reads as ready and every press
// is refused (thousands of refused coin-locks in the input log). Gate on the
// same timers the game checks.
const STAFF_BUSY = {
  '#coinBtn': (st) => st.coinLock.cd > 0 || st.coinLock.t > 0,
  '#coffeeBtn': (st) => st.coffee.cd > 0 || st.coffee.t > 0,
  '#hammerBtn': (st) => st.hammer.cd > 0,
  '#leverBtn': (st) => st.lever.cd > 0 || st.lever.party > 0,
};

function staffButton(G, sel) {
  if (STAFF_BUSY[sel](G.s.staff)) return null;
  return usable(sel);
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
  shimmers(G, enabled, game) {
    const els = document.querySelectorAll('#shimmers .shimmer');
    const pick = enabled.goldenPick && goldenPickState.on;
    if (pick) {
      const off = checkGoldenPick(G);
      if (off) return off;
    }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      // Golden report look-ahead: elements and G.shimmers are in the same
      // order (both added at spawn, removed at pop or expiry).
      const sh = pick && els.length === G.shimmers.length ? G.shimmers[i] : null;
      if (sh && sh.type === 'golden' && sh.chain === 0 && el.classList.contains('wrath') === !!sh.wrath) {
        if (!goldenNoticed.has(el)) {
          if (!ready('shimmer:' + shimmerKey(el), true)) continue;
          goldenNoticed.add(el);
        }
        const effect = predictGolden(game, sh);
        // Anomaly Detection (bought before the look-ahead was on; it resets
        // at the next sequel) pops the report itself 2.5 s after it appears.
        let left = sh.life;
        if (G.s.upgradesBought.has('tool:anomaly')) left = Math.min(left, Math.floor(2.5 * TICKS_PER_SEC) - (sh.maxLife - sh.life));
        const lastChance = left <= GOLDEN_LAST_CHANCE_TICKS;
        if (!goldenTake(G, effect) && !(lastChance && !GOLDEN_NEVER.has(effect))) continue;
        const before = G.s.eventsClicked;
        if (!pointerDown(el)) return null;
        goldenPickState.pending = { effect, clicked: before };
        goldenPickState.picks++;
        // Applied at once unless queued behind a check-in; check now, before
        // another click (or Anomaly Detection) overwrites lastEffect.
        if (G.s.eventsClicked > goldenPickState.pending.clicked) return checkGoldenPick(G) ?? `golden ${effect}`;
        return `golden ${effect}`;
      }
      // A bot storm inside a meltdown: bots pay the buffed production, so a
      // person would hurry.
      const hurry = pick && meltdownLeft(G) > 0;
      if (ready('shimmer:' + shimmerKey(el), true, hurry ? FAST_REACTION_MS : REACTION_MS)) {
        // Shimmers listen for pointerdown only.
        if (!pointerDown(el)) return null;
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
      // The result card stays un-hidden inside the overlay after closing, so
      // check that nothing above the button is hidden.
      const done = document.querySelector('.pzResult .pzDone');
      if (!ready('pizza-done', !!done && !done.closest('.hidden'))) return null;
      if (!click(done)) return null;
      return 'pizza: back to banning';
    }
    if (!ready('pizza:' + p.fed + ':' + p.cuts + ':' + p.opened, true, PIZZA_REACTION_MS)) return null;
    let seat = p.want.findIndex(w => w > 0);
    if (seat >= 0 && p.slices <= 0) seat = -1;
    if (seat < 0 && p.sodas > 0) seat = p.soda.findIndex(n => n > 0);
    if (seat >= 0) {
      const el = document.querySelector(`.pzTable .pzSeat[data-i="${seat}"]`);
      if (el) {
        if (!click(el)) return null;
        return `pizza: fed ${p.fed + 1}/36`;
      }
    }
    const pizza = p.pcuts.findIndex(c => c < PIZZA_CUTS_EACH);
    if (pizza >= 0 && p.slices <= 0) {
      if (!click(document.querySelectorAll('.pzPizza')[pizza])) return null;
      return 'pizza: cut';
    }
    if (p.opened < p.want.length) {
      if (!click(document.querySelector('.pzCooler'))) return null;
      return 'pizza: soda';
    }
    if (pizza >= 0) click(document.querySelectorAll('.pzPizza')[pizza]);
    return null;
  },

  // Wave launch alarm: the right region is in state; each wrong flag adds
  // innocents to the pending wave and Perception +2.
  region(G) {
    const reg = G.s.truth.region;
    const flag = reg ? document.querySelector(`#regionRoom .rgFlag[data-r="${reg.ans}"]`) : null;
    if (!ready('region', !!flag, FAST_REACTION_MS)) return null;
    if (!click(flag)) return null;
    return 'region: picked the right flag';
  },

  legends() {
    const el = usable('#zaburuff') ?? usable('#benzon') ??
      [...document.querySelectorAll('.crewLegend')].find(e => usable(e));
    if (!ready('legend:' + (el ? el.id || el.className : ''), !!el)) return null;
    if (!click(el)) return null;
    return 'legend: ' + (el.id || el.title.split(',')[0]);
  },

  bugs() {
    const bug = document.querySelector('#bugLayer .crawlBug');
    if (!ready('bug', !!bug, FAST_REACTION_MS)) return null;
    if (!click(bug)) return null;
    return 'squashed a bug';
  },

  // Evaders are drawn on the canvas; the game hit-tests pointerdowns there.
  // Position math mirrors the game's own layout (yp/bp).
  evaders(G, enabled, game) {
    const ev = evaderTarget(G, enabled, game);
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
    const x = rect.left + cx + Math.cos(ev.angle) * dist;
    const y = rect.top + cy + Math.sin(ev.angle) * dist;
    if (!pointerDownAt(x, y, [canvas, document.querySelector('#hammerHit')])) return null;
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
    if (!click(btn)) return null;
    return `${wd.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
  },

  streamer(G) {
    const wd = G.s.weird;
    if (!wd || !wd.x) return null;
    if (wd.key === 'banSpeedrun') {
      // Each alt is clickable for 2.4 s; 8 bans in 50 s wins.
      const alt = document.querySelector('.lcMsgs .lcAlt.active');
      if (!ready('speedrun:' + wd.x[0], !!alt, FAST_REACTION_MS)) return null;
      if (!click(alt)) return null;
      return 'speedrun: banned an alt';
    }
    if (wd.key === 'devsReact') {
      // The good clip's index is wd.x[1]; each poll is open 10 s.
      const btn = wd.v > 0 ? usable(`.lcCtl button[data-arg="${wd.x[1]}"]`) : null;
      if (!ready('react:' + wd.x[0], !!btn)) return null;
      if (!click(btn)) return null;
      return 'devs react: picked the good clip';
    }
    if (wd.key === 'cheatLaunch') {
      // The stream's end tick is pre-rolled in wd.x[1]; payout grows with
      // buyers, so drop the wave just before it ends.
      const left = (wd.x[1] - wd.x[0]) / TICKS_PER_SEC;
      const btn = wd.v === 0 && left <= LAUNCH_DROP_SECONDS ? usable('.lcCtl button[data-arg]') : null;
      if (!ready('launch', !!btn, [30, 120])) return null;
      if (!click(btn)) return null;
      return `cheat launch: dropped with ${Math.floor(wd.n)} buyers`;
    }
    return null;
  },

  // Looser notch = meter fills faster (more ×3+ waves per hour) but adds more
  // innocents, which raise the wave's heat and risk a bad verdict. The pile's
  // innocent share is too noisy to steer on mid-fill (it measured 0.2 to 40
  // within a minute), so steer on outcomes: one step per landed verdict.
  // Stricter after heat above NOTCH_HEAT_HIGH, looser after heat below
  // NOTCH_HEAT_LOW.
  notch(G) {
    const review = G.s.truth.review;
    if (review) {
      notchState.lastHeat = review.heat;
      notchState.lastTier = review.tier;
      notchState.pending = true;
      return null;
    }
    if (!notchState.pending) return null;
    let dir = 0;
    if (notchState.lastTier >= 2 || notchState.lastHeat > NOTCH_HEAT_HIGH) dir = -1;
    else if (notchState.lastHeat < NOTCH_HEAT_LOW) dir = 1;
    let btn = null;
    if (dir < 0) btn = usable('#nPrev');
    if (dir > 0) btn = usable('#nNext');
    if (!btn) {
      notchState.pending = false;
      return null;
    }
    if (!ready('notch', true)) return null;
    if (!click(btn)) return null;
    notchState.pending = false;
    return `notch ${dir < 0 ? 'stricter' : 'looser'} (last wave heat ${notchState.lastHeat.toFixed(1)})`;
  },

  // The hammer clicker runs on its own faster loop (startHammer); nothing here.
  hammer() {
    return null;
  },

  clip(G) {
    const live = G.s.weird && G.s.weird.key === 'caughtLive';
    const btn = live ? usable('.liveChat .lcClip.ready') : null;
    if (!ready('clip', !!btn, FAST_REACTION_MS)) return null;
    if (!click(btn)) return null;
    return 'clipped it';
  },

  relics(G) {
    const offer = document.querySelector('#relicOffer');
    const open = !!offer && !offer.classList.contains('hidden') && !!offer.querySelector('.offerCards');
    if (!ready('relic', open)) return null;
    let order = RELIC_RANK;
    if (G.s.upgradesBought.has('event:0')) order = RELIC_RANK_WITH_TIP_LINE;
    let best = null;
    let bestRank = Infinity;
    const offered = [];
    for (const card of offer.querySelectorAll('.offerCard')) {
      const name = card.querySelector('.offerName')?.textContent.trim() ?? '?';
      offered.push(name);
      const rank = order.indexOf(RELIC_NAMES[name]);
      if (rank >= 0 && rank < bestRank) {
        best = card;
        bestRank = rank;
      }
    }
    // Nothing worth taking: leave it in the bag for 2 minutes of bans.
    const btn = best ?? offer.querySelector('.offerFoot button[data-i="3"]');
    if (!btn) return null;
    if (!click(btn)) return null;
    if (best) return 'relic: ' + order[bestRank];
    return 'relic: left in the bag (offered: ' + offered.join(', ') + ')';
  },

  priority(G, enabled) {
    const cur = G.s.priority && G.s.priority.cur;
    const waitForAirtight = enabled.hammer && cur && cur.hits < cur.need &&
      cur.t / TICKS_PER_SEC > PRIORITY_MIN_SECONDS_LEFT;
    const eligible = !!cur && !cur.verdict && !waitForAirtight;
    if (!ready('priority:' + (cur ? cur.id : ''), eligible)) return null;
    const btn = usable(cur.guilty ? '#priorityBox .pBan' : '#priorityBox .pLegit');
    if (!btn) return null;
    if (!click(btn)) return null;
    return cur.guilty ? 'priority: ban' : 'priority: legit';
  },

  tickets(G) {
    for (const inc of G.s.incidents) {
      if (inc.ticket && !inc.ticket.done) {
        if (!ready('ticket:' + inc.id, true)) continue;
        const btns = incidentCard(inc)?.querySelectorAll('.ticketBtn');
        const btn = btns && usable(btns[inc.ticket.answer]);
        if (btn) {
          if (!click(btn)) return null;
          return 'ticket answered';
        }
      }
      if (inc.repair && inc.repair.hits < inc.repair.need) {
        if (!ready('repair:' + inc.id + ':' + inc.repair.hits, true)) continue;
        const lit = incidentCard(inc)?.querySelector('.repairBtn.lit');
        if (lit) {
          if (!pointerDown(lit)) return null;
          return 'repair hit';
        }
      }
    }
    return null;
  },

  weekend(G, enabled, game) {
    const inc = G.s.incidents.find(i => i.key === 'weekend' && i.choice && i.choice.chosen === undefined);
    if (!ready('weekend:' + (inc ? inc.id : ''), !!inc)) return null;
    // With the Thermos, burnout is fuel for the Lever: always crunch.
    const work = thermosCrunch(game) || G.s.staff.burnout <= WEEKEND_WORK_MAX_BURNOUT;
    const btn = incidentCard(inc)?.querySelectorAll('.incBtn')[work ? 0 : 1];
    if (!usable(btn)) return null;
    if (!click(btn)) return null;
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
      if (!click(btn)) return null;
      return `${inc.key}: ${btn.textContent.replace(/🔨.*/, '').trim()}`;
    }
    return null;
  },

  // Coffee is ×1.5 on humans for 60 s. During Kernel Panic humans are the only
  // ones working, and multipliers stack, so drink then even if tired. With the
  // Thermos, the +8 burnout is fuel, so drink whenever it's ready.
  coffee(G, enabled, game) {
    const st = G.s.staff;
    let maxBurnout = COFFEE_MAX_BURNOUT;
    if (kernelPanic(G)) maxBurnout = 90;
    if (thermosCrunch(game)) maxBurnout = 100;
    const ok = st.burnout < maxBurnout && !st.week.weekend && st.lever.party <= 0;
    const btn = staffButton(G, '#coffeeBtn');
    if (!ready('coffee', ok && !!btn)) return null;
    if (!click(btn)) return null;
    return 'coffee run';
  },

  callHammer(G) {
    const btn = staffButton(G, '#hammerBtn');
    if (!ready('callHammer', !!btn)) return null;
    if (!click(btn)) return null;
    return 'called the hammer';
  },

  // The party zeroes humans for 45 s and runs tech ×3 (×(3 + burnout/10) up
  // to ×13 with the Thermos), then resets burnout. Never during Kernel Panic
  // (tech is down, humans are all that's working). With the Thermos, wait for
  // near-full burnout. During a production boost, pull a little early so the
  // party multiplies into it.
  lever(G, enabled, game) {
    const btn = staffButton(G, '#leverBtn');
    let at = LEVER_AT_BURNOUT;
    if (thermosCrunch(game)) at = THERMOS_LEVER_AT;
    if (productionBoost(G) >= 2) at -= 15;
    const ok = !!btn && !kernelPanic(G) && G.s.staff.burnout >= at;
    if (!ready('lever', ok)) return null;
    if (!click(btn)) return null;
    return `pulled the lever (burnout ${Math.round(G.s.staff.burnout)})`;
  },

  // Overlays that only need dismissing: ZABURUFF's judgment scroll, the
  // Kernel Panic blue screen, and the welcome-back card.
  popups() {
    const scroll = document.querySelector('.zsClose')?.parentElement;
    if (scroll && !scroll.classList.contains('hidden') && ready('popup:scroll', true)) {
      if (!click(scroll)) return null;
      return 'closed judgment scroll';
    }
    const bsod = document.querySelector('.bsodInner')?.parentElement;
    if (bsod && !bsod.classList.contains('hidden') && ready('popup:bsod', true)) {
      if (!pointerDown(bsod)) return null;
      return 'closed blue screen';
    }
    const back = [...document.querySelectorAll('.wcBtn[data-a="go"]')].find(b => /BACK TO BANNING/i.test(b.textContent));
    if (back && !back.closest('.hidden') && ready('popup:welcome', true)) {
      if (!click(back)) return null;
      return 'closed welcome card';
    }
    // Field Trip (CD-ROM) story: cosmetic, a full-screen overlay. Skip still
    // unlocks the music station and sets settings.mixtape, so it never returns.
    const cdSkip = document.querySelector('#cdRoom:not(.hidden) .cdSkip');
    if (cdSkip && ready('popup:cd', true)) {
      if (!click(cdSkip)) return null;
      return 'skipped field trip';
    }
    return null;
  },

  // Ship a Sequel when sequelPlan says so (src/planner.js), confirm, buy the
  // Reputation shop one crate at a time, then launch.
  sequel(G, enabled, game) {
    const p = G.s.prestige;
    const opts = sequelOptions(enabled);
    if (G.ascending) {
      const screen = document.querySelector('#ascendScreen');
      if (!screen) return null;
      // Crates carry no key; they are rendered in PRESTIGE order.
      const crates = screen.querySelectorAll('.prestigeGrid .crate');
      const [next] = crates.length === PRESTIGE.length ? prestigeBuys(p.upgrades, p.reputation, opts) : [];
      if (next) {
        const crate = crates[PRESTIGE.findIndex(x => x.key === next)];
        if (!ready('sequel:buy:' + next, true)) return null;
        if (!click(crate)) return null;
        return 'prestige: ' + next;
      }
      const launch = usable(screen.querySelector('#launchSequel'));
      if (!ready('sequel:launch', !!launch)) return null;
      if (!click(launch)) return null;
      return 'launched sequel ' + p.sequels;
    }
    const confirm = [...document.querySelectorAll('#modal:not(.hidden) .buttons button')]
      .find(b => b.textContent === 'Ship it!');
    if (confirm) {
      if (!ready('sequel:confirm', true)) return null;
      if (!click(confirm)) return null;
      return 'shipped a sequel';
    }
    const plan = sequelStatus(G, enabled);
    const btn = usable('#sequelButton');
    if (!ready('sequel:ship', !!btn && plan.ship)) return null;
    if (!click(btn)) return null;
    return `ship? +${plan.pending} ⭐, ×${plan.multNow.toFixed(2)} → ×${plan.multAfter.toFixed(2)}`;
  },

  coinLock(G) {
    const meta = G.s.meta && G.s.meta.cur;
    const btn = staffButton(G, '#coinBtn');
    if (!ready('coin', !!btn && (meta === 'duping' || meta === 'economy'))) return null;
    if (!click(btn)) return null;
    return 'coin-lock';
  },

  audit(G, enabled) {
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
          if (!click(clear)) return null;
          return 'audit: cleared one';
        }
      }
      const submit = usable('.auSubmit');
      if (!ready('audit-submit', !!submit)) return null;
      if (!click(submit)) return null;
      return 'audit submitted';
    }
    const btn = usable('#auditBtn');
    const pile = truth.pile;
    const nearLaunch = G.s.waveMeter >= AUDIT_AT_METER * effectiveLaunchAt(G, enabled);
    if (!ready('audit-start', !!btn && nearLaunch && !(pile && pile.audited))) return null;
    if (!click(btn)) return null;
    return 'audit started';
  },

  report(G) {
    const ratio = G.s.reality / Math.max(1, G.s.perception);
    const btn = usable('#repBtn');
    if (!ready('report', !!btn && ratio < CLEAN_REPORT_RATIO)) return null;
    if (!click(btn)) return null;
    return 'transparency report';
  },

  // Launch at WAVE_LAUNCH_AT (or 100% during a boost). Audit first only when
  // an audit is possible soon; early game (no Moderator) launches right away.
  banWaves(G, enabled) {
    const truth = G.s.truth;
    const pile = truth.pile;
    const btn = usable('#waveBtn');
    // During a ×2+ boost, launch at 100% regardless: the wave multiplies into it.
    const boost = productionBoost(G);
    const charged = !!btn && G.s.waveMeter >= effectiveLaunchAt(G, enabled);
    const auditOpen = !!(truth.audit && truth.audit.cases);
    const auditSoon = auditOpen || (enabled.audit && G.s.buildings.moderator.amount > 0 &&
      !(pile && pile.audited) && truth.auditCd / TICKS_PER_SEC <= AUDIT_WAIT_SECONDS);
    // The wave's ×3+ multiplies into an active boost, so don't wait for the
    // audit then, unless one is already open or the pile is dirty enough
    // that an unaudited wave would be tier 2+ (early in a run, after a sequel).
    const dirty = (projectedHeat(G, { ...enabled, audit: false }) ?? 0) >= SKIP_AUDIT_MAX_HEAT;
    const waitForAudit = auditOpen || (auditSoon && (boost < 2 || dirty));
    if (!ready('wave', charged && !waitForAudit, boost >= 2 ? FAST_REACTION_MS : REACTION_MS)) return null;
    if (!click(btn)) return null;
    return boost >= 2 ? `launched ban wave into a ×${boost.toFixed(1)} boost` : 'launched ban wave';
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
      if (!click(logs[d.answer])) return null;
      return 'dupe: picked log line';
    }
    // The COIN-LOCK card counts as done while the ability is active.
    const card = [...room.querySelectorAll('.drCard')].find(c => c.querySelector('b')?.textContent === DUPE_LABELS[step]);
    if (!usable(card) || !ready('dupe:' + step, true, FAST_REACTION_MS)) return null;
    if (!click(card)) return null;
    return 'dupe: ' + step;
  },
};

// Banhammer clicker, humanized. The game accepts one click per tick and at
// most 20 per second, and flags more than 15 in a second as an auto-clicker.
// Every click is a recorded input, and /api/ping reports total clicks and
// run seconds, so the long-run rate should look like a person: bursts of
// 4-9 clicks/s with irregular gaps, short pauses, and occasional breaks.
// During boosts (click multipliers, or big production multipliers when clicks
// scale with production) it clicks frantically, like a person would.
// Anti anti-cheat off: a steady 14/s, just under the game's >15/s flag.
const HAMMER_CPS = 4; // human-mode long-run average
const STEADY_CPS = 14;
const HAMMER_MIN_SHARE = 0.01; // clicks must add at least 1% of passive income
const MAX_CLICKS_PER_SEC = 13;
const BURST_CPS = [4, 9];
const BOOST_CPS = [10, 13];
const BURST_SECONDS = [6, 40];
const PAUSE_SECONDS = [1.5, 12];
const BREAK_CHANCE = 0.08; // per pause: a 1-4 minute break instead
const BREAK_SECONDS = [60, 240];

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);

// Long-run clicks/s for the current mode; values click upgrades in the planner.
export function hammerCps() {
  if (humanMode()) return HAMMER_CPS;
  return STEADY_CPS;
}

// Log-normal gap around the target rate: mostly near it, sometimes long.
function gapMs(cps) {
  const z = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return Math.max(40, (1000 / cps) * Math.exp(0.35 * z - 0.06));
}

export function startHammer(game, getSettings) {
  const recent = [];
  let phaseEnd = 0;
  let clicking = false;
  let cps = 0;
  const loop = () => {
    const settings = getSettings();
    const G = game.G;
    const now = performance.now();
    const boosted = !G.ascending && clickBoost(G) >= 2;
    let delay = 250;
    const active = settings.auto && settings.ops.hammer && hammerWorthwhile(G, boosted);
    if (active && !humanMode()) {
      while (recent.length && now - recent[0] > 1000) recent.shift();
      if (recent.length < STEADY_CPS) {
        clickHammer();
        recent.push(now);
      }
      delay = 1000 / STEADY_CPS;
    } else if (active) {
      if (boosted) {
        // Drop any pause: a person sees ×777 and starts mashing.
        clicking = true;
        cps = rand(BOOST_CPS);
        phaseEnd = now + 1000;
      } else if (now >= phaseEnd) {
        clicking = !clicking;
        if (clicking) {
          cps = rand(BURST_CPS);
          phaseEnd = now + rand(BURST_SECONDS) * 1000;
        } else {
          const brk = Math.random() < BREAK_CHANCE;
          phaseEnd = now + rand(brk ? BREAK_SECONDS : PAUSE_SECONDS) * 1000;
        }
      }
      if (clicking) {
        while (recent.length && now - recent[0] > 1000) recent.shift();
        if (recent.length < MAX_CLICKS_PER_SEC) {
          clickHammer();
          recent.push(now);
        }
        delay = gapMs(cps);
      }
    }
    setTimeout(loop, delay);
  };
  loop();
}

// How much more a click is worth right now than without buffs: click
// multipliers directly, and production multipliers through the mouse
// upgrades' "+1% of bans/sec per click" (only if that share of a click
// dominates). Kernel Panic, golden ×7, strike ×4, speedhack ×3 all count.
// Weird events where clicking is the whole point:
//   honeypot (30 s): each click is a sale paying clickPower×3 + 1 s of production
//   streamerMode (45 s): hype multiplies clicks up to ×21 and drains when idle
//   lagSwitch (12 s): clicks are queued and paid out with 50% interest
const CLICK_EVENTS = new Set(['honeypot', 'streamerMode', 'lagSwitch']);

export function clickBoost(G) {
  if (G.s.weird && CLICK_EVENTS.has(G.s.weird.key)) return Infinity;
  let click = 1;
  let bps = 1;
  for (const b of G.s.buffs) {
    if (b.bad) continue;
    if (b.multClick > 1) click *= b.multClick;
    if (b.multBps > 1) bps *= b.multBps;
  }
  const mouse = [...G.s.upgradesBought].filter(id => id.startsWith('mouse:')).length;
  const bpsPart = G.bps > 0 ? (G.bps * 0.01 * mouse) / Math.max(1e-9, G.clickPower) : 0;
  return click * (1 + bpsPart * (bps - 1));
}

function hammerWorthwhile(G, boosted) {
  if (G.ascending) return false;
  if (boosted) return true;
  const cur = G.s.priority && G.s.priority.cur;
  if (cur && !cur.verdict && cur.hits < cur.need) return true;
  return G.clickPower * hammerCps() >= HAMMER_MIN_SHARE * G.bps;
}

// Total production multiplier from active good buffs (what a wave, coffee
// run, or Lever party would multiply into).
export function productionBoost(G) {
  let m = 1;
  for (const b of G.s.buffs) if (!b.bad && b.multBps > 1) m *= b.multBps;
  return m;
}

function clickHammer() {
  const el = document.querySelector('#hammerHit');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = r.left + r.width * (0.35 + Math.random() * 0.3);
  const y = r.top + r.height * (0.35 + Math.random() * 0.3);
  pointerDown(el, x, y);
}

// Bans to keep unspent so the next audit can be paid. Read from code: an
// audit costs 20 s of raw production (at least 25 bans/s), halved by the SQL
// tool. Without this reserve the auto-buyer spends the bank to zero early in a
// run, the audit never fires, and projectedHeat (which counts on it) lets the
// notch run loose: a SCANDAL wave right after a sequel launch.
export function auditReserve(G, enabled) {
  if (!enabled.audit || G.s.buildings.moderator.amount <= 0) return 0;
  if (G.s.truth.pile && G.s.truth.pile.audited) return 0;
  let cost = Math.max(G.rawBps * 20, 25 * 20);
  if (G.s.upgradesBought.has('tool:sql')) cost *= 0.5;
  return Math.ceil(cost);
}

// Hidden experiment flags: ops.sequelGain (ship ratio), ops.sequelSpendAll.
// ×6 only holds while golden picks work: if they turn themselves off
// (mismatches, e.g. the game changed its RNG), ship at ×2 again.
export function shipGain(enabled) {
  if (enabled.sequelGain) return enabled.sequelGain;
  return enabled.goldenPick && goldenPickState.on ? SHIP_GAIN_PICKS : SHIP_GAIN;
}
function sequelOptions(enabled) {
  return { gain: shipGain(enabled), spendAll: !!enabled.sequelSpendAll };
}

export function sequelStatus(G, enabled) {
  const p = G.s.prestige;
  return sequelPlan({ level: p.level, reputation: p.reputation, owned: p.upgrades, bansAllTime: G.s.bansAllTime },
    sequelOptions(enabled));
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

// Golden report look-ahead (panel toggle ops.goldenPick, off by default):
// a detectability choice like Anti anti-cheat. Click when the
// predicted effect (predictGolden in src/game.js) ranks in GOLD_RANK's top
// GOLDEN_TAKE_RANK + 1, or in the report's last 2 s anything but the two bad
// ones (a report may expire instead; that costs nothing). The RNG moves on
// most ticks, so each 400 ms poll is a fresh pick. Sim ceiling (best of 10
// picks): fresh run to the cap 43.7 -> 12.6 game hours. This look-ahead
// (seeds 7-13): 39.3 -> 12.2 game hours, faster on 7 of 7, 0 mismatches.
// With the meltdown chain below: 11.84 -> 8.57, faster on 6 of 7, 1 tie.
const GOLDEN_TAKE_RANK = 2; // meltdown, botFarmRaid, ringTakedown
const GOLDEN_LAST_CHANCE_TICKS = 2 * TICKS_PER_SEC;
const GOLDEN_NEVER = new Set(['exploitLeak', 'cheatUpdate']);
const goldenNoticed = new WeakSet();
// Meltdown chain (part of golden picks). During a meltdown
// (×666 for 13 s with Long Buffs) bots pay 60 s × worth of the buffed
// production and a Report Chain's cap becomes half the bank (read from
// code, build ClLVmN6W), so a second golden is worth far more then:
//   - two reports on screen: click only a meltdown first, hold the other;
//   - during a meltdown: click only a bot storm or a Report Chain;
//   - with the Mustache Bin (an evader finished = a new golden report):
//     keep one evader at 1 hp and finish it during the next meltdown.
const CHAIN_DURING = new Set(['botFarmRaid', 'ringTakedown']);
const CHAIN_MIN_TICKS = 3 * TICKS_PER_SEC; // a storm needs time to spawn bots
function meltdownLeft(G) {
  const b = G.s.buffs.find(x => x.key === 'meltdown');
  return b && b.time >= CHAIN_MIN_TICKS ? b.time : 0;
}
function goldenTake(G, effect) {
  if (meltdownLeft(G) > 0) return CHAIN_DURING.has(effect);
  const reports = G.shimmers.filter(x => x.type === 'golden' && x.chain === 0).length;
  if (reports >= 2) return effect === 'meltdown';
  return GOLD_RANK.indexOf(effect) <= GOLDEN_TAKE_RANK;
}
function evaderTarget(G, enabled, game) {
  const all = G.s.evaders;
  if (!enabled.goldenPick || !goldenPickState.on || !hasRelic(game, 'mustacheBin') || meltdownLeft(G) > 0) return all[0];
  const held = all.filter(e => e.hp === 1);
  return all.find(e => e.hp > 1) ?? (held.length > 1 ? held[1] : undefined);
}
// Self-check: each click's prediction against the effect the game applied.
// A changed build, or a click queued behind a leaderboard check-in (applied
// after the server's reseed), shows up as mismatches; 3 in the last 20
// turn the look-ahead off for the session.
const goldenPickState = { on: true, pending: null, results: [], picks: 0, mismatches: 0 };
// For the panel and the stats export.
export function goldenPickStatus(G) {
  const { on, picks, mismatches, results } = goldenPickState;
  return { on, picks, mismatches, recentMisses: results.filter(ok => !ok).length, recent: results.length,
    anomaly: G.s.upgradesBought.has('tool:anomaly') };
}
function checkGoldenPick(G) {
  const p = goldenPickState.pending;
  if (!p || G.s.eventsClicked <= p.clicked) return null;
  goldenPickState.pending = null;
  const r = goldenPickState.results;
  r.push(G.s.lastEffect === p.effect);
  if (G.s.lastEffect !== p.effect) goldenPickState.mismatches++;
  if (r.length > 20) r.shift();
  if (r.filter(ok => !ok).length < 3) return G.s.lastEffect === p.effect ? null : `golden mismatch ${p.effect} got ${G.s.lastEffect}`;
  goldenPickState.on = false;
  return 'golden prediction off (3 mismatches)';
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
  // Between games only the sequel routine (shop, launch) has anything to do.
  if (G.ascending) {
    if (!enabled.sequel) return null;
    try {
      return ROUTINES.sequel(G, enabled, game);
    } catch (e) {
      return `sequel error: ${e.message}`;
    }
  }
  for (const { key } of OPS) {
    // Experiment flags share OPS but have no routine of their own.
    if (!enabled[key] || !ROUTINES[key]) continue;
    try {
      const did = ROUTINES[key](G, enabled, game);
      if (did) return did;
    } catch (e) {
      return `${key} error: ${e.message}`;
    }
  }
  return null;
}
