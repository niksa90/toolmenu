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

# Connection options, one per line: HTTP headers ("Name: value", e.g. an API key
# from a secret) and environment variables for a stdio server ("KEY=value"). They
# go to the CLI as arguments and never into the report.
CONN=()
while IFS= read -r line; do [ -n "${line// }" ] && CONN+=(--header "$line"); done <<< "${TOOLMENU_HEADERS:-}"
while IFS= read -r line; do [ -n "${line// }" ] && CONN+=(--env "$line"); done <<< "${TOOLMENU_ENV:-}"
# Each only applies to one kind of server: say so instead of ignoring it quietly.
if [ -n "${TOOLMENU_URL:-}" ] && [ -n "${TOOLMENU_ENV:-}" ] && [ -n "${TOOLMENU_ENV//[[:space:]]/}" ]; then
  echo "::warning title=toolmenu::'env' only applies to a 'command' (stdio) server; it's ignored for 'url'."
fi
if [ -z "${TOOLMENU_URL:-}" ] && [ -n "${TOOLMENU_HEADERS:-}" ] && [ -n "${TOOLMENU_HEADERS//[[:space:]]/}" ]; then
  echo "::warning title=toolmenu::'headers' only applies to a 'url' server; it's ignored for 'command'. Use 'env' to pass keys to a stdio server."
fi

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
# The previous version tag before the tag being pushed, in version order.
previous_tag() {
  local tag="$1"
  git fetch --quiet --tags origin 2>/dev/null
  git tag --list --sort=-v:refname | grep -E '^v?[0-9]+\.[0-9]+' | grep -vxF "$tag" \
    | while read -r t; do [ "$(printf '%s\n%s\n' "$t" "$tag" | sort -V | tail -1)" = "$tag" ] && { echo "$t"; break; }; done
}

# The ref the baseline and the release versions come from: the PR's base branch,
# or the previous version tag on a tag push. Empty when neither applies.
base_ref() {
  if [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
    previous_tag "${GITHUB_REF#refs/tags/}"
  elif [ -n "${TOOLMENU_BASE_REF:-}" ] && git fetch --quiet --depth=1 origin "$TOOLMENU_BASE_REF" 2>/dev/null; then
    git rev-parse FETCH_HEAD
  fi
}

release_args() {
  local release="${TOOLMENU_RELEASE:-auto}"
  if [ "$release" = "off" ] || [ -z "$release" ]; then return; fi
  if [ "$release" != "auto" ]; then echo "--release $release"; return; fi
  local version="${TOOLMENU_VERSION_SCRIPT:-$(dirname "$0")/version.mjs}"
  local base="$BASE"
  [ -n "$base" ] || return
  if [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
    echo "--release $base..${GITHUB_REF#refs/tags/}"
    return
  fi
  local file before after
  for file in package.json pyproject.toml Cargo.toml; do
    [ -f "$file" ] || continue
    after=$(node "$version" "$file" < "$file")
    before=$(git show "$base:$file" 2>/dev/null | node "$version" "$file")
    if [ -n "$before" ] && [ -n "$after" ]; then echo "--release $before..$after"; return; fi
  done
}

# The menu to diff against: the baseline as it is on the base ref, so a PR that
# also commits its refreshed snapshot is still compared with what shipped.
# Falls back to the checked-out file.
set_baseline() {
  local file="${TOOLMENU_BASELINE:-menu.json}"
  BASELINE=""
  BASELINE_FROM=""
  if [ -n "$BASE" ] && git show "$BASE:$file" > "$OUT/baseline.json" 2>/dev/null; then
    BASELINE="$OUT/baseline.json"
    BASELINE_FROM="\`$file\` as of ${TOOLMENU_BASE_REF:-$BASE}"
  elif [ -f "$file" ]; then
    BASELINE="$file"
    BASELINE_FROM="\`$file\` in this checkout"
  fi
}

{
  echo "$MARKER"
  echo "## toolmenu"
  echo
} > "$BODY"

# The snapshot command for the "no baseline yet" hint: header names (never their
# values) and env names, so the command works on a server behind auth.
hint_target() {
  local line opts=""
  while IFS= read -r line; do [ -n "${line// }" ] && opts+="--header \"${line%%:*}: …\" "; done <<< "${TOOLMENU_HEADERS:-}"
  while IFS= read -r line; do [ -n "${line// }" ] && opts+="--env ${line%%=*}=… "; done <<< "${TOOLMENU_ENV:-}"
  if [ -n "${TOOLMENU_URL:-}" ]; then echo "$opts$TOOLMENU_URL"; else echo "$opts-- $TOOLMENU_COMMAND"; fi
}

# 1. Snapshot the menu this change produces.
$CLI snapshot --out "$OUT/current.json" --format markdown --fail-on "$FAIL_ON" "${CONN[@]}" "${TARGET[@]}" > "$OUT/snapshot.md" 2> "$OUT/snapshot.err"
code=$?
if [ "$code" -eq 2 ] && [ "${TOOLMENU_FORK_PR:-false}" = "true" ] && [ -n "${TOOLMENU_URL:-}" ]; then
  # Pull requests from forks don't get secrets, so a server behind auth can't
  # be reached. Say so and don't fail an outside contributor's PR for it.
  {
    echo "**Skipped: this pull request comes from a fork.** GitHub doesn't pass the repository's secrets to fork PRs ([GitHub docs](https://docs.github.com/actions/security-guides/using-secrets-in-github-actions)), so \`headers\` came through empty and the server couldn't be reached."
    echo
    echo "The fix that works for every PR: start the server inside the job with \`command\` (or \`url: http://localhost:…\`), so no secret is needed and the check runs against this PR's code. Avoid \`pull_request_target\` for this: it would run the PR's code with your secrets ([GitHub's guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target))."
    echo
  } >> "$BODY"
  echo "::notice title=toolmenu::Skipped on a fork PR: no secrets, so the server couldn't be reached."
elif [ "$code" -eq 2 ]; then
  { echo "**Couldn't snapshot the server.**"; echo; echo '```'; tail -20 "$OUT/snapshot.err"; echo '```'; } >> "$BODY"
  note 2
else
  note "$code"
  # 2. Compare with the baseline as it is on the base branch (or previous tag).
  BASE=$(base_ref)
  set_baseline
  if [ -n "$BASELINE" ]; then
    # shellcheck disable=SC2046
    $CLI diff --format markdown --fail-on "$FAIL_ON" $(release_args) "$BASELINE" "$OUT/current.json" > "$OUT/diff.md" 2> "$OUT/diff.err"
    code=$?; note "$code"
    if [ "$code" -eq 2 ]; then { echo "**Couldn't compare with the baseline:** $(head -1 "$OUT/diff.err")"; echo; } >> "$BODY"; else { cat "$OUT/diff.md"; echo; echo "<sub>Baseline: $BASELINE_FROM</sub>"; echo; } >> "$BODY"; fi
  else
    { echo "No baseline at \`${TOOLMENU_BASELINE:-menu.json}\`, so there's nothing to compare with yet. Commit the snapshot to start tracking changes:"; echo; echo '```sh'; echo "npx toolmenu snapshot $(hint_target)"; echo '```'; echo; } >> "$BODY"
  fi
  { cat "$OUT/snapshot.md"; echo; } >> "$BODY"
fi

# 3. Watch the menu during a scripted session.
if [ -n "${TOOLMENU_SCENARIO:-}" ]; then
  $CLI session --scenario "$TOOLMENU_SCENARIO" --format markdown --fail-on "$FAIL_ON" "${CONN[@]}" "${TARGET[@]}" > "$OUT/session.md" 2> "$OUT/session.err"
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
