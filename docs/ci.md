# In CI: reports and formats

The GitHub Action's basic setup is in the [README](../README.md#in-ci-one-pr-comment), and
its inputs, auth, forks and pinning in [github-action.md](github-action.md). This page
covers the other outputs: code scanning, JUnit, the HTML page and the badge.

## In the Security tab: code scanning

With `sarif`, findings also go to GitHub code scanning: alerts in the Security tab,
each on the line of its tool in your `menu.json`, and a code scanning check on the pull
request. GitHub shows an alert inline in the pull request only when that line changed in
it, so most stay in the Security tab and the check. Run the workflow on pushes to your
default branch too, so GitHub has a base to compare a pull request's alerts with. Code scanning is free for public repositories; private ones need GitHub Advanced
Security.

```yaml
on:
  pull_request:
  push:
    branches: [main]              # the base GitHub compares a pull request's alerts with
permissions:
  contents: read
  pull-requests: write
  security-events: write          # to upload SARIF
steps:
  # … checkout, build, as above
  - uses: niksa90/toolmenu@v0.27.1
    with:
      command: node dist/server.js
      sarif: toolmenu-sarif
  - uses: github/codeql-action/upload-sarif@v4
    if: always()                  # findings fail the toolmenu step; upload them anyway
    with:
      sarif_file: toolmenu-sarif
```

Outside the Action: `toolmenu snapshot --sarif toolmenu.sarif -- node dist/server.js`
writes the file beside the usual report (`diff` and `session` take `--sarif` too), or
`--format sarif` prints it instead.

## Other CI systems: JUnit test reports

GitLab, Jenkins, Azure DevOps, CircleCI and Buildkite show JUnit XML as test results.
`--junit <path>` writes the findings of `snapshot`, `diff` or `session` as JUnit beside
the usual report (`--format junit` prints it instead). Each finding is a test case named
after its tool, in a class named after its rule (`toolmenu.diff.diff/removed`), so the
CI system tracks it across runs. Findings at or above `--fail-on` are failures, the rest
pass with their text, so the test report agrees with the exit code. A clean run is one
passing case.

```yaml
# .gitlab-ci.yml
toolmenu:
  image: node:22
  script:
    - npm ci && npm run build
    # Exit 1 means findings: keep going so both reports are written, then fail.
    - npx toolmenu snapshot --out new-menu.json --junit snapshot.xml -- node dist/server.js || code=$?
    - npx toolmenu diff menu.json new-menu.json --junit diff.xml || code=$?
    - exit ${code:-0}
  artifacts:
    when: always
    reports:
      junit: [snapshot.xml, diff.xml]
```

## A report to keep: HTML

`--html <path>` writes the run of `snapshot`, `diff` or `session` as one HTML page
beside the usual report: the numbers that matter at the top (errors, warnings, tools,
tokens; for `diff`, breaking changes and the suggested bump), the menu as a table in
server order with each tool's share of the tokens, and the findings with their next
steps. `diff` shows each tool before and after, new and removed tools marked. `session`
has a row per step with the menu after it, tools inserted, appended or edited marked,
and links from a step to its findings.

The page has no script and loads nothing, so it opens offline: keep it as a CI artifact
(GitLab `artifacts: paths`, `actions/upload-artifact`) or attach it to an issue for a
server's maintainer. It follows the viewer's light or dark setting.

```sh
npx toolmenu diff menu.json new-menu.json --html diff.html
```

## A badge for your README

```sh
npx toolmenu snapshot --badge toolmenu-badge.json -- node dist/server.js
```

writes a [shields.io endpoint](https://shields.io/badges/endpoint-badge) file (tools,
tokens, and errors or warnings, in red, yellow or green) and prints the README line
for it. Commit it with `menu.json`: it changes when the baseline does, so nothing
has to commit from CI. The badge at the top of the README is toolmenu's own MCP
server (`toolmenu mcp`), checked by itself.
