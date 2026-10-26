# Feature register

Every game feature, keyed by the game's own identifier, with how Glider handles it. Check a new game build with `python3 -I scripts/feature-scan.py`: it lists keys in the bundle that aren't in this file (new features) and keys here the bundle no longer has (removed).

Status: ✅ automated · 🟡 partial · ➖ nothing to do / left to the user on purpose · ❓ not analyzed

Last checked against: `index-DjdI4Fjz.js`

## Actions (input codes)

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `action:c` | Hammer click | ✅ | Humanized bursts (~4/s average), frantic up to 13/s during boosts and click events. |
| `action:b` | Buy building | ✅ | Planner: payback within ~2× horizon, plus bundles to the next unlock threshold (simulated +28%). |
| `action:s` | Sell building | ➖ | Refunds 25%; never worth it. |
| `action:u` | Buy upgrade | ✅ | Planner valuation; zero-production utilities at ≤10 min of income. |
| `action:g` | Click shimmer | ✅ | Click everything, including red reports (higher EV). |
| `action:e` | Hit evader | ✅ | Click its computed canvas position until popped. |
| `action:i` | Incident choice | ✅ | Per-incident policy (see Incidents). |
| `action:r` | Repair hit | ✅ | Press the lit button. |
| `action:w` | Launch ban wave | ✅ | Hold to 267% (×6; simulated ~4.7× bans vs 100%), audit just before; at 100% during a ×2+ boost. |
| `action:x` | (no-op) | ➖ | Returns false in the dispatcher. |
| `action:y` | (no-op) | ➖ | Returns false in the dispatcher. |
| `action:k` | Dupe response card | ✅ | Page, identify (answer from state), hotfix first, then the rest. |
| `action:m` | Coin-Lock | ✅ | Only during duping/economy meta. |
| `action:v` | Pull the Lever | ✅ | Whenever ready (cooldown-limited); with the Thermos at burnout 95 (80 during a boost); never during Kernel Panic. |
| `action:a` | Ship a Sequel | ✅ | Ship when production after the sequel (incl. shop buys) is ≥2× the current (`sequelPlan`), ≥6× with Golden picks (fresh to cap: 9.1 h at ×2, 6.5 h at ×5-×8); 24 h late-game sims: ×2 beat ×4 on 9 of 9 seeds (×4 stopped shipping once income turned linear). |
| `action:p` | Prestige upgrade | ✅ | Review tiers first; other items only if they leave enough for the next tier or cost ≤1% of it. |
| `action:l` | Launch sequel | ✅ | Right after the shop buys. |
| `action:o` | Offline catch-up | ➖ | Game-internal on load. |
| `action:n` | Studio name joke | ➖ | Achievement only. |
| `action:z` | Attest nonce | ➖ | Leaderboard plumbing. |
| `action:q` | Weird event choice | ✅ | Per-event policy (see Weird events). |
| `action:d` | Strictness notch | ✅ | One step per landed verdict: stricter if heat >10 or tier ≥2, looser if heat <4. |
| `action:j` | Start audit | ✅ | At ≥85% meter, not yet audited. |
| `action:J` | Submit audit | ✅ | Clear the cases state marks innocent. |
| `action:R` | Wrong-region flag | ✅ | Click the answer from state. |
| `action:S` | Seed funding | ➖ | One-time run-start choice; left to the user. |
| `action:Q` | Clip it | ✅ | Click when the clip button lights. |
| `action:L` | Streamer minigame | ✅ | See weird:banSpeedrun, devsReact, cheatLaunch. |
| `action:K` | Coffee run | ✅ | Burnout <40, not weekend/party; up to 90 during Kernel Panic. |
| `action:H` | Call the Hammer | ✅ | Whenever off cooldown. |
| `action:E` | Relic offer pick | ✅ | Ranked list; leave in bag if nothing ranked. |
| `action:Z` | ZABURUFF judgment | ✅ | Click when he appears. |
| `action:B` | BENZON bug report | ✅ | Click when he appears. |
| `action:Y` | Crew legend | ✅ | Click when one appears. |
| `action:U` | Squash crawling bug | ✅ | Click each bug during bug bounty chaos. |
| `action:P` | Pizza party | ✅ | Serve if possible, else cut, else open soda; feed all 36. Since build F1HYSyWE it can recur once per run (after a sequel). |
| `action:f` | Transparency report | ✅ | Only when the verdict will be clean (reality/perception <0.35). |
| `action:h` | Priority case verdict | ✅ | Answer from state; wait for airtight evidence if >2.5 s left. |
| `action:t` | Ticket answer | ✅ | Answer from state. |

## Incidents

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `incident:bugBountyChaos` | Bug bounty chaos | ✅ | Squash crawling bugs to shorten the ×0.5. |
| `incident:bugIntroduced` | Bug introduced | ✅ | Exploiter shimmers get clicked by the shimmer routine. |
| `incident:cheatDevSued` | Cheat dev sued | ➖ | Passive bonus. |
| `incident:cheatRelease` | Cheat release | ✅ | Click the cheat sample shimmer to lift the ×0.7. |
| `incident:cheatSeller` | Cheat seller | ✅ | Send the C&D: 120 s fee for a 50-80% shot at +400 s. |
| `incident:cheatSellerLawsuit` | Lawsuit offer | ✅ | File: 300 s fee for +1500 s and Perception −8. |
| `incident:credentialStuffing` | Credential stuffing | ➖ | Passive penalty. |
| `incident:ddos` | DDoS | ✅ | Repair (5 lit-button hits) to end the production stop. |
| `incident:dupeOutbreak` | Dupe outbreak | ✅ | Handled by the dupe card routine. |
| `incident:employeeQuits` | Key person quits | ✅ | Pay if lost output over the stoppage beats the fee, else wait. |
| `incident:excelLimit` | Excel limit | ✅ | Migrate: permanent ×1.5 Log Analysts. |
| `incident:exploitGroup` | Exploit group | ✅ | Precursor to a dupe outbreak; handled there. |
| `incident:falsePositive` | False positive | ✅ | Unban and apologize (Perception −12). |
| `incident:gameLaunch` | Game launch | ➖ | Passive ×2 production. |
| `incident:heroModTool` | Hero mod tool | ➖ | Passive Moderators ×4. |
| `incident:internSql` | Intern SQL | ➖ | Passive Log Analysts ×5. |
| `incident:journalistPraise` | Journalist praise | ➖ | Passive Perception −15. |
| `incident:leadershipDoubt` | Leadership doubt | ✅ | Let it expire (free option 2). |
| `incident:redditThread` | Reddit thread | ➖ | Passive penalty. |
| `incident:reportSpam` | Report spam | ✅ | Ticket answered from state. |
| `incident:streamerAccusation` | Streamer accusation | ✅ | Publish match data (Perception −10). |
| `incident:theHammer` | The Hammer | ➖ | Passive bonus (also triggered by Call the Hammer). |
| `incident:toolBroke` | Ban tool broken | ✅ | Repair by pressing the lit button. |
| `incident:vendorLapse` | Vendor lapse | ✅ | Pay if lost output over the stoppage beats the fee, else wait. |
| `incident:viralClip` | Viral clip | ➖ | Passive bonus. |
| `incident:weekend` | Weekend | ✅ | Work if burnout ≤50; always with the Thermos. |
| `incident:wrongfulBans` | Wrongful bans | ✅ | Reinstate and apologize (Perception −6). |

## Story overlays (no game key)

- Field Trip (`#cdRoom`, build DRE2JQgr): ✅ cosmetic CD-ROM story at 100 staff, unlocks the MUSIC TO BAN TO station. Full-screen overlay, so the `popups` routine clicks Skip (skip also unlocks it; never returns).

## Weird events

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `weird:allSteve` | Everyone is Dallas Prevost | ➖ | Passive ×1.5. |
| `weird:banSpeedrun` | Ban speedrun | ✅ | Click each alt within ~0.5 s. |
| `weird:caughtLive` | Caught cheating live | ✅ | Clip it when chat spots it. |
| `weird:cheatLaunch` | Cheat launch stream | ✅ | Drop the wave 1.5 s before the pre-rolled stream end. |
| `weird:cheaterStrike` | Cheater strike | ✅ | Meet demands: ×4 for 30 s instead of ×0.1. |
| `weird:devsReact` | Devs react live | ✅ | Pick the good clip from state. |
| `weird:honeypot` | Honeypot shop | ✅ | Click frantically: each click pays 1 s of production at close. |
| `weird:kernelPanic` | Kernel Panic | ✅ | Boost: click harder, coffee, launch waves; never pull the Lever. |
| `weird:lagSwitch` | Lag switch | ✅ | Click frantically: queued with 50% interest. |
| `weird:modCoup` | Mod Council coup | ✅ | Pay 30 s to end 40 s of moderators-only. |
| `weird:retroWeek` | Throwback week | ➖ | Passive multiplier. |
| `weird:speedhack` | Speedhack | ✅ | Boost: ×3 clicks and production; click harder, launch waves. |
| `weird:streamerMode` | Streamer mode | ✅ | Click frantically: hype multiplies clicks up to ×21. |
| `weird:upsideDown` | Australian servers | ✅ | Boost: ×2 production; launch charged waves. |
| `weird:youAreBanned` | You are banned | ✅ | "I AM the anti-cheat": 60% for +600 s vs sure +180 s. |

## Relics

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `relic:gliderMonitors` | Glider dev's monitors | ✅ | Pick first: golden reports in pairs (~+100% production). |
| `relic:mustacheBin` | Fake mustache bin | ✅ | Pick: each popped evader spawns a golden report. With Golden picks, one evader is held at 1 hp and finished during a meltdown. |
| `relic:thermos` | Night-shift thermos | ✅ | Pick; then crunch (always work weekends, coffee whenever) and pull the Lever at 95 (simulated +32%). |
| `relic:ringLight` | Ring light | ✅ | Pick: live cases pay more and we never rule wrong. |
| `relic:noteJar` | Jar of pls-unban notes | ✅ | Pick: overturns bad verdicts. |
| `relic:lunchbox` | Grandma's lunchbox | ✅ | Pick only before Anonymous Tip Line (it ignores golden upgrades). |
| `relic:tally` | Auditor's tally counter | ✅ | Low pick; nothing to exploit (audits are already perfect). |
| `relic:phil` | A second Phil | ✅ | Low pick. |
| `relic:cat` | The cat | ✅ | Low pick: we never let cases expire. |
| `relic:littleBrother` | The little brother | ✅ | Low pick: we never rule wrong. |
| `relic:loadedDie` | Loaded die | ✅ | Never: disables notch control. |
| `relic:sharpie` | Redacted sharpie | ✅ | Never: we only publish clean reports, so it's just leak risk. |
| `relic:pager` | Kevin's pager | ➖ | Not offered; arrives with a quit, can't be declined. |
| `relic:thumbnail` | Shocked-face thumbnail | ❓ | Sequel boss chest only; inverts perception, which our perception logic doesn't handle. |

## Upgrade kinds

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `upgradeKind:doubler` | Click + Macro doublers | ✅ | Planner (clicks valued at ~4/s). |
| `upgradeKind:fingers` | Per-building click bonus | ✅ | Planner. |
| `upgradeKind:mouse` | +1% of production per click | ✅ | Planner; also makes production boosts click boosts. |
| `upgradeKind:tier` | Department ×2 tiers | ✅ | Planner, with bundles to the ownership threshold. |
| `upgradeKind:synergy` | Moderator synergies | ✅ | Planner, with bundles to 15 owned. |
| `upgradeKind:pair` | Department pairs | ✅ | Planner. |
| `upgradeKind:playbook` | Playbooks | ✅ | Planner (global multiplier). |
| `upgradeKind:trust` | Community Trust | ✅ | Planner once trust unlocks them. |
| `upgradeKind:event` | Golden report upgrades | ✅ | Valued via golden-report income share (×100 while Golden picks work: fresh to cap 5.8 vs 6.4 h). Panel toggle Golden picks (off by default) predicts each report's effect from `s.rng` and clicks only good rolls; with two reports up (or a Mustache Bin evader held at 1 hp) it chains a bot storm or report chain into a meltdown (sim: 39 h to 12 h to 8.6 h to the cap). |
| `upgradeKind:tool` | Log Analyst tools | ✅ | See Tools. |
| `upgradeKind:escalation` | Escalations | ✅ | Buy all three at ≤15 min of income. |
| `upgradeKind:truce` | Truce | ✅ | Only when perception ≥80. |
| `upgradeKind:detente` | Détente | ✅ | Never (red reports offset the arms stage). |

## Tools

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `tool:pivot` | Pivot tables | ✅ | Planner (Log Analysts ×3). |
| `tool:sql` | SQL | ✅ | Planner (Log Analysts ×2, cheaper audits). |
| `tool:agi` | AGI | ✅ | Planner (Log Analysts ×10, Neural Nets ×3). |
| `tool:notebook` | Jupyter notebook | ✅ | Utility rule; minor audit/dupe help. |
| `tool:dashboard` | Dashboard | ✅ | Valued via wave share (waves fill 30% faster). |
| `tool:anomaly` | Anomaly detection | ✅ | Utility rule; redundant with our golden clicking. Skipped while Golden picks is on (it pops reports after 2.5 s, taking the pick away). |
| `tool:copilot` | LLM copilot | ✅ | Utility rule; redundant with our incident handling. |
| `tool:agent` | Agentic AI | ✅ | Utility rule. It auto-launches at 200%, before our 267%, when its conditions allow (read from code); it launched about half of waves in simulation with no measurable cost vs skipping it. |

## Golden report outcomes

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `golden:banWave` | Ban wave ×7 | ✅ | Boost: launch charged waves into it. |
| `golden:bustedProvider` | Busted provider | ➖ | Instant lump. |
| `golden:caughtOnStream` | Caught on stream | ✅ | Click boost ×777: click frantically. |
| `golden:hotfix` | Hotfix | ➖ | Passive building boost. |
| `golden:ringTakedown` | Ring takedown chain | ✅ | Click each chain link (shimmer routine). |
| `golden:botFarmRaid` | Bot farm raid | ✅ | Click the bot storm (shimmer routine). |
| `golden:meltdown` | Meltdown ×666 | ✅ | Boost: launch charged waves into it. |
| `golden:cheatUpdate` | Cheat update (red) | ➖ | Accepted cost of red reports. |
| `golden:exploitLeak` | Exploit leak (red) | ➖ | Accepted cost of red reports. |

## Buildings

All are bought by the planner (single units and bundles). Listed so new departments show up in the scan.

| Key | Feature | Status | Strategy |
|---|---|---|---|
| `building:macro` | Ban Macro | ✅ | Planner. |
| `building:moderator` | Moderator | ✅ | Planner; needed for audits and synergies. |
| `building:reportButton` | Report Button | ✅ | Planner. |
| `building:gameMaster` | Game Master | ✅ | Planner; unlocks Coin-Lock. |
| `building:qaTesters` | QA Testers | ✅ | Planner. |
| `building:fraudDesk` | Fraud Desk | ✅ | Planner. |
| `building:logAnalyst` | Log Analyst | ✅ | Planner; unlocks coffee and tools. |
| `building:sigScanner` | Signature Scanner | ✅ | Planner. |
| `building:accountSecurity` | Account Security | ✅ | Planner; unlocks escalation 1. |
| `building:serverAuth` | Server Authority | ✅ | Planner. |
| `building:neuralNet` | Neural Net | ✅ | Planner; unlocks escalation 2. |
| `building:tribunal` | Tribunal | ✅ | Planner. |
| `building:legal` | Legal | ✅ | Planner; unlocks Call the Hammer, escalation 3. |
| `building:botLab` | Bot Lab | ✅ | Planner. |
| `building:economyForensics` | Economy Forensics | ✅ | Planner. |
| `building:hwidBan` | HWID Ban | ✅ | Planner. |
| `building:kernelDriver` | Kernel Driver | ✅ | Planner; enables Kernel Panic. |
| `building:trustScore` | Trust Score | ✅ | Planner. |
| `building:chatAI` | Chat AI | ✅ | Planner. |
| `building:preCrime` | Pre-Crime | ✅ | Planner. |
