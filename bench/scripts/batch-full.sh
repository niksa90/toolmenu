#!/bin/bash
# usage: bench/scripts/batch-full.sh <list.tsv: id<TAB>pkg@ver[<TAB>repo[<TAB>KEY=v KEY2=v[<TAB>args]]]> <outdir>
# Every server on the list, in node:22 containers (third-party code stays in them): install,
# snapshot (--lists prompts,resources --client claude-code --offline-check), and when it
# listed tools, session --auto --union-out and review of the snapshot against the union.
# SEALED=1 adds a second pass per chunk in a container with no network at all: every tool
# called once, writes included (session --auto --call-everything, sealed-one.sh).
# Installs are deleted after each server (or after its sealed pass), so disk use stays
# flat. 6 servers at a time, CHUNK (100) servers per container pair.
# PY=1: the list holds PyPI packages (pkg==ver), installed with the host's uv (UV, default
# `which uv`) by full-py-one.sh; a 6th column can name the console script.
# Behind an HTTPS proxy (HTTPS_PROXY on loopback), the first container shares the host
# network and gets the proxy and its CA (CA_BUNDLE). Build first: npm run build.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
list="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="$(mkdir -p "$2" && cd "$2" && pwd)"
chunk="${CHUNK:-100}"
ca=()
[ -n "${CA_BUNDLE:-}" ] && ca=(-e NODE_EXTRA_CA_CERTS=/ca.crt -e npm_config_cafile=/ca.crt -v "$CA_BUNDLE:/ca.crt:ro")
part="$out/.chunk.tsv"
one=full-one.sh; py=()
if [ "${PY:-}" = 1 ]; then one=full-py-one.sh; py=(-v "${UV:-$(command -v uv)}:/uv:ro"); fi
total=$(wc -l < "$list")
for ((start = 1; start <= total; start += chunk)); do
  sed -n "${start},$((start + chunk - 1))p" "$list" > "$part"
  docker run --rm --network host -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY "${ca[@]}" -e KEEP_INSTALL="${SEALED:-}" \
    -e HOME=/tmp/home -v "$repo:/toolmenu:ro" -v "$out:/out" -v "$part:/list.tsv:ro" "${py[@]}" \
    node:22-bookworm bash -c "cut -f1,2 /list.tsv | tr '\\t' ' ' | xargs -P 6 -L 1 bash /toolmenu/bench/scripts/$one"
  if [ "${SEALED:-}" = 1 ]; then
    docker run --rm --network none -e HOME=/tmp/home -v "$repo:/toolmenu:ro" -v "$out:/out" -v "$part:/list.tsv:ro" \
      node:22-bookworm bash -c 'cut -f1 /list.tsv | xargs -P 6 -L 1 bash /toolmenu/bench/scripts/sealed-one.sh'
  fi
done
rm -f "$part"
