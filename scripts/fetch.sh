#!/usr/bin/env bash
# Pulls the current game bundle and index.html (the simulator loads the bundle
# named in index.html) and reports whether the bundle changed since last fetch.
# Then run `node scripts/probe.mjs` to confirm the overlay can still bind.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p research/site
curl -sL https://onlybans.wtf/ -o research/site/index.html
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
