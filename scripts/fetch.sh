#!/usr/bin/env bash
# Pulls the current game bundle and index.html (the simulator loads the bundle
# named in index.html) and reports whether the bundle changed since last fetch.
# Then run `node scripts/probe.mjs` to confirm the overlay can still bind.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p research/site
curl -sL https://onlybans.wtf/ -o research/site/index.html
# Stylesheets too: the offline browser checks need the game's real layout.
mkdir -p research/site/assets
for css in $(grep -oE '/assets/[A-Za-z0-9_.-]+\.css' research/site/index.html); do
  [ -f "research/site$css" ] || curl -sL "https://onlybans.wtf$css" -o "research/site$css"
done
name=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' research/site/index.html | head -1)
file=research/site/${name#assets/}
last=$(cat research/site/LATEST 2>/dev/null || true)
if [ "$file" = "$last" ]; then
  echo "unchanged: $file"
  exit 0
fi
curl -sL "https://onlybans.wtf/$name" -o "$file"
echo "$file" > research/site/LATEST
echo "new build: $file (was: ${last:-none})"
# Signs the game started checking whether input is real or visible. Synthetic
# clicks can't pass an isTrusted check; see src/input.js.
for pat in isTrusted elementFromPoint elementsFromPoint getCoalescedEvents; do
  if grep -q "$pat" "$file"; then echo "WARNING: new build uses $pat (input checks?)"; fi
done
