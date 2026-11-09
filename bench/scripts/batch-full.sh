#!/bin/bash
# usage: bench/scripts/batch-full.sh <list.tsv: id<TAB>pkg@ver[<TAB>repo]> <outdir>
# Every server on the list, in a node:22 container (third-party code stays in it): install,
# snapshot (--lists prompts,resources --client claude-code --offline-check), and when it
# listed tools, session --auto --union-out and review of the snapshot against the union.
# The install is deleted after each server, so disk use stays flat. 6 at a time.
# Behind an HTTPS proxy (HTTPS_PROXY on loopback), the container shares the host network
# and gets the proxy and its CA (CA_BUNDLE). Build first: npm run build.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
list="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="$(mkdir -p "$2" && cd "$2" && pwd)"
ca=()
[ -n "${CA_BUNDLE:-}" ] && ca=(-e NODE_EXTRA_CA_CERTS=/ca.crt -e npm_config_cafile=/ca.crt -v "$CA_BUNDLE:/ca.crt:ro")
docker run --rm --network host -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY "${ca[@]}" \
  -e HOME=/tmp/home -v "$repo:/toolmenu:ro" -v "$out:/out" -v "$list:/list.tsv:ro" \
  node:22-bookworm bash -c 'cut -f1,2 /list.tsv | tr "\t" " " | xargs -P 6 -L 1 bash /toolmenu/bench/scripts/full-one.sh'
