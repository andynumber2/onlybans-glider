# OnlyBans Glider

Tampermonkey userscript for https://onlybans.wtf (a Cookie Clicker style idle game about anti-cheat). It plans purchases and, with AUTO on, plays the game's mechanics by clicking the game's own UI.

Context: a hackathon challenge where we play against the OnlyBans Trust & Safety team and its server-verified leaderboard. Automation that goes through the game's recorded input path is the explicit goal.

## Layout

- `src/header.txt`: userscript metadata. Bump `@version` on every build the user installs.
- `src/planner.js`: pure planner (unit tested). Buy-now phase, then depth-limited lookahead. Objective `bank(H) + rate(H) * H`.
- `src/game.js`: binds to the live game module, what-if sandbox (`withSandbox`), `buffCost`.
- `src/ops.js`: all non-purchase automation (`OPS` list = toggles + priority order, `ROUTINES`, hammer clicker).
- `src/auto.js`: auto-buyer (clicks store rows / upgrade crates).
- `src/stats.js`: telemetry in IndexedDB (wave verdicts, minute snapshots, action counts). Copy JSON button exports it.
- `src/overlay.js`: panel UI, settings (localStorage key `onlybans-glider-settings`), edge-anchored positioning.
- `src/main.js`: wiring and timers (replan 2s, ops 400ms, stats 1s, hammer ~8/s).
- `scripts/build.sh`: concatenates src (strips `export`) into `dist/onlybans-glider.user.js`. File order matters only for top-level consts used at load.
- `scripts/fetch.sh`: downloads the current game bundle to `research/site/` (gitignored) and reports changes.
- `scripts/probe.mjs`: headless check that bindings still resolve. `scripts/e2e*.mjs`: live headless tests.

Commands: `npm run build`, `npm test`, `bash scripts/fetch.sh`, `node scripts/probe.mjs`.

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
- Burnout: humans lose `burnout/200` of output. Lever party resets it. Thermos relic makes the Lever scale with burnout (not yet exploited).
- Waves: `s.waveMeter`, `s.truth.{notch, cred, pile{inn,audited}, review{f,heat,tier,inn}, region{ans}, auditCd, audit{cases[].g}}`. Heat `100*inn*f^1.5*(1.3-0.6*cred/100)` times a 0.7 to 1.3 roll; tiers at 5/15/35/70 (CLEAN, APPEALS, TRENDING, FAMOUS FP, SCANDAL).
- Answers readable from state: audit cases (`g`), priority case (`s.priority.cur.guilty`), tickets (`incident.ticket.answer`), region (`truth.region.ans`), dupe log line (`dupe.answer`), devs react (`weird.x[1]`), cheat launch end tick (`weird.x[1]`).
- Incident choice table is `lf`/`ai` in the bundle (`choice.costSeconds`, `apply`). Expiry picks option 1 for free.
- Dupe gold stops growing once `hotfix` is done.

## Testing

- Unit tests cover only the planner (`test/planner.test.js`).
- Live headless runs against onlybans.wtf (`scripts/e2e*.mjs`) were blocked mid-session by the Claude Code auto-mode classifier. Do not work around it; ask the user to approve those commands. Most automation after v0.2 has only been verified by the user in their browser.
- The user tests by re-importing `dist/onlybans-glider.user.js` in Tampermonkey (Chrome needs "Allow User Scripts"; check Tampermonkey itself is Enabled).

## Workflow notes

- When the game updates: `bash scripts/fetch.sh`, then grep the new bundle in `research/site/` with `python3 -I - <<'EOF' ... EOF` (do not cat it; it is ~680KB of minified JS). `node -e`/`python -c` and commands containing backslash sequences can be blocked by the project-boundary hook; use heredocs or the Edit tool.
- Write scratch files under the project (e.g. `research/tmp/`, gitignored), not the system scratchpad; the boundary hook blocks paths outside the project.
- Every number in a user-facing claim should be labeled as read from code vs inferred. Do not invent trigger conditions (the pizza party trigger was once misstated).

## Open items

- Thermos-aware burnout strategy (crunch on purpose, pull the Lever near 100).
- Tune notch thresholds (`NOTCH_HEAT_HIGH/LOW` in `src/ops.js`) from exported stats.
- Prestige (Ship a Sequel), seed funding, and prestige upgrades are left to the user.
- Hammer click pattern is uniform-jittered at ~8/s; the user deferred humanizing it.
