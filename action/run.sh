#!/usr/bin/env bash
# toolmenu GitHub Action: snapshot the server, diff against the committed
# baseline, optionally run a session scenario, then write one report to the job
# summary and (on pull requests) one PR comment that updates in place.
set -uo pipefail

CLI="${TOOLMENU_CLI:-npx --yes toolmenu@${TOOLMENU_VERSION:-latest}}"
OUT="${RUNNER_TEMP:-/tmp}/toolmenu"
mkdir -p "$OUT"
BODY="$OUT/comment.md"
MARKER='<!-- toolmenu-report -->'
FAIL_ON="${TOOLMENU_FAIL_ON:-error}"

if [ -n "${TOOLMENU_URL:-}" ]; then
  TARGET=("$TOOLMENU_URL")
elif [ -n "${TOOLMENU_COMMAND:-}" ]; then
  TARGET=(-- sh -c "exec $TOOLMENU_COMMAND")
else
  echo "::error title=toolmenu::Set either 'command' (how to start the server) or 'url'."
  exit 2
fi

status=0
note() { [ "$1" -gt "$status" ] && status=$1; }

# The release versions for diff's version-bump check. serverInfo.version is often
# not the release, so diff only checks the bump against these (FINDINGS F5).
# "auto", in any language:
#   - on a tag push: the previous version tag → this tag;
#   - on a pull request: the version in package.json, pyproject.toml or Cargo.toml
#     on the base branch → the same file here.
# Projects versioned only by git tags (Go, setuptools-scm) have no next version
# in a PR; their bump is checked when the tag is pushed.
release_args() {
  local release="${TOOLMENU_RELEASE:-auto}"
  if [ "$release" = "off" ] || [ -z "$release" ]; then return; fi
  if [ "$release" != "auto" ]; then echo "--release $release"; return; fi
  local version="${TOOLMENU_VERSION_SCRIPT:-$(dirname "$0")/version.mjs}"
  if [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
    local tag="${GITHUB_REF#refs/tags/}" previous
    git fetch --quiet --tags origin 2>/dev/null
    previous=$(git tag --list --sort=-v:refname | grep -E '^v?[0-9]+\.[0-9]+' | grep -vxF "$tag" \
      | while read -r t; do [ "$(printf '%s\n%s\n' "$t" "$tag" | sort -V | tail -1)" = "$tag" ] && { echo "$t"; break; }; done)
    [ -n "$previous" ] && echo "--release $previous..$tag"
    return
  fi
  [ -n "${TOOLMENU_BASE_REF:-}" ] || return
  git fetch --quiet --depth=1 origin "$TOOLMENU_BASE_REF" 2>/dev/null || return
  local file before after
  for file in package.json pyproject.toml Cargo.toml; do
    [ -f "$file" ] || continue
    after=$(node "$version" "$file" < "$file")
    before=$(git show "FETCH_HEAD:$file" 2>/dev/null | node "$version" "$file")
    if [ -n "$before" ] && [ -n "$after" ]; then echo "--release $before..$after"; return; fi
  done
}

{
  echo "$MARKER"
  echo "## toolmenu"
  echo
} > "$BODY"

# 1. Snapshot the menu this change produces.
$CLI snapshot --out "$OUT/current.json" --format markdown --fail-on "$FAIL_ON" "${TARGET[@]}" > "$OUT/snapshot.md" 2> "$OUT/snapshot.err"
code=$?
if [ "$code" -eq 2 ]; then
  { echo "**Couldn't snapshot the server.**"; echo; echo '```'; tail -20 "$OUT/snapshot.err"; echo '```'; } >> "$BODY"
  note 2
else
  note "$code"
  # 2. Compare with the committed baseline.
  if [ -f "${TOOLMENU_BASELINE:-menu.json}" ]; then
    # shellcheck disable=SC2046
    $CLI diff --format markdown --fail-on "$FAIL_ON" $(release_args) "${TOOLMENU_BASELINE:-menu.json}" "$OUT/current.json" > "$OUT/diff.md" 2> "$OUT/diff.err"
    code=$?; note "$code"
    if [ "$code" -eq 2 ]; then { echo "**Couldn't compare with the baseline:** $(head -1 "$OUT/diff.err")"; echo; } >> "$BODY"; else { cat "$OUT/diff.md"; echo; } >> "$BODY"; fi
  else
    { echo "No baseline at \`${TOOLMENU_BASELINE:-menu.json}\`, so there's nothing to compare with yet. Commit the snapshot to start tracking changes:"; echo; echo '```sh'; echo "npx toolmenu snapshot ${TOOLMENU_URL:-"-- $TOOLMENU_COMMAND"}"; echo '```'; echo; } >> "$BODY"
  fi
  { cat "$OUT/snapshot.md"; echo; } >> "$BODY"
fi

# 3. Watch the menu during a scripted session.
if [ -n "${TOOLMENU_SCENARIO:-}" ]; then
  $CLI session --scenario "$TOOLMENU_SCENARIO" --format markdown --fail-on "$FAIL_ON" "${TARGET[@]}" > "$OUT/session.md" 2> "$OUT/session.err"
  code=$?; note "$code"
  if [ "$code" -eq 2 ]; then { echo "**Session didn't run:** $(head -3 "$OUT/session.err")"; echo; } >> "$BODY"; else { cat "$OUT/session.md"; echo; } >> "$BODY"; fi
fi

echo "<sub>[toolmenu](https://github.com/niksa90/toolmenu) · token counts are estimates</sub>" >> "$BODY"

[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$BODY" >> "$GITHUB_STEP_SUMMARY"
echo "report=$BODY" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "exit-code=$status" >> "${GITHUB_OUTPUT:-/dev/null}"

# 4. One PR comment, updated in place on every push.
if [ "${TOOLMENU_COMMENT:-true}" = "true" ] && [ -n "${TOOLMENU_PR:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
  existing=$(gh api "repos/$GITHUB_REPOSITORY/issues/$TOOLMENU_PR/comments" --paginate --jq ".[] | select(.body | contains(\"$MARKER\")) | .id" 2>/dev/null | head -1)
  if [ -n "$existing" ]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing" -F "body=@$BODY" > /dev/null || echo "::warning title=toolmenu::Couldn't update the PR comment (does the workflow have pull-requests: write?)"
  else
    gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$TOOLMENU_PR/comments" -F "body=@$BODY" > /dev/null || echo "::warning title=toolmenu::Couldn't post the PR comment (does the workflow have pull-requests: write?)"
  fi
fi

[ "$status" -ne 0 ] && echo "::error title=toolmenu::Findings at or above '$FAIL_ON' (or the server didn't start). See the job summary."
exit "$status"
