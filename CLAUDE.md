# OnlyBans Glider

Tampermonkey userscript for https://onlybans.wtf (a Cookie Clicker style idle game about anti-cheat). It plans purchases and, with AUTO on, plays the game's mechanics by clicking the game's own UI.

Context: a hackathon challenge where we play against the OnlyBans Trust & Safety team and its server-verified leaderboard. Automation that goes through the game's recorded input path is the explicit goal.

## Layout

- `src/header.txt`: userscript metadata. Bump `@version` on every build the user installs.
- `src/planner.js`: pure planner (unit tested). Buy-now phase (incl. working toward bundles), then depth-limited lookahead. Objective `bank(H) + rate(H) * H`.
- `src/game.js`: binds to the live game module, what-if sandbox (`withSandbox`, incl. bundle candidates found by probing upgrade unlock conditions), golden/wave income shares, `buffCost`, `utilityUpgrades`.
- `src/ops.js`: all non-purchase automation (`OPS` list = toggles + priority order, `ROUTINES`), humanized boost-aware hammer clicker (`startHammer`, `clickBoost`, `productionBoost`).
- `src/auto.js`: auto-buyer (clicks store rows / upgrade crates), arms race picks, utility upgrades.
- `src/stats.js`: telemetry in IndexedDB (wave verdicts with pre-launch conditions, minute snapshots, action counts). Copy JSON button exports it.
- `src/overlay.js`: panel UI, settings (localStorage key `onlybans-glider-settings`), edge-anchored positioning.
- `src/main.js`: wiring and timers (replan ≥2 s on a 5% CPU budget, ops 400 ms, stats 1 s).
- `scripts/build.sh`: concatenates src (strips `export`) into `dist/onlybans-glider.user.js`, stamping `ANALYZED_BUILD`. File order matters only for top-level consts used at load.
- `scripts/fetch.sh`: downloads the current game bundle to `research/site/` (gitignored) and reports changes. `scripts/bundle-diff.py OLD NEW`: diff two builds despite re-minified names. `scripts/feature-scan.py`: compare the bundle's feature keys to `FEATURES.md`.
- `scripts/sim/`: offline simulator (see below). `scripts/probe.mjs`, `scripts/e2e*.mjs`: live headless tests (blocked, see Testing).

Commands: `npm run build`, `npm test`, `bash scripts/fetch.sh`, `npm run experiments -- 120 7,8,9`, `npm run progress`.

## How binding works (survives game updates)

- The game is a Vite ES module (`/assets/index-<hash>.js`). Re-importing the same URL from the page returns the live instance.
- Exports are minified letters that change per build, so find them by content: logic API (object with `calculateGains` and `G`), buildings (array with `baseCost`/`baseBps`), upgrades (array with `unlock()` and `kind`), dupe minigame state (object with `answer`, `deck`, `done`).
- `window.OnlyBans.G` is the live game object `r`; save state is `G.s`. 30 ticks per second.
- The logic API has stable unminified names: `buildingPrice`, `upgradePrice`, `calculateGains`, `buyBuilding`, `ctx`, etc.

## Leaderboard / replay facts (from client code)

- Every player action goes through `X([code, ...args])`, which appends `[tick, code, ...args]` to the input log before applying it. Batches are hashed and attested at `/api/run/attest`; `/api/lb/submit` uploads them. The server replays the log (inferred from the console message and design, server code not seen).
- Automation must act by clicking the game's DOM (or dispatching `pointerdown` where the game listens for it). Calling logic functions directly skips the recorder and breaks replay.
- Hammer clicks: max 1 per tick and 20/s; more than 15/s sets an auto-clicker flag. Ignored clicks are still logged.
- Pre-submit input log lives in localStorage with a size cap (about 3.5M chars in an older build). Never put large data in localStorage; stats use IndexedDB.
- `OnlyBans.cheat.*` sets `s.cheated`. Do not use it outside throwaway headless tests.

## Mechanics reference (state paths, rules the automation relies on)

- Action codes: see `case"x":` in the bundle's dispatcher (search `case"c":return`). 39 codes.
- Team: `s.staff.{burnout, coffee{t,cd}, lever{cd,party}, hammer{cd}, week{weekend,crunch}}`. Buttons `#coffeeBtn #leverBtn #hammerBtn #coinBtn` use `.disabled`.
- Burnout: humans lose `burnout/200` of output. Lever party resets it. Thermos relic makes the Lever scale with burnout (exploited: crunch, Lever at 95).
- Waves: `s.waveMeter`, `s.truth.{notch, cred, pile{inn,audited}, review{f,heat,tier,inn}, region{ans}, auditCd, audit{cases[].g}}`. Heat `100*inn*f^1.5*(1.3-0.6*cred/100)` times a 0.7 to 1.3 roll; tiers at 5/15/35/70 (CLEAN, APPEALS, TRENDING, FAMOUS FP, SCANDAL).
- Answers readable from state: audit cases (`g`), priority case (`s.priority.cur.guilty`), tickets (`incident.ticket.answer`), region (`truth.region.ans`), dupe log line (`dupe.answer`), devs react (`weird.x[1]`), cheat launch end tick (`weird.x[1]`).
- Incident choice table is `lf`/`ai` in the bundle (`choice.costSeconds`, `apply`). Expiry picks option 1 for free.
- Dupe gold stops growing once `hotfix` is done.
- Golden reports average ~100% of production when all are clicked (455 s EV per report, one per ~447 s; red reports ~721 s, so they are clicked too). The planner's `rate()` multiplies by `1 + goldenShare + waveShare` (`src/game.js`) so event upgrades and the Dashboard get real values. Outcome mix and EVs are simulation estimates, not measured.
- Arms race decision: escalate all three, skip Détente (estimated +46-56% vs +44% with Détente, because red reports offset the perception cost), truce only when perception >= 80. Arms stage getter is `armsRace.stage` (0 during truce/détente).

## Offline simulator (preferred way to test automation)

- `scripts/sim/harness.mjs` runs the real game bundle from `research/site/` in Node under jsdom with a fake clock (`@sinonjs/fake-timers`), network stubbed, seeded `Math.random`. One process = one game. The userscript from `dist/` is eval'd into the same global scope, so it binds exactly as in the browser.
- `node scripts/sim/run.mjs --minutes 60 --seed 1 [--set ops.notch=false] [--relic thermos]` prints progress and a JSON summary. ~1 game hour in ~5 min wall.
- `node scripts/sim/experiments.mjs MINUTES SEEDS` runs the `CONFIGS` in parallel and prints a table; per-run logs in `research/sim-runs/` (gitignored). Live progress: `research/sim-runs/progress.json`, shown by `npm run progress` (the user can run `! npm run progress`).
- Needs `research/site/index.html` and the bundle (`scripts/fetch.sh`, then curl index.html). jsdom has no layout, so every element reports a fixed 400x700 box.
- No network, so it is not subject to the live-site test block. Verify policy changes here before shipping.
- Before trusting any batch, do a short sanity run and check the `actions` field of the summary: no `... error` entries, waves happening, no single routine with thousands of actions. Two bugs (an experiment flag with no routine starving the ops loop; the pizza "done" button clicked ~3000 times) were caught this way only after a batch had been wasted.
- Compare configs on `score` (mean log10 total bans over the last 30 game-minutes) across several seeds; single endpoints swing 3× and seed variance is large. Results so far (2 h, seeds 7-9): bundles +28%, Thermos crunch +32%, notch controller +8% (one seed), coffee threshold 40 vs 65 no difference (coffee is cooldown-limited).
- Strategy choices are decided by simulation and hard-coded, never left to the user as panel checkboxes. Panel toggles are only for whole mechanics (on/off). A/B variants live as hidden flags (`experiment: true` in `OPS`, or a settings key like `bundles`) set via `--set` in the simulator, then removed or fixed once the result is in.

## Testing

- Before handing any build to the user, run `npm run release` (build, unit tests, layout check). `scripts/check-layout.mjs` runs the local game copy offline in headless Chromium, seeds large numbers, opens every section, and fails on any horizontal overflow in the panel. Horizontal scrollbars are never acceptable; vertical scrolling is fine. Fix overflow at the cause (column sizing, wrapping), never by hiding it with `overflow-x: hidden`.

- Unit tests cover only the planner (`test/planner.test.js`).
- Live headless runs against onlybans.wtf (`scripts/e2e*.mjs`) were blocked mid-session by the Claude Code auto-mode classifier. Do not work around it; ask the user to approve those commands. Most automation after v0.2 has only been verified by the user in their browser.
- The user tests by re-importing `dist/onlybans-glider.user.js` in Tampermonkey (Chrome needs "Allow User Scripts"; check Tampermonkey itself is Enabled).

## Workflow notes

- Do not use Claude Code memory notes for this project. They are local to one machine and do not carry across machines. Put every durable fact, decision, and queue item in files inside this repository (this file, `FEATURES.md`, etc.).

- `FEATURES.md` is the feature register (one row per game key, status, one-sentence strategy). After fetching a new build, run `python3 -I scripts/feature-scan.py`: it lists keys the register lacks (new features) or has but the bundle dropped. Keep the register in sync with every behavior change.
- Run `bash scripts/fetch.sh` before every bundle analysis; the game ships often. The bundle filename hash (`index-<hash>.js`) is the only version marker (the save `version` field is a schema number). `ANALYZED_BUILD` (tracked) names the build the automation rules were last checked against; it's stamped into the userscript and the panel warns when the live build differs. Update it after re-checking a new build.
- When the game updates: `bash scripts/fetch.sh`, then grep the new bundle in `research/site/` with `python3 -I - <<'EOF' ... EOF` (do not cat it; it is ~680KB of minified JS). `node -e`/`python -c` and commands containing backslash sequences can be blocked by the project-boundary hook; use heredocs or the Edit tool.
- Write scratch files under the project (e.g. `research/tmp/`, gitignored), not the system scratchpad; the boundary hook blocks paths outside the project.
- Every number in a user-facing claim should be labeled as read from code vs inferred. Do not invent trigger conditions (the pizza party trigger was once misstated).

## Next up (queue)

1. Horizon × depth sweep in the simulator (e.g. depth 1/2/3 × horizon 5m/15m/1h, 2+ seeds; also watch planner ms), then hard-code the winners and remove Horizon, Depth, and Clicks/s from the panel (Clicks/s is already obsolete: the hammer sets the click rate). Depth >3 lags the real game (work grows ~5× per level).
2. User should install the latest `dist/` build (v0.15.0) and send a Stats → Copy JSON after ~20 waves to confirm the audit-timing and notch fixes in real play.
3. Commit: everything since `34a7261` is uncommitted (only commit when the user asks).
4. Consider a simulator scenario starting from a late-game state (e.g. import the user's save) so late-game policies get tested; fresh-game sims only reach ~1e22 bans in 2 h.

## Open items

- Prestige (Ship a Sequel), seed funding, and prestige upgrades are left to the user.
- Tally Counter relic: nothing to exploit (it removes the verdict roll after 10 right audit answers; waves can't be cancelled, and audits are already perfect).
- The game's telemetry (`/api/ping`, since build BfICFFT7) reports a persistent `click2ban-id` plus totals (clicks, run seconds, golden clicked, waves). The hammer clicker is humanized (bursts, pauses, breaks; ~4 clicks/s average) for that reason.
