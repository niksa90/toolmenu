#!/usr/bin/env bash
# toolmenu GitHub Action: snapshot the server, diff against the committed
# baseline, optionally run a session scenario, then write one report to the job
# summary and (on pull requests) one PR comment that updates in place.
set -uo pipefail

# Outputs for a workflow that reads them with if: always(), even when the script
# stops early (no command or url, no Node 22).
OUTPUTS_WRITTEN=false
trap 'code=$?; [ "$OUTPUTS_WRITTEN" = true ] || printf "exit-code=%s\nskipped=false\n" "$code" >> "${GITHUB_OUTPUT:-/dev/null}"' EXIT

# toolmenu needs Node 22+. If the runner's Node is older (or missing), fetch
# Node 22 for toolmenu alone: it goes first on this script's PATH only, so the
# job's later steps and the server started by 'command' keep the job's own Node.
ORIG_PATH="$PATH"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
[[ "$node_major" =~ ^[0-9]+$ ]] || node_major=0
if [ "$node_major" -eq 0 ]; then node_label="no Node"; else node_label="Node $node_major"; fi
if [ "$node_major" -lt 22 ]; then
  node_dir="${RUNNER_TEMP:-/tmp}/toolmenu-node"
  # Fetched by an earlier toolmenu step in this job: reuse it.
  if ! "$node_dir/bin/node" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64) plat=linux-x64 ;; Linux-aarch64) plat=linux-arm64 ;;
      Darwin-x86_64) plat=darwin-x64 ;; Darwin-arm64) plat=darwin-arm64 ;;
      *) echo "::error title=toolmenu::toolmenu needs Node 22 or later, and this runner has $node_label. Install Node 22 before the Action (actions/setup-node, or your container's package manager)."; exit 2 ;;
    esac
    base="https://nodejs.org/dist/latest-v22.x"
    rm -rf "$node_dir" && mkdir -p "$node_dir"
    sums=$(curl -fsSL --retry 3 "$base/SHASUMS256.txt")
    file=$(awk -v p="-$plat.tar.gz" '$2 ~ p"$" {print $2; exit}' <<< "$sums")
    sum=$(awk -v f="$file" '$2 == f {print $1; exit}' <<< "$sums")
    if [ -z "$file" ] || [ -z "$sum" ] || ! curl -fsSL --retry 3 "$base/$file" -o "$node_dir/node.tar.gz" \
       || [ "$( (sha256sum "$node_dir/node.tar.gz" 2>/dev/null || shasum -a 256 "$node_dir/node.tar.gz") | awk '{print $1}')" != "$sum" ] \
       || ! tar -xzf "$node_dir/node.tar.gz" -C "$node_dir" --strip-components=1 \
       || ! "$node_dir/bin/node" -v > /dev/null 2>&1; then  # e.g. a glibc build on Alpine
      echo "::error title=toolmenu::Couldn't fetch Node 22 for toolmenu (the runner has $node_label). Install Node 22 before the Action (actions/setup-node, or your container's package manager)."
      exit 2
    fi
    rm -f "$node_dir/node.tar.gz"
  fi
  PATH="$node_dir/bin:$PATH"
fi

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
HEADERS_SET="${TOOLMENU_HEADERS:-}"; HEADERS_SET="${HEADERS_SET//[[:space:]]/}"
ENV_SET="${TOOLMENU_ENV:-}"; ENV_SET="${ENV_SET//[[:space:]]/}"
if [ -n "${TOOLMENU_URL:-}" ] && [ -n "$ENV_SET" ]; then
  echo "::warning title=toolmenu::'env' only applies to a 'command' (stdio) server; it's ignored for 'url'."
fi
if [ -z "${TOOLMENU_URL:-}" ] && [ -n "$HEADERS_SET" ]; then
  echo "::warning title=toolmenu::'headers' only applies to a 'url' server; it's ignored for 'command'. Use 'env' to pass keys to a stdio server."
fi

if [ -n "${TOOLMENU_URL:-}" ]; then
  TARGET=("$TOOLMENU_URL")
elif [ -n "${TOOLMENU_COMMAND:-}" ]; then
  # The server runs with the job's own PATH, not the one toolmenu got above.
  TARGET=(-- sh -c "PATH=$(printf %q "$ORIG_PATH"); export PATH; exec $TOOLMENU_COMMAND")
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

# Did the snapshot fail because a secret was missing? Only then is a PR without
# secrets skipped: a header or env value that came through empty (what an unset
# secret turns into, "Bearer" alone included), or a remote server answering
# 401/403. Anything else is a real failure.
missing_secret() {
  local line value
  while IFS= read -r line; do
    [[ "$line" == *:* ]] || continue
    value=$(echo "${line#*:}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    case "$value" in ''|bearer|basic|token) return 0 ;; esac
  done <<< "${TOOLMENU_HEADERS:-}"
  while IFS= read -r line; do
    [[ "$line" == *=* ]] && [ -z "$(echo "${line#*=}" | tr -d '[:space:]')" ] && return 0
  done <<< "${TOOLMENU_ENV:-}"
  [ -n "${TOOLMENU_URL:-}" ] || return 1
  # A 401/403 from a server started inside the job is a setup mistake, not a
  # missing secret: localhost, a loopback address, or a service container.
  # A host name without a dot is a guess at the last: an internal server on a
  # self-hosted runner reads the same, and then fails instead of skipping.
  # Only a remote server's refusal counts.
  local host
  host=$(echo "$TOOLMENU_URL" | tr '[:upper:]' '[:lower:]' | sed -E 's#^[a-z]+://([^/@]*@)?##; s#^(\[[^]]*\]|[^:/?\#]*).*#\1#; s#\.$##')
  if [[ "$host" =~ ^(localhost|.+\.localhost|127\.[0-9.]+|0\.0\.0\.0|\[::1?\]|\[::ffff:127\.[0-9.]+\]|[^.\[]+)$ ]]; then
    return 1
  fi
  grep -Eq '(^|[^0-9])(401|403)([^0-9]|$)|Unauthorized|Forbidden' "$OUT/snapshot.err" 2>/dev/null
}

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
SKIPPED=false
if [ "$code" -eq 2 ] && [ "${TOOLMENU_NO_SECRETS:-false}" = "true" ] && missing_secret; then
  # Pull requests from forks and Dependabot don't get the repository's secrets,
  # so a server that needs one can't be checked. Say so and don't fail the PR.
  SKIPPED=true
  {
    echo "**Skipped: this pull request runs without the repository's secrets.** GitHub doesn't pass them to PRs from forks ([GitHub docs](https://docs.github.com/actions/security-guides/using-secrets-in-github-actions)), and Dependabot PRs only get Dependabot secrets ([GitHub docs](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions)), so a key in \`headers\` or \`env\` came through empty or the server turned the check away."
    echo
    echo "The fix that works for every PR: start the server inside the job with \`command\` (or \`url: http://localhost:…\`), so no secret is needed and the check runs against this PR's code. Avoid \`pull_request_target\` for this: it would run the PR's code with your secrets ([GitHub's guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)). For Dependabot alone, adding the key as a Dependabot secret with the same name also works."
    echo
  } >> "$BODY"
  echo "::notice title=toolmenu::Skipped: this PR runs without the repository's secrets, so the server couldn't be reached."
elif [ "$code" -eq 2 ]; then
  { echo "**Couldn't snapshot the server.**"; echo; echo '```'; tail -20 "$OUT/snapshot.err"; echo '```'; } >> "$BODY"
  note 2
else
  note "$code"
  # 2. Compare with the baseline as it is on the base branch (or previous tag).
  BASE=$(base_ref)
  set_baseline
  # A PR whose base couldn't be fetched (no git in the job, or no access), or a
  # tag push outside a git checkout, would compare the change with itself.
  if [ -z "$BASE" ] && { [ -n "${TOOLMENU_BASE_REF:-}" ] || { [[ "${GITHUB_REF:-}" == refs/tags/* ]] && ! git rev-parse --git-dir > /dev/null 2>&1; }; }; then
    { echo "**Couldn't read the base branch, so there's nothing to compare with:** checking the change against its own \`${TOOLMENU_BASELINE:-menu.json}\` would hide every change. The Action needs git history in the job: see [docs/github-action.md](https://github.com/niksa90/toolmenu/blob/main/docs/github-action.md#git-history)."; echo; } >> "$BODY"
    echo "::warning title=toolmenu::Couldn't read the base branch (no git in the job, or no access to fetch it), so the menu wasn't compared. See docs/github-action.md#git-history."
    note 2
  elif [ -n "$BASELINE" ]; then
    # shellcheck disable=SC2046
    $CLI diff --format markdown --fail-on "$FAIL_ON" $(release_args) "$BASELINE" "$OUT/current.json" > "$OUT/diff.md" 2> "$OUT/diff.err"
    code=$?; note "$code"
    if [ "$code" -eq 2 ]; then { echo "**Couldn't compare with the baseline:** $(head -1 "$OUT/diff.err")"; echo; } >> "$BODY"; else { sed -e "s/pass --release/set the Action's \`release\` input/" -e "s/Check the --release order/Check the order in the Action's \`release\` input/" "$OUT/diff.md"; echo; echo "<sub>Baseline: $BASELINE_FROM</sub>"; echo; } >> "$BODY"; fi
  else
    { echo "No baseline at \`${TOOLMENU_BASELINE:-menu.json}\`, so there's nothing to compare with yet. Commit the snapshot to start tracking changes:"; echo; echo '```sh'; echo "npx toolmenu snapshot $(hint_target)"; echo '```'; echo; } >> "$BODY"
  fi
  { cat "$OUT/snapshot.md"; echo; } >> "$BODY"
fi

# 3. Watch the menu during a scripted session.
if [ -n "${TOOLMENU_SCENARIO:-}" ] && [ "$SKIPPED" = false ]; then
  $CLI session --scenario "$TOOLMENU_SCENARIO" --format markdown --fail-on "$FAIL_ON" "${CONN[@]}" "${TARGET[@]}" > "$OUT/session.md" 2> "$OUT/session.err"
  code=$?; note "$code"
  if [ "$code" -eq 2 ]; then { echo "**Session didn't run:** $(head -3 "$OUT/session.err")"; echo; } >> "$BODY"; else { cat "$OUT/session.md"; echo; } >> "$BODY"; fi
fi

echo "<sub>[toolmenu](https://github.com/niksa90/toolmenu) · token counts are estimates</sub>" >> "$BODY"

[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$BODY" >> "$GITHUB_STEP_SUMMARY"
echo "report=$BODY" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "exit-code=$status" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "skipped=$SKIPPED" >> "${GITHUB_OUTPUT:-/dev/null}"
OUTPUTS_WRITTEN=true

# 4. One PR comment, updated in place on every push.
if [ "${TOOLMENU_COMMENT:-true}" = "true" ] && [ -n "${TOOLMENU_PR:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
  existing=$(gh api "repos/$GITHUB_REPOSITORY/issues/$TOOLMENU_PR/comments" --paginate --jq ".[] | select(.body | contains(\"$MARKER\")) | .id" 2>/dev/null | head -1)
  if [ -n "$existing" ]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing" -F "body=@$BODY" > /dev/null || echo "::warning title=toolmenu::Couldn't update the PR comment: the token needs pull-requests: write (PRs from forks and Dependabot get a read-only one). The report is in the job summary."
  else
    gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$TOOLMENU_PR/comments" -F "body=@$BODY" > /dev/null || echo "::warning title=toolmenu::Couldn't post the PR comment: the token needs pull-requests: write (PRs from forks and Dependabot get a read-only one). The report is in the job summary."
  fi
fi

if [ "$status" -eq 2 ]; then
  echo "::error title=toolmenu::The check couldn't run: the server didn't start or couldn't be reached, or a baseline or scenario couldn't be read. See the job summary."
elif [ "$status" -ne 0 ]; then
  echo "::error title=toolmenu::Findings at or above '$FAIL_ON'. See the job summary."
fi
exit "$status"
