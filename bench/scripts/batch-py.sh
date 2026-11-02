#!/bin/bash
# usage: batch-py.sh <list.tsv: id<TAB>pkg==ver[<TAB>repo]> <outdir>
# Installs each PyPI package into its own venv (outside toolmenu's timeout), picks
# its console script, then runs toolmenu snapshot and session --auto from the
# server's own folder, so files a server writes stay there.
# TOOLMENU: the CLI to run (default: this checkout's dist/cli.js; build first).
TOOLMENU=${TOOLMENU:-$(cd "$(dirname "$0")/../.." && pwd)/dist/cli.js}
export TOOLMENU
LIST=$1; OUT=$2; mkdir -p "$OUT"
run() {
  id=$1; spec=$2; d="$OUT/$id"; mkdir -p "$d"; cd "$d" || return
  if [ ! -f "$d/bin.txt" ]; then
    if ! { timeout 300 uv venv -q "$d/venv" && VIRTUAL_ENV="$d/venv" timeout 300 uv pip install -q "$spec"; } > "$d/install.txt" 2>&1; then
      echo "install-failed $id" >> "$OUT/status.txt"; return
    fi
    name=${spec%%==*}
    # The package's own console scripts: prefer one named for the package or for mcp/server.
    pick=$(ls "$d/venv/bin" | grep -vE '^(python|pip|activate|deactivate|uv|f2py|normalizer|httpx|dotenv|jsonschema|mcp|uvicorn|websockets|typer|markdown-it|pygmentize|fastmcp|openai|tqdm|distro|watchfiles|cyclopts|email_validator)' | grep -vE '\.(fish|csh|ps1|nu|bat)$' \
      | awk -v n="$name" 'BEGIN{IGNORECASE=1} {s=0; if ($0==n) s=3; else if (index($0,n)) s=2; else if ($0 ~ /mcp|server/) s=1; print s"\t"$0}' | sort -rn | head -1 | cut -f2)
    if [ -z "$pick" ]; then echo "no-bin $id" >> "$OUT/status.txt"; return; fi
    echo "$d/venv/bin/$pick" > "$d/bin.txt"
  fi
  bin=$(cat "$d/bin.txt")
  timeout 240 node "$TOOLMENU" snapshot --json --timeout 30000 --out "$d/menu.json" -- "$bin" > "$d/out.json" 2> "$d/err.txt"
  s=$?
  if [ -f "$d/menu.json" ]; then
    timeout 600 node "$TOOLMENU" session --auto --json --timeout 30000 -- "$bin" > "$d/session.json" 2> "$d/session-err.txt"
  fi
  echo "$s $id" >> "$OUT/status.txt"
}
export -f run; export OUT
while IFS=$'\t' read -r a b c; do printf '%s %s\n' "$a" "$b"; done < "$LIST" \
  | xargs -P 6 -L 1 bash -c 'run "$0" "$1"'
