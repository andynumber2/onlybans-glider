#!/usr/bin/env bash
# Pulls the current game bundle and reports whether it changed since last fetch.
# Then run `node scripts/probe.mjs` to confirm the overlay can still bind.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p research/site
name=$(curl -sL https://onlybans.wtf/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
file=research/site/${name#assets/}
last=$(cat research/site/LATEST 2>/dev/null || true)
if [ "$file" = "$last" ]; then
  echo "unchanged: $file"
  exit 0
fi
curl -sL "https://onlybans.wtf/$name" -o "$file"
echo "$file" > research/site/LATEST
echo "new build: $file (was: ${last:-none})"
