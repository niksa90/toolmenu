# The GitHub Action in detail

The basic setup and the inputs are in the [README](../README.md#in-ci-one-pr-comment).
This page covers what the basic setup doesn't: servers behind auth, servers that
unlock tools, PRs that run without your secrets, and where the Action gets Node.

## `command` or `url`

**`command` checks the PR's code; `url` checks whatever is deployed at that URL.**
With `command`, the job builds and starts the PR's version. With `url`, it connects
to the live server, usually production, so the report is about that server, not the
PR. To check the PR, either start the server inside the job and point `url` at
`http://localhost:…`, or point it at a per-PR preview deployment. And with `url` plus
a `scenario`, `session` calls that server for real on every push (read-only tools
only, unless the scenario sets `allow_writes`).

`headers` only applies to a `url` server and `env` only to a `command` server; the
Action warns if one is set for the other.

## The version check (`release: auto`)

Projects versioned only by git tags (Go, setuptools-scm) have no next version in a
PR, so `release: auto` has nothing to check there. Add `push: { tags: ['v*'] }` to
`on:` to get the bump checked when you tag.

In a monorepo, set `release` yourself: `auto` reads the version files at the repo root.
On a tag push, the Action compares the tag with the previous version tag, and only
tags like `v1.2.3` or `1.2.3` count. A tag like `mcp-v1.3.0` fails the check, since
there's no previous release to find: run the Action on pull requests only, or on
version tags only.

## Git history

The Action reads the baseline and the release versions from the PR's base branch
(or the previous tag), so it needs git in the job. Container images often lack it,
and without git `actions/checkout` downloads the files with no history. If the base
can't be fetched, the check fails rather than compare the PR with itself: install
git before `actions/checkout`, and keep the default `persist-credentials` on a
private repo.

## Checking an HTTP server behind auth

toolmenu has to talk to a running copy of your server. The simplest way to check a
pull request is to start that copy inside the job, from the PR's code, and point
toolmenu at it. The job starts the server, so the job also picks its key: make one
up. It's a throwaway copy that only lives for that job, so no real secret is involved.

```yaml
# .github/workflows/toolmenu.yml, in your MCP server's repository
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  toolmenu:
    runs-on: ubuntu-latest
    env:
      # Made up: only this job's copy of the server uses it. Your server must read
      # its key from MCP_API_KEY (or whatever variable it uses): that's the trick.
      MCP_API_KEY: ci-only-key
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - run: npm start &                # the PR's version, in the background (it keeps running for later steps)
      - run: npx --yes wait-on --timeout 60000 tcp:localhost:3000   # fail after 60 s instead of hanging
      - uses: niksa90/toolmenu@v0.7.1
        with:
          url: http://localhost:3000/mcp
          headers: "x-mcp-api-key: ${{ env.MCP_API_KEY }}"
          baseline: menu.json
```

Use your own start command, port and header name. If your server needs real
credentials just to list its tools, pass test ones the same way. Listing tools
usually doesn't touch the systems behind them.

## Servers that unlock tools

If your server starts with a core menu and adds tools on request (an unlock tool, a
`toolset` parameter, a mode switch in its environment), one configuration can't
check both things that matter. Use two:

- **The baseline is the full menu.** `diff` only compares the tools it sees. If the
  baseline holds the core menu alone, a renamed, removed or no-longer-read-only tool
  behind an unlock never reaches the report. Snapshot a configuration that serves
  every tool, and commit that as `menu.json`:

  ```sh
  npx toolmenu snapshot --env UNLOCK_MODE=all -- node dist/server.js
  ```

- **The session runs the default menu**, the one clients start with, so `session`
  sees each unlock happen: where the new tools land in the list, what they cost, and
  whether repeating an unlock changes nothing. A `session --init` scenario is a good
  start: it finds unlock tools and unlocks for real.

The Action runs its snapshot and its scenario with the same settings, so give it the
full menu and run the session as its own step:

```yaml
      - uses: niksa90/toolmenu@v0.7.1
        with:
          command: node dist/server.js
          env: UNLOCK_MODE=all        # every tool: this is what diff checks
          baseline: menu.json
      # The default menu, unlocked step by step. Findings show up as annotations
      # on the PR, and errors fail the job.
      - run: npx --yes toolmenu@0.7.1 session --scenario scenario.yml --format github -- node dist/server.js
```

`UNLOCK_MODE` stands for whatever switch your server has. The unlock calls in the
scenario are real, so the server needs whatever it needs to answer them in CI. Use
one Action step per job: steps in the same job update the same PR comment.

Expect `session/append` warnings: an append invalidates the cached conversation for
clients that send tools first. Once the server speaks 2026-07-28, unlocks that only
the unlocking connection sees are ruled out: an error over HTTP
(`session/connection-local`), a warning over stdio (`session/side-effect`, since each
stdio connection is its own process). On the 2025 versions they're allowed. That
error is the spec, not a false alarm.

## PRs from forks and Dependabot

**Pull requests from forks don't get your repository's secrets**
([GitHub docs](https://docs.github.com/actions/security-guides/using-secrets-in-github-actions)),
and Dependabot's only get Dependabot secrets
([GitHub docs](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions)),
so on a server behind auth the key in `headers` or `env` comes through empty. The
Action then skips the check with a note instead of failing the PR. It skips only
when a secret is plainly missing: an empty value, or a remote server answering
401/403. A 401 from a server inside the job (`localhost`, a service container) is
a setup mistake, and fails. The setup that works for
every PR is the one above: start the server inside the job (`command`, or `url`
pointing at `localhost`), which needs no secret and checks the PR's own code. Don't
switch to `pull_request_target` to get secrets: it runs the PR's code with them
([GitHub's guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)).

**A skipped check passes.** The Action exits 0, so branch protection sees a green
check even though nothing was checked. The PR comment and a notice say so, and the
`skipped` output is `'true'`. To make a skip fail instead, gate on it:

```yaml
      - uses: niksa90/toolmenu@v0.7.1
        id: toolmenu
        with:
          url: https://mcp.example.com/mcp   # a remote server that needs a key
          headers: "x-api-key: ${{ secrets.MCP_API_KEY }}"
      - if: steps.toolmenu.outputs.skipped == 'true'
        run: |
          echo "toolmenu was skipped: no secrets on this PR"
          exit 1
```

## Outputs

| Output | |
|---|---|
| `report` | Path to the markdown report |
| `exit-code` | `0` clean, `1` findings at or above `fail-on`, `2` couldn't run |
| `skipped` | `'true'` when the check was skipped for missing secrets |

## Node

toolmenu needs Node 22 or later. If the runner's Node is older or missing, the
Action downloads Node 22 from nodejs.org for toolmenu alone: your server and the
job's later steps keep the job's own Node. The download is integrity-checked
against nodejs.org's SHASUMS256.txt, which catches a corrupted download but not a
tampered one (the signature on that file isn't checked). If you'd rather not have
the Action download anything, add `actions/setup-node` with `node-version: 22`
before the Action.

**Alpine containers** need more. The Action runs with `bash`, which Alpine images
don't include, and Node's builds from nodejs.org (the ones `actions/setup-node`
installs too) don't run on Alpine. Install both from Alpine's own packages before
the Action, `apk add bash nodejs npm` (check that its `nodejs` is 22 or later), or
use a Debian-based image.
