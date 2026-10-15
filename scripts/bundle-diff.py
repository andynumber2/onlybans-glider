"""Compare two game bundles despite re-minified names.

Usage: python3 -I scripts/bundle-diff.py OLD.js NEW.js

Minifier identifiers change every build, so this compares what survives
minification: string literals, and code with identifiers masked out.
"""
import difflib
import re
import sys

old_path, new_path = sys.argv[1], sys.argv[2]
a = open(old_path).read()
b = open(new_path).read()
print(f'sizes: {len(a)} -> {len(b)} ({len(b) - len(a):+d})')

lit = re.compile(r'"([^"\\]{3,300})"')
# Real text only: drop spans that are code caught between two quote marks.
code_chars = re.compile(r'[(){};=`]|&&|\|\|')


def literals(src):
    return {x for x in lit.findall(src) if not code_chars.search(x)}


la, lb = literals(a), literals(b)
print(f'\nstring literals removed ({len(la - lb)}):')
for x in sorted(la - lb)[:60]:
    print('  -', x)
print(f'\nstring literals added ({len(lb - la)}):')
for x in sorted(lb - la)[:60]:
    print('  +', x)

# Mask identifiers (keep property names after a dot and object keys) so the
# remaining diff is logic and numbers.
KEEP = set('return const let var function if else for while switch case break new typeof void true false null of in do try catch finally throw this'.split())


def mask(src):
    def sub(m):
        word = m.group(0)
        if word in KEEP:
            return word
        return '_'
    out = re.sub(r'(?<![.\w$])[A-Za-z_$][\w$]{0,2}(?![\w$:])', sub, src)
    return re.sub(r';', ';\n', out).splitlines()


ma, mb = mask(a), mask(b)
diff = [d for d in difflib.unified_diff(ma, mb, lineterm='', n=0) if d[:1] in '+-' and d[:3] not in ('+++', '---')]
print(f'\nmasked code lines changed: {len(diff)}')
for d in diff[:80]:
    print(d[:220])
