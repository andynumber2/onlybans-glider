# Toy model behind SEQUELS.md: python3 -I scripts/analysis/sequel-model.py
# After each launch, t0 minutes of no income, then linear income R = r0 * L / L0.
# Ship when stars >= g * level. Score: log10 all-time at H minutes.
import math
L0, A0, r0 = 9.046e7, 7.40e35, 1.0e34  # from the 2026-10-19 save and sim slope (bans per minute)
def run(g, t0, H):
    L, A, t, launch, ships = L0, A0, 0.0, 0.0, 0
    dt = 1.0
    while t < H:
        if t - launch >= t0: A += r0 * L / L0 * dt
        t += dt
        if (A / 1e12) ** (1/3) >= g * L:
            L = (A / 1e12) ** (1/3); launch = t; ships += 1
    return math.log10(A), ships
if __name__ == '__main__':
    for H in (360, 720, 1440):
        for t0 in (60, 100, 150):
            row = ' '.join(f'x{g}: {run(g, t0, H)[0]:.2f}/{run(g, t0, H)[1]}' for g in (1.05, 1.25, 1.4, 1.6, 2, 4, 1e9))
            print(f'H={H/60:.0f}h t0={t0}m  {row}  (x1e9 = never ship)')
