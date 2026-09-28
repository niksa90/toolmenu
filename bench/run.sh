#!/usr/bin/env bash
# Run this checkout's toolmenu against the corpus, in a container.
#   bench/run.sh <out-dir> [server ...]      snapshot + session --init + session
# Needs Docker and a build (npm run build). The container gets this checkout
# read-only and <out-dir> writable, nothing else from the host.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
out="$(mkdir -p "${1:?usage: bench/run.sh <out-dir> [server ...]}" && cd "$1" && pwd)"
shift
docker build -q -t toolmenu-corpus "$here" > /dev/null
docker run --rm -v "$repo:/toolmenu:ro" -v "$out:/out" -e ONLY="$*" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
  toolmenu-corpus bash /toolmenu/bench/inside.sh
