#!/bin/bash
# usage: bench/scripts/batch-http.sh <list: name<TAB>url> <outdir>
# Hosted (Streamable HTTP) servers: nothing runs here but toolmenu, so no container.
# Per server: auth check (OAuth discovery, no login); then, if it lists tools without
# credentials, snapshot (--lists prompts,resources --client claude-code), session --auto
# (read-only tools only, at most 10 calls: these are someone's production systems) and
# review of the snapshot against the session's union menu. Logins stored with
# `toolmenu auth login` are used when LOGINS=1; otherwise --no-auth.
# 8 servers at a time. One line per server in <outdir>/status.txt.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
export T="${TOOLMENU:-$repo/dist/cli.js}" OUT="$(mkdir -p "$2" && cd "$2" && pwd)" AUTH_FLAG="$([ "${LOGINS:-}" = 1 ] || echo --no-auth)"
export NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1
one() {
  # One folder per URL (a registry name can cover several: com.cloudflare.mcp/mcp has 15).
  name=$1; url=$2; d="$OUT/$(printf '%s' "${url#https://}" | tr -c 'A-Za-z0-9._-' '_')"; mkdir -p "$d"; cd "$d" || return
  printf '%s\n' "$url" > url.txt; printf '%s\n' "$name" > name.txt
  timeout 120 node "$T" auth check --json "$url" > auth.json 2> auth-err.txt
  timeout 300 node "$T" snapshot --json --timeout 30000 --lists prompts,resources --client claude-code $AUTH_FLAG --out menu.json "$url" > snapshot.json 2> snapshot-err.txt
  sc=$?
  tools=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("snapshot.json","utf8")).tools||0)}catch{console.log(0)}')
  if [ "$sc" -le 1 ] && [ "$tools" -gt 0 ]; then
    timeout 600 node "$T" session --auto --max-calls 10 --json --timeout 30000 $AUTH_FLAG --union-out union.json "$url" > session.json 2> session-err.txt
    ss=$?; rs=-
    [ -s union.json ] && { timeout 120 node "$T" review --json menu.json union.json > review.json 2> review-err.txt; rs=$?; }
    echo "ok $url snapshot=$sc tools=$tools session=$ss review=$rs" >> "$OUT/status.txt"
  else
    echo "no-menu $url snapshot=$sc" >> "$OUT/status.txt"
  fi
}
export -f one
tr '\t' ' ' < "$1" | xargs -P 8 -L 1 bash -c 'one "$0" "$1"'
