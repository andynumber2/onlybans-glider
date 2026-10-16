#!/usr/bin/env bash
# Concatenates src/ into a single Tampermonkey userscript at dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
out=dist/onlybans-glider.user.js
# The game build the automation rules were last checked against. Update this
# file after re-analyzing a new bundle; the panel warns when the live build differs.
analyzed=$(tr -d '[:space:]' < ANALYZED_BUILD)
version=$(sed -nE 's|^// @version[[:space:]]+([^[:space:]]+).*|\1|p' src/header.txt)
{
  cat src/header.txt
  echo
  echo '(() => {'
  echo "'use strict';"
  echo "const ANALYZED_BUILD = '$analyzed';"
  echo "const VERSION = '$version';"
  for f in planner game input ops stats overlay auto main; do
    echo
    echo "// ---- src/$f.js ----"
    sed -E 's/^export //' "src/$f.js"
  done
  echo '})();'
} > "$out"
echo "built $out"
