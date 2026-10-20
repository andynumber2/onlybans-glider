# Forecast of the next 10 sequels at x2: python3 -I scripts/analysis/sequel-forecast.py
# Ship n needs all-time A0 * 8^n. Gap = ramp + new bans / plateau rate; the rate grows k-fold per sequel.
# r1 and the ramp are fitted to 24 h sims (g2-s7..15): first gap median ~490 min, second ~930 min.
A0, ramp = 7.40e35, 100.0  # 2026-10-19 save
r1 = (8 * A0 - A0) / (490 - ramp)  # bans per minute after the ramp, first sequel
for k in (3, 4, 5):
    t, A, r = 0.0, A0, r1
    print(f'income x{k} per sequel')
    for n in range(1, 11):
        gap = ramp + 7 * A / r
        t += gap; A *= 8
        print(f'  #{7 + n:2} gap {gap / 60:8.1f} h  cum {t / 1440:8.2f} d  allTime {A:.2e}  rate {r / 60:.2e}/s')
        r *= k
