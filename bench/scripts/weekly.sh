#!/bin/bash
# The weekly bench, start to finish, from the repository root:
#   1. every server on bench/corpus/http-panel.tsv (109 vendor endpoints, then a seeded
#      2,000 from the registry's long tail): auth check, snapshot, read-only session;
#   2. stdio servers with a new release since they were last checked, and new ones (at
#      most MAX_STDIO, 300), in containers, with the sealed every-tool pass (SEALED=1);
#   3. the servers vendors publish (bench/corpus/vendors-{npm,pypi,images}.tsv), each at
#      its latest release, with dummy credentials and the same sealed pass;
#   4. bench/results/weekly/<date>/ with the three datasets and CHANGES.md against the
#      previous week.
# Needs Docker (started here if the daemon isn't running), Node 22 and Python 3. Behind
# an HTTPS proxy, set CA_BUNDLE to its CA file for the containers.
set -euo pipefail
cd "$(dirname "$0")/../.."
DATE="${DATE:-$(date -u +%F)}"; WORK="${WORK:-/tmp/toolmenu-weekly/$DATE}"; R="bench/results/weekly/$DATE"
mkdir -p "$WORK/http" "$WORK/stdio" "$WORK/vendors" "$R"
npm ci --silent && npm run build --silent
if ! docker info > /dev/null 2>&1; then (nohup dockerd > "$WORK/dockerd.log" 2>&1 &); for _ in $(seq 1 60); do docker info > /dev/null 2>&1 && break; sleep 1; done; fi

echo "== hosted panel"
bench/scripts/batch-http.sh bench/corpus/http-panel.tsv "$WORK/http/out" > "$WORK/http/log.txt" 2>&1 || true
python3 -I bench/scripts/build-http.py "$WORK/http/out" "$R/http" bench/corpus/http-panel.tsv

echo "== stdio: new releases and new servers"
python3 -I bench/scripts/registry-stdio.py /dev/null > "$WORK/stdio/registry.tsv"
python3 -I bench/scripts/stdio-delta.py pick bench/results/weekly/stdio-versions.tsv "$WORK/stdio/registry.tsv" "${MAX_STDIO:-300}" > "$WORK/stdio/try.tsv"
if [ -s "$WORK/stdio/try.tsv" ]; then
  SEALED=1 bench/scripts/batch-full.sh "$WORK/stdio/try.tsv" "$WORK/stdio/out" > "$WORK/stdio/log.txt" 2>&1 || true
  python3 -I bench/scripts/build-results.py "$WORK/stdio" "$R/stdio" "$WORK/stdio/page.json"
  python3 -I bench/scripts/stdio-delta.py record bench/results/weekly/stdio-versions.tsv "$WORK/stdio/try.tsv" "$DATE"
fi

echo "== vendors: their own servers, latest releases"
V="$WORK/vendors"
for k in npm pypi; do python3 -I bench/scripts/vendor-latest.py "bench/corpus/vendors-$k.tsv" > "$V/$k.tsv"; done
cp bench/corpus/vendors-images.tsv "$V/images.tsv"
cut -f2 "$V/images.tsv" | while read -r image; do docker pull -q "$image" > /dev/null 2>&1 || echo "pull failed: $image" >> "$V/log.txt"; done
SEALED=1 bench/scripts/batch-full.sh "$V/npm.tsv" "$V/npm" >> "$V/log.txt" 2>&1 || true
PY=1 SEALED=1 bench/scripts/batch-full.sh "$V/pypi.tsv" "$V/pypi" >> "$V/log.txt" 2>&1 || true
bench/scripts/batch-image.sh "$V/images.tsv" "$V/images" >> "$V/log.txt" 2>&1 || true
python3 -I bench/scripts/build-vendors.py "$R/vendors" "$V/npm.tsv" "$V/npm" "$V/pypi.tsv" "$V/pypi" "$V/images.tsv" "$V/images"

PREV=$(ls -d bench/results/weekly/*/ 2>/dev/null | grep -v "/$DATE/" | sort | tail -1 || true)
if [ -n "$PREV" ]; then python3 -I bench/scripts/compare-weeks.py "$PREV" "$R" dist/cli.js > "$R/CHANGES.md"; else echo "First weekly run: nothing to compare with." > "$R/CHANGES.md"; fi
git rev-parse HEAD > "$R/toolmenu-commit.txt"
echo "== done: $R"
