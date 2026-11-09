#!/bin/bash
# Inside the container (batch-full.sh): one server, start to finish. One line per server
# in /out/status.txt: ok (with each step's exit code), no-menu, install-failed or no-bin.
id=$1; spec=$2; d=/out/$id; mkdir -p "$d"; cd "$d" || exit
T=/toolmenu/dist/cli.js
export npm_config_cache="$d/.npm"
mkdir -p pkg
if ! timeout 300 npm install --silent --no-audit --no-fund --prefix pkg "$spec" > install.txt 2>&1; then echo "install-failed $id" >> /out/status.txt; rm -rf pkg .npm; exit; fi
name=${spec%@*}
bin=$(node -e '
  const p = require(process.argv[1] + "/node_modules/" + process.argv[2] + "/package.json");
  const b = typeof p.bin === "string" ? { [p.name.split("/").pop()]: p.bin } : (p.bin || {});
  const k = Object.keys(b); if (!k.length) process.exit(3);
  console.log(process.argv[1] + "/node_modules/.bin/" + (k.find((n) => /mcp|server/i.test(n)) || k[0]));
' "$d/pkg" "$name" 2>> install.txt) || { echo "no-bin $id" >> /out/status.txt; rm -rf pkg .npm; exit; }
timeout 300 node $T snapshot --json --timeout 30000 --lists prompts,resources --client claude-code --offline-check --out menu.json -- "$bin" > snapshot.json 2> snapshot-err.txt
sc=$?
tools=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync("snapshot.json","utf8"));console.log(j.tools||0)}catch{console.log(0)}')
if [ "$sc" -le 1 ] && [ "$tools" -gt 0 ]; then
  timeout 900 node $T session --auto --json --timeout 30000 --union-out union.json -- "$bin" > session.json 2> session-err.txt
  ss=$?
  rs=-
  if [ -s union.json ]; then timeout 120 node $T review --json menu.json union.json > review.json 2> review-err.txt; rs=$?; fi
  echo "ok $id snapshot=$sc tools=$tools session=$ss review=$rs" >> /out/status.txt
else
  echo "no-menu $id snapshot=$sc" >> /out/status.txt
fi
# KEEP_INSTALL=1: the sealed pass (sealed-one.sh) calls every tool next, then deletes it.
if [ "${KEEP_INSTALL:-}" = 1 ] && [ "$sc" -le 1 ] && [ "$tools" -gt 0 ]; then echo "$bin" > bin.txt; rm -rf .npm; else rm -rf pkg .npm; fi
