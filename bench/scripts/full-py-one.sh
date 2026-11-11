#!/bin/bash
# full-one.sh for a PyPI package (batch-full.sh with PY=1): the same steps, with the server
# installed by uv (mounted at /uv) into its own venv, on Python 3.12 (PYVER to change it; uv fetches it into the server's folder). The venv, and any Python uv downloads
# for it, stay in the server's folder until the sealed pass has run.
id=$1; spec=$2; d=/out/$id; mkdir -p "$d"; cd "$d" || exit
T=/toolmenu/dist/cli.js
mkdir -p "$HOME"   # some servers unpack into it (.NET single-file bundles)
line=$(awk -F'\t' -v id="$id" '$1 == id' /list.tsv)
env_kv=$(printf '%s' "$line" | cut -f4 -s); args=$(printf '%s' "$line" | cut -f5 -s)
printf '%s\n%s\n' "$env_kv" "$args" > extra.txt
export UV_CACHE_DIR="$d/.uvcache" UV_PYTHON_INSTALL_DIR="$d/pkg/python"
[ -f /ca.crt ] && export SSL_CERT_FILE=/ca.crt
if ! { timeout 300 /uv venv -q --python "${PYVER:-3.12}" "$d/pkg/venv" && VIRTUAL_ENV="$d/pkg/venv" timeout 600 /uv pip install -q "$spec"; } > install.txt 2>&1; then
  echo "install-failed $id" >> /out/status.txt; rm -rf pkg .uvcache; exit
fi
name=${spec%%==*}
# The column after the args can name the console script; otherwise the one named for the package, or for mcp/server.
pick=$(printf '%s' "$line" | cut -f6 -s)
# Else the console scripts the package itself declares (its entry_points.txt), preferring
# one named for the package or for mcp/server. None declared: no-bin (a dependency's
# scripts, like idna or keyring, are never the server).
[ -z "$pick" ] && pick=$("$d/pkg/venv/bin/python" /toolmenu/bench/scripts/py-entry.py "$name")
[ -z "$pick" ] && { echo "no-bin $id" >> /out/status.txt; rm -rf pkg .uvcache; exit; }
bin="$d/pkg/venv/bin/$pick"
rm -rf .uvcache
timeout 420 node $T snapshot --json --timeout 30000 --lists prompts,resources --read-resources --client claude-code --offline-check --out menu.json -- env $env_kv "$bin" $args > snapshot.json 2> snapshot-err.txt
sc=$?
tools=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync("snapshot.json","utf8"));console.log(j.tools||0)}catch{console.log(0)}')
if [ "$sc" -le 1 ] && [ "$tools" -gt 0 ]; then
  timeout 900 node $T session --auto --json --timeout 30000 --union-out union.json -- env $env_kv "$bin" $args > session.json 2> session-err.txt
  ss=$?
  rs=-
  if [ -s union.json ]; then timeout 120 node $T review --json menu.json union.json > review.json 2> review-err.txt; rs=$?; fi
  echo "ok $id snapshot=$sc tools=$tools session=$ss review=$rs" >> /out/status.txt
else
  echo "no-menu $id snapshot=$sc" >> /out/status.txt
fi
if [ "${KEEP_INSTALL:-}" = 1 ] && [ "$sc" -le 1 ] && [ "$tools" -gt 0 ]; then echo "$bin" > bin.txt; else rm -rf pkg; fi
