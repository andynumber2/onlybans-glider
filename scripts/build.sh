#!/usr/bin/env bash
# Concatenates src/ into a single Tampermonkey userscript at dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
out=dist/onlybans-glider.user.js
{
  cat src/header.txt
  echo
  echo '(() => {'
  echo "'use strict';"
  for f in planner game ops stats overlay auto main; do
    echo
    echo "// ---- src/$f.js ----"
    sed -E 's/^export //' "src/$f.js"
  done
  echo '})();'
} > "$out"
echo "built $out"
