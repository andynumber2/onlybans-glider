"""List the game's feature keys and compare them to FEATURES.md.

Usage: python3 -I scripts/feature-scan.py [BUNDLE.js]
       (defaults to the bundle named in research/site/LATEST)

Prints every key found in the bundle, grouped by category, and flags keys
that FEATURES.md doesn't mention (new features) and register keys the bundle
no longer has (removed features). Register keys are backticked
`category:name` in the first column of FEATURES.md tables.
"""
import re
import sys

if len(sys.argv) > 1:
    path = sys.argv[1]
else:
    path = open('research/site/LATEST').read().strip()
s = open(path).read()


def keys_in(pattern, text=s):
    return sorted(set(re.findall(pattern, text)))


found = {}

# Player action codes from the input dispatcher.
i = s.find('case"c":return')
found['action'] = keys_in(r'case"(\w)":', s[i - 60:i + 3500])

# Incidents: entries of the incident table, {key:"name",...}.
found['incident'] = keys_in(r'\{key:"(\w+)",(?:fx|weight)')

# Weird events: objects with seconds/minRunSeconds in the weird table.
found['weird'] = keys_in(r'(\w+):\{seconds:\d+,minRunSeconds')

# Relics: {id:"name",icon:...,tier:"..."}.
found['relic'] = keys_in(r'\{id:"(\w+)",icon:"[^"]*",name:[^,]+,tier:"')

# Upgrade kinds registered with REG({...kind:"x"}). REG is a minified name
# that changes per build, so match any identifier.
found['upgradeKind'] = keys_in(r'[\w$]+\(\{id:[^,]+,kind:"(\w+)"')

# Tools: generated from an array via ARR.forEach(... REG({id:`tool:${e.id}` ...
m = re.search(r'([\w$]+)\.forEach\(\(e,t\)=>[\w$]+\(\{id:`tool:', s)
found['tool'] = []
if m:
    start = re.search(r'[,;\s]' + re.escape(m.group(1)) + r'=\[', s)
    if start:
        found['tool'] = keys_in(r'\{id:"(\w+)"', s[start.end():start.end() + 6000].split('];')[0])

# Golden report outcomes (case "x": inside the golden click handler).
j = s.find('case"bustedProvider":')
found['golden'] = keys_in(r'case"(\w+)":\{?', s[j - 3000:j + 4000]) if j >= 0 else []

# Buildings.
found['building'] = keys_in(r'\{id:"(\w+)",name:"[^"]+",plural:"')

register = open('FEATURES.md').read()
registered = set(re.findall(r'^\|\s*`([\w]+:[\w]+)`', register, re.M))

missing, total = [], 0
for cat, keys in found.items():
    for k in keys:
        total += 1
        if f'{cat}:{k}' not in registered:
            missing.append(f'{cat}:{k}')

present = {f'{c}:{k}' for c, ks in found.items() for k in ks}
gone = sorted(k for k in registered if k not in present)

print(f'bundle: {path}')
print(f'keys found: {total}, in register: {total - len(missing)}')
print(f'\nNEW (in bundle, not in FEATURES.md): {len(missing)}')
for k in missing:
    print('  +', k)
print(f'\nGONE (in FEATURES.md, not in bundle): {len(gone)}')
for k in gone:
    print('  -', k)
