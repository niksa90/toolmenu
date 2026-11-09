#!/bin/bash
# usage: bench/scripts/batch-image.sh <list.tsv: id<TAB>image[<TAB>repo[<TAB>KEY=v KEY2=v[<TAB>args]]]> <outdir>
# Servers shipped as container images (GitHub's, Grafana's, HashiCorp's, Docker's mcp/*).
# Each runs in its own container, started by toolmenu with `docker run -i --rm`, so its code
# stays there: snapshot, session --auto and review, as full-one.sh; then the sealed pass with
# --network none: every tool called once, writes included. Pull the images first.
# Build first: npm run build.
set -uo pipefail
T="$(cd "$(dirname "$0")/../.." && pwd)/dist/cli.js"
out="$(mkdir -p "$2" && cd "$2" && pwd)"
one() {
  local id=$1 image=$2 env_kv=$4 args=$5 d="$out/$1"; mkdir -p "$d"; cd "$d" || return
  local e=(); for kv in $env_kv; do e+=(-e "$kv"); done
  local run=(docker run -i --rm --memory 2g "${e[@]}")
  timeout 300 node "$T" snapshot --json --timeout 60000 --lists prompts,resources --client claude-code --offline-check --out menu.json -- "${run[@]}" "$image" $args > snapshot.json 2> snapshot-err.txt
  local sc=$? tools
  tools=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync("snapshot.json","utf8"));console.log(j.tools||0)}catch{console.log(0)}')
  if [ "$sc" -le 1 ] && [ "$tools" -gt 0 ]; then
    timeout 900 node "$T" session --auto --json --timeout 30000 --union-out union.json -- "${run[@]}" "$image" $args > session.json 2> session-err.txt
    local ss=$? rs=-
    if [ -s union.json ]; then timeout 120 node "$T" review --json menu.json union.json > review.json 2> review-err.txt; rs=$?; fi
    echo "ok $id snapshot=$sc tools=$tools session=$ss review=$rs" >> "$out/status.txt"
    timeout 1200 node "$T" session --auto --call-everything --json --timeout 10000 --processes 1 -- "${run[@]}" --network none "$image" $args > everything.json 2> everything-err.txt
    echo "$? $id" >> "$out/status-sealed.txt"
  else
    echo "no-menu $id snapshot=$sc" >> "$out/status.txt"
  fi
}
export -f one; export T out
# Columns split by awk, not read: read would merge the empty repo column with the next.
awk -F'\t' '{ printf "%s\0%s\0%s\0%s\0%s\0", $1, $2, $3, $4, $5 }' "$1" | xargs -0 -n 5 -P "${PARALLEL:-4}" bash -c 'one "$@"' _
