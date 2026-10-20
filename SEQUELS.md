# When to ship a sequel

## Two different numbers

1. **Production** is how fast you earn right now. It climbs after a sequel and levels off about 100 min later (measured in sims).
2. **Stars ÷ level** is how much bigger your multiplier would get if you shipped now. Stars = cube root of (all-time bans / 1e12) (read from code), so this only grows as all-time bans pile up. Doubling stars takes 8× the all-time bans.

A plateau in production doesn't mean stars have grown. It only means buildings stopped getting cheaper relative to income. At the moment production plateaus, almost no new all-time bans exist yet, because most of that time was spent ramping. So stars ÷ level is about 1.0 to 1.05 (inferred from the 100 min ramp, not measured).

A strict "ship at the plateau" rule would therefore ship for a raise of 5% or less, then ramp again for 100 min, plateau again, and ship again for another 5%. Most of the time goes to ramping and the multiplier barely moves.

## Picture it as a loop

Ship → 100 min of rebuilding (earning little) → plateau → earn at a flat rate → stars slowly creep up → ship again.

- The flat-rate stretch is what makes stars grow. Ship too early and that stretch never happens.
- Wait too long (×4) and you sit at a flat rate for days while a bigger multiplier was already available.
- ×1.25 to ×2 sits between those two failure modes, and the result barely changes anywhere in that range.

## How much it matters

The margin is thin in the middle and steep outside it.

| Rule | Result | Source |
|---|---|---|
| Ship anywhere from ×1.25 to ×2 | About 10% difference in total bans after 24 h | Toy model (`scripts/analysis/sequel-model.py`); real sims: ×1.6 vs ×2 tied (4 of 9 seeds) |
| Wait too long (×4) | About 2× fewer bans over 24 h | Sims: 37.41 vs 37.73 log10, ×2 won 9 of 9 seeds |
| Never ship | About 8× fewer bans over 3 h | Sims: 26.15 vs 27.05 log10 |
| Ship right at the plateau (~×1.05) | About 3.5× fewer bans than never shipping over 24 h (36.61 vs 37.15 log10, 11 ships) | Toy model only, which assumes zero income during the ramp, so it overstates the loss; not run in the real sim |

The bot ships at ×2 (v0.23.0, `sequelPlan` in `src/planner.js`).

## Why the gap between sequels doubles

Each ×2 ship needs 8× the all-time bans of the last one, while income grows about 4× per sequel (fitted to one measured transition). So each gap is about twice the one before: about 8 h, 15 h, 28 h, 2 days, and so on (`scripts/analysis/sequel-forecast.py`, from the 2026-10-19 save; only the first two gaps are measured). A lower threshold doesn't escape this: you ship more often, but each sequel gives a smaller raise.
