// Run telemetry for tuning the automation: wave verdicts with the conditions
// at launch, periodic snapshots, and action counts.
//
// Stored in IndexedDB, not localStorage: the game keeps its save and its
// leaderboard input log in localStorage, and running that out of quota marks
// the run ineligible.

const DB_NAME = 'onlybans-glider';
const STORE = 'kv';
const DOC = 'stats';
const SNAPSHOT_MS = 60000;
const PERSIST_MS = 30000;
const MAX_SNAPSHOTS = 2880; // two days at one a minute
const MAX_WAVES = 1000;
const MAX_RECENT_ACTIONS = 300;
export const TIER_NAMES = ['CLEAN', 'APPEALS', 'TRENDING', 'FAMOUS FP', 'SCANDAL'];

// The leaderboard's last verified score, from the game's own leaderboard state
// in localStorage (key click2ban-lb, field verified.score). That value also
// holds the pending input log, so only the small field is pulled out, without
// parsing the whole thing. Null when not joined or not found.
const LB_KEY = 'click2ban-lb';
const VERIFIED_RE = /"verified":\{"score":([0-9.eE+-]+)/;

function verifiedScore() {
  try {
    const m = (localStorage.getItem(LB_KEY) ?? '').match(VERIFIED_RE);
    if (m) return Number(m[1]);
    return null;
  } catch {
    return null;
  }
}

function emptyStats() {
  return { started: Date.now(), snapshots: [], waves: [], actionCounts: {}, recentActions: [] };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

export async function createStats() {
  let data = emptyStats();
  try {
    const saved = await idb('readonly', s => s.get(DOC));
    if (saved) data = { ...emptyStats(), ...saved };
  } catch {}

  let dirty = false;
  let lastSnapshot = 0;
  let pendingWave = null;
  let preLaunch = {};

  const persist = () => {
    if (!dirty) return;
    dirty = false;
    idb('readwrite', s => s.put(data, DOC)).catch(() => {});
  };
  setInterval(persist, PERSIST_MS);
  window.addEventListener('pagehide', persist);

  function push(list, item, max) {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
    dirty = true;
  }

  return {
    action(line) {
      const kind = line.split(':')[0].replace(/\d+/g, '').trim();
      data.actionCounts[kind] = (data.actionCounts[kind] ?? 0) + 1;
      push(data.recentActions, { t: Date.now(), line }, MAX_RECENT_ACTIONS);
    },

    // Called about once a second.
    // Returns true when it took a minute snapshot (diag: loop health from main.js).
    tick(G, projectedHeat, diag = null) {
      const s = G.s;
      const t = s.truth;
      const now = Date.now();
      let snapped = false;
      if (now - lastSnapshot >= SNAPSHOT_MS) {
        lastSnapshot = now;
        snapped = true;
        push(data.snapshots, {
          t: now, T: G.T, all: s.bansAllTime, verified: verifiedScore(),
          bps: G.bps, rawBps: G.rawBps, bans: s.bans,
          perception: s.perception, reality: s.reality, cred: t.cred,
          burnout: s.staff.burnout, notch: t.notch, meter: s.waveMeter, waves: s.wavesLaunched,
          sequels: s.prestige.sequels, diag,
        }, MAX_SNAPSHOTS);
      }
      // A review exists from launch until the verdict lands. Launch resets the
      // pile, so conditions are captured on every tick before launch.
      const review = t.review;
      if (!review) {
        preLaunch = {
          notch: t.notch, cred: t.cred, meter: s.waveMeter, audited: !!(t.pile && t.pile.audited),
          innocentShare: t.pile ? t.pile.inn / Math.max(0.001, s.waveMeter) : null,
          projectedHeat, perception: s.perception, reality: s.reality,
        };
      }
      if (review && !pendingWave) {
        pendingWave = { n: s.wavesLaunched, launchedAt: now, f: review.f, ...preLaunch };
      }
      if (review && pendingWave) {
        pendingWave.tier = review.tier;
        pendingWave.heat = review.heat;
        pendingWave.innocent = review.inn;
      }
      if (!review && pendingWave) {
        pendingWave.landedAt = now;
        push(data.waves, pendingWave, MAX_WAVES);
        pendingWave = null;
      }
      return snapped;
    },

    summary() {
      const counts = TIER_NAMES.map(() => 0);
      for (const w of data.waves) if (w.tier >= 0 && w.tier < counts.length) counts[w.tier]++;
      const recent = data.snapshots.slice(-10);
      const avgBps = recent.length ? recent.reduce((a, x) => a + x.bps, 0) / recent.length : 0;
      return { waves: data.waves.length, counts, avgBps, lastWave: data.waves[data.waves.length - 1] };
    },

    // Minute snapshots, oldest first (read only).
    snapshots() {
      return data.snapshots;
    },

    exportJson() {
      return JSON.stringify(data);
    },

    reset() {
      data = emptyStats();
      pendingWave = null;
      dirty = true;
      persist();
    },
  };
}
