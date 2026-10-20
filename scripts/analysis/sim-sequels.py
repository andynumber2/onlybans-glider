# Sequel ships in sim logs: python3 -I scripts/analysis/sim-sequels.py research/sim-runs/g2-s*.txt
# A ship shows up as bps dropping by more than 1e6x between minute lines; prints the minute, all-time
# bans and bps just before each ship, plus the summary's error and runaway (>3000) action counts.
import json, re, sys
for f in sys.argv[1:]:
    prev = None; ships = []; s = None
    for line in open(f):
        m = re.match(r't=(\d+)m bansAllTime=(\S+) bps=(\S+)', line)
        if m:
            t, a, b = int(m.group(1)), float(m.group(2)), float(m.group(3))
            if prev and b < prev[2] * 1e-6: ships.append(prev)
            prev = (t, a, b)
        elif line.startswith('{'):
            s = json.loads(line)
    name = f.split('/')[-1]
    shipped = ' '.join(f'{t}m(allTime {a:.2e}, bps {b:.2e})' for t, a, b in ships) or 'none'
    if s is None:
        print(f'{name:12} ships: {shipped} (no summary, run unfinished)')
        continue
    errs = {k: v for k, v in s['actions'].items() if 'error' in k}
    big = {k: v for k, v in s['actions'].items() if v > 3000}
    print(f"{name:12} sequels={s['sequels']} level={s['prestigeLevel']:.3e} end allTime={s['bansAllTime']:.2e} ships: {shipped} errors={errs} big={big}")
