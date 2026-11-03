#!/bin/bash
# usage: batch.sh <list.tsv: id<TAB>pkg@ver[<TAB>repo]> <outdir> <mode: snapshot|session>
# Installs each package into <outdir>/<id>/pkg first (outside toolmenu's timeout),
# then runs toolmenu against the package's first bin.
# TOOLMENU: the CLI to run (default: this checkout's dist/cli.js; build first).
TOOLMENU=${TOOLMENU:-$(cd "$(dirname "$0")/../.." && pwd)/dist/cli.js}
export TOOLMENU
LIST=$1; OUT=$2; MODE=$3; mkdir -p "$OUT"
run() {
  id=$1; spec=$2; d="$OUT/$id"; mkdir -p "$d"; cd "$d" || return
  if [ ! -f "$d/bin.txt" ]; then
    mkdir -p "$d/pkg"
    if ! timeout 300 npm install --silent --no-audit --no-fund --prefix "$d/pkg" "$spec" > "$d/install.txt" 2>&1; then
      echo "install-failed $id" >> "$OUT/status-$MODE.txt"; return
    fi
    name=${spec%@*}
    node -e '
      const p = require(process.argv[1] + "/node_modules/" + process.argv[2] + "/package.json");
      const b = typeof p.bin === "string" ? { [p.name.split("/").pop()]: p.bin } : (p.bin || {});
      const k = Object.keys(b); if (!k.length) process.exit(3);
      const pick = k.find((n) => /mcp|server/i.test(n)) || k[0];
      console.log(process.argv[1] + "/node_modules/.bin/" + pick);
    ' "$d/pkg" "$name" > "$d/bin.txt" 2>> "$d/install.txt" || { echo "no-bin $id" >> "$OUT/status-$MODE.txt"; rm -f "$d/bin.txt"; return; }
  fi
  bin=$(cat "$d/bin.txt")
  if [ "$MODE" = snapshot ]; then
    timeout 240 node "$TOOLMENU" snapshot --json --timeout 30000 --out "$d/menu.json" -- "$bin" > "$d/out.json" 2> "$d/err.txt"
  else
    timeout 600 node "$TOOLMENU" session --auto --json --timeout 30000 -- "$bin" > "$d/session.json" 2> "$d/session-err.txt"
  fi
  echo "$? $id" >> "$OUT/status-$MODE.txt"
}
export -f run; export OUT MODE
while IFS=$'\t' read -r a b c; do printf '%s %s\n' "$a" "$b"; done < "$LIST" \
  | xargs -P 6 -L 1 bash -c 'run "$0" "$1"'
