# Changelog

## 0.11.0

- **`--catalog` crawls the catalog by its own names:** from the search tool's own
  example phrases and the menu's nouns, it searches for every operation found or
  mentioned, until 20 queries in a row find nothing new (at most 200). On
  Atlassian's hosted server: 154 of 154 operations, from 8. `catalog.crawl`,
  `catalog.maxQueries`, `catalog.stopAfter` in the config.
- **Fix:** a search result that is JSON followed by prose (Atlassian's `discover`)
  was dropped whole. The leading JSON is read, and operations named in the prose are
  followed.

## 0.10.0

- **`toolmenu init`:** snapshots the server into `menu.json` and writes
  `.github/workflows/toolmenu.yml` for the project it finds (Node, Python, Go,
  Rust), the Action pinned to this version. Credentials become `${{ secrets.… }}`,
  never values; it never overwrites a file.
- **Where the tokens go:** the snapshot report shows the biggest tools and their
  description/schema split, the largest enums, and parameters repeated across tools.
- **`snapshot --catalog`:** operations behind a search tool (search and execute:
  Sentry, Atlassian) are read with a fixed set of queries and kept in the menu file;
  `diff` compares them with the tool rules. Not found this time is a notice, never a
  breaking change. Paced, and rate limits are waited out.

## 0.9.0

- **OAuth:** `toolmenu auth login <url>` logs in to an OAuth-protected server once
  (browser, PKCE, a loopback redirect on a fixed port, `state` checked), and
  `snapshot` and `session` use the stored login, refreshing it as needed. `auth
  list`, `auth logout`, `--no-auth`; `--client-id`/`--client-secret` for servers
  without dynamic registration. Logins are stored per server, readable only by you,
  and bound to the authorization server that issued them.
- **`session --auto`:** steps built from the menu, no scenario: every read-only
  tool whose required arguments the schema gives, cheapest first, then the first
  call again. Never a guessed ID; tools marked `openWorldHint: true` only with
  `--open-world`; `--max-calls`, `--save-scenario`. The Action takes `scenario: auto`.
- **`session --union-out`:** every tool the session saw, as a menu file: the
  baseline for servers whose tools appear after an unlock. The Action's
  `baseline-from: session` diffs it, in one step.

## 0.8.0

Measured on 22 public servers before and after (`bench/`, FINDINGS F13).

- **`menu/process-variance`** (stdio) and **`menu/connection-variance`** (HTTP):
  `snapshot` starts a second server process or connection and compares menus. On the
  corpus it fires on exactly one server, mcp-atlassian 0.23.1, whose menu changes on
  every start. `--processes <n>` (default 2; `1` turns it off). `session` uses the
  same check and rules; `session/connection-variance` is renamed accordingly.
- **The main process runs with `PYTHONHASHSEED=0`** (unless you set it), so a Python
  server's saved menu is the same on every run and `diff` doesn't report its set
  order as a change. The second process gets another seed.
- **Findings say which value differs**, down to the leaf, and spot the same items in a
  different order ("same 11 items, different order: sort them").
- **`session/untested`**: calls that fail before reaching the tool (authentication,
  something missing on the machine, the network) are one finding for the run, a
  warning, or an error when no call got through. They no longer count as
  `session/tool-error` or `session/step-failed` per step.
- **Cache wording:** findings no longer say "~N tokens from position p on", which
  implied the prompt before p stayed cached. Any change to the tool list invalidates
  the cached prompt; findings say where the change starts and how big the tool list is.
- **Quieter heuristics:** `ids/authored` is `info` and one finding per kind of ID,
  knows `org`/`organization`-style abbreviations, and accepts "found in the URL" as a
  source; `naming/vague-id` no longer flags `ref`; the starter scenario doesn't take a
  search filter called `category` for an unlock.
- `bench/`: the corpus, a runner and a report, for measuring rule changes.

## 0.7.1

- **Token counts cover what the model reads**: each tool's name, description and
  input schema. 0.7.0 counted the whole tool definition, including output schemas,
  annotations, icons and `_meta`, which clients don't send the model. On GitHub's
  official server (embedded icons) that inflated the menu 5×: ~115K estimated, ~23K
  real. Baselines written by 0.7.0 are recounted when read, so `diff` compares them
  fairly with new snapshots.
- `diff`: a type written as `anyOf`/`oneOf` alternatives (`anyOf: [{type: string},
  {type: null}]`) is the same as `type: [string, null]`. Schema generators switch
  between the two; 0.7.0 reported it as a breaking type change.
- `diff`: a new required parameter that has a default says so.

## 0.7.0 (first release)

- `snapshot`: lists the menu twice, checks it against the official schema for its
  protocol version (2024-11-05 to 2026-07-28), and runs the menu rules: determinism,
  buried instructions, vague and invented IDs, unannotated writes, routing
  (`routes.yml`).
- `session`: runs a scripted session and reports every mid-session menu change with
  the step that caused it and where in the list it happened (any mid-session change
  to a tool list sent at the start of the prompt invalidates the cached conversation;
  appends are only cache-safe with tool search); flags per-connection changes ruled out by 2026-07-28. `--init` writes a
  starter scenario that finds unlock tools and unlocks for real.
- `diff`: breaking, minor and notice changes between two menus, the token change,
  and a suggested semver bump, checked against release versions (`--release`).
- `history`: installs, snapshots and diffs an npm package's published versions.
- GitHub Action: one PR comment, updated on every push, diffing against the
  baseline on the base branch (or the previous tag), with the version-bump check in
  any language (`release: auto`).
- Formats: text, json, github annotations, markdown.
- Needs Node 22 or later (Node 20 reached end of life in April 2026).
- The Action: `headers` and `env` for servers behind auth; PRs without secrets are
  skipped with a note.
- The Action runs the toolmenu release that matches its own tag by default
  (`version: latest` for the newest), so a pinned Action keeps its CLI.
- `ignore` in `diff` covers the token change and `tokenBudget` too.
