# OnlyBans: client can predict and choose its own RNG rolls (golden reports), and check-ins can reroll on demand

Hi, here are two findings from our automation work on build ClLVmN6W. Every input went through the game's own UI and the recorder, and the server verified both runs below.

## 1. The game RNG is readable, so a client can predict golden report effects and click only the best ones

- **What:** logic rolls use `s.rng`, a mulberry32-style generator. Every new game starts it from the same constant (625341585). The leaderboard server mixes a nonce in at run start, at every check-in (about once a minute) and at every resync. Between nonces, the state sits in plain view (`OnlyBans.G.s.rng`, and in the save in localStorage).
- **Effect:** the golden report effect is picked from `s.rng` at the moment of the click. A client can copy the state, run the pick ahead of time, and know the effect before clicking.
- **Timing gives a choice:** the RNG advances on most ticks (75% early in a run, every tick late). Delaying a click by up to 10 ticks (0.33 s) gives about 10 different effects to choose from. A client can also skip reports whose predicted effect is weak.
- **Impact, measured in our offline simulator** (your bundle, fresh game to the 5e37 cap, human-paced clicking):

  | Clicking | Game hours to the cap |
  |---|---|
  | Every golden report | about 39 h |
  | Only predicted meltdowns, bot storms and report chains | about 12 h |
  | The same, with bot storms and chains timed inside meltdowns | about 8.6 h |
  | The same, without human pacing | about 3 h |

  The client clicked about a quarter of the golden reports.
- **Live:** two server-verified fresh runs reached the cap in 2 h 58 m (2026-10-25) and 4 h 1 m (2026-10-26). They made 121 and 196 predicted picks, with 0 and 1 wrong predictions. The clicked mix was almost all meltdown, bot storm and report chain.
- **Possible fixes:**
  - Pick the effect when the report spawns, not on click. That removes the choice from click timing.
  - Flag runs with a skewed effect mix in replay. The server sees every spawn and every click, so it can compare the clicked mix to the natural odds. A human clicks nearly every report; this client skipped about 75%.
  - Any state the client simulates can be predicted by the client, so detection may matter more than hiding the state.

## 2. Check-ins have no rate limit, so a client can reroll on demand

- **What:** the check-in function (`oy(true)`, the forced path) has no rate limit, and each successful attest mixes a fresh server nonce into `s.rng`.
- **Effect:** a client can force check-ins until the predicted next roll is one it wants.
- **Not used:** we did not exploit this. Each reroll is visible to the server, and tick timing already captures most of the value.
- **Possible fix:** accept attests at a fixed cadence only (for example at most one per 60 s), or apply nonces only at fixed tick boundaries.

Happy to share more detail or test a fix build.
