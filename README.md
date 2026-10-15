# OnlyBans Glider

Tampermonkey overlay for https://onlybans.wtf: plans the most efficient purchases and, with AUTO on, plays the game's mechanics through its own UI.

## Install

1. Install Tampermonkey. In Chrome, also enable "Allow User Scripts" on the extension's details page.
2. `npm run build`
3. Tampermonkey dashboard → Utilities → import `dist/onlybans-glider.user.js` (or paste it into a new script).
4. Reload onlybans.wtf. The panel appears top-left. Drag it by its header.

## Using it

- **Next**: the purchase to make now. A recommended building also gets a green outline in the store.
- **Horizon**: how far ahead to plan. Purchases that can't be afforded and paid back within roughly two horizons are skipped. Short horizon = active play. Long horizon = save up while idle.
- **Clicks/s**: how fast you click the hammer. This makes click upgrades count.
- **Depth**: how many purchases ahead to search (3 is fast; 5 can take ~1s per replan).
- **AUTO** (header button, red when on): buys the plan's buy-now list by clicking the store's own elements, so purchases go through the game's input recorder. Up to 15 clicks per 2s cycle, at most one upgrade per cycle.
- Arms race upgrades (escalation, truce, detente) are listed but never planned.
- Temporary buffs are ignored, so advice holds steady during golden events.

## How it works

The overlay re-imports the game's own ES module, so it reads the live building and upgrade tables plus the game's logic API (`calculateGains`, `buildingPrice`, `upgradePrice`). To value a purchase, it applies the purchase to the live state, runs the game's `calculateGains`, and reads the result. Then it restores the state, all in one synchronous block. It never clicks, buys, or sends anything. The leaderboard replays real inputs only, so the overlay cannot affect it.

The planner (`src/planner.js`) tests short purchase sequences and picks the one that maximizes `bank(H) + rate(H) * H`.

## When the game updates

```
bash scripts/fetch.sh        # did the bundle change?
node scripts/probe.mjs       # can we still bind to logic API / tables?
npm run e2e                  # full live check in headless Chromium
```

The ⟳ button rebinds without reloading. A game update still needs a page reload to load the new bundle.

## Dev

- `npm test`: planner unit tests
- `npm run e2e`: build, then run against the live site (throwaway browser, seeded with the game's own console cheats)
