# Changelog

## 0.12.0

- **`diff` is tested by mutation, on real menus:** `test/mutation.test.mjs` edits the
  schemas of five published servers (mongodb, Notion, Firecrawl, Playwright,
  Supabase) and the field report's document schema at every position `diff`
  compares, ten ways (enum narrowed or widened, type changed, field made required,
  removed or added, union option removed or reordered, block moved to `$defs`,
  description changed), and checks each gives exactly the rule and bump it should.
  About 3,100 mutations, every `npm test`. On 0.11.0's code (main at 089e184) 166 were
  misreported; all pass now. What the sweep found, fixed:
  - a property named `type` was read as the `type` keyword in the check that keeps
    changes from going unreported, so reordering its union's options was a false
    "review it";
  - a union option that is itself a union (a `$ref` to one) is compared as its
    options (Notion's `parent`);
  - an option edited beyond recognition (its type, its only field) is one change,
    not "removed" plus "added", and two options without properties have the same
    shape;
  - a union cut down to one option is compared with the option it was.
  The harness also checks that one edit is one finding, which caught this:
- **Fix, shared unions:** an option added to or removed from a union that fields of
  differently shaped objects share (a heading's content and a table cell's) was one
  finding per object. Findings about a union group by the union itself.
- **Union options, further:** an option that's an unexpanded `$ref` (a recursive
  definition past its unrolled level) no longer hides the others' discriminator
  (`type="paragraph"`, not `object{content,type} #1`); two objects with fields and
  none in common are one option replaced by another; matching options is a lookup,
  not a scan (1,500 changed options: under a second, was 36 s).
- **Too large to expand, both sides:** `$defs` entries are compared by name, so an
  enum narrowed inside one is still breaking; definitions only one side has are one
  line.
- **Checked on 14 public servers' releases (69 pairs) and their menus:**
  - **zod 3 → 4 spellings are the same schema:** `additionalProperties: {}` is
    `true`, and an integer's `maximum`/`minimum` of ±(2^53 − 1) (zod 4 adds them to
    every `.int()`) excludes nothing. chrome-devtools-mcp 1.9.0 → 1.10.1 goes from 61
    "review it" to one dialect notice.
  - **A description inside a nullable option** (`anyOf: [{type: string,
    description}, {type: null}]`, sentry-mcp) is compared, also when the field has
    a description of its own; one moved between the option and the node is no
    change.
- **zod 3 → 4 on an MCP SDK server** (27 constructs, zod 3.25 through the SDK's
  converter, `test/fixtures/zod`): from 2 errors and 40 notices to the real changes.
  - **`diff/properties-opened`** (minor) and **`diff/properties-closed`**
    (breaking): `additionalProperties: false` removed or added. zod 4 drops it from
    every object; that's one line for the menu ("27 tools now accept properties
    they don't list, at 35 places"), not a "review it" per object. The official
    `everything` server's 2026.7.4 release: 9 "review it" became that one line.
  - Absent, `true` and `{}` `additionalProperties` are one spelling, and
    `propertyNames: {type: "string"}` is dropped.
  - Still reported: `z.any()`/`z.unknown()` keys made required (breaking), and the
    patterns zod 4 adds to email, uuid and datetime, and a tuple's dropped bounds.
  - Several tools restructured or spelled differently but accepting the same
    input are one `diff/schema-equivalent` line.

- **Fix, `diff` on deep schemas:** the field-by-field comparison stopped 8 levels
  down, counting every array and union option, so one change to a definition a
  document schema's five block types share was an error for paragraphs and headings
  and a "review it" for lists, tables and quotes. The limit is 64, and a change past
  it says so. On mongodb-mcp-server 2.1.2 → 3.0.0 this finds `numCandidates` and
  `limit` narrowed to integer inside `explain` and `export` too, not only `aggregate`.
- **One change at several places is one finding:** the same change, to the same
  field, with the same schema before and after, inside objects that accept the same
  (one shared definition), is reported once: the headline names the first place, the
  detail the others, and `places` in `--json` has them all. Two independent `limit`
  parameters removed stay two findings.
- **Fix, `diff` on unions without a discriminator:** options were paired by position,
  so reordering a plain `z.union` of objects, or adding an option in front, read as
  four breaking changes. Identical options pair first, then by type and shared
  property names; an option with nothing in common is removed or added. Labels name
  an option by its shape (`object{path}`), not its position.
- **Fix, `diff` on very large schemas:** past 50,000 nodes of `$ref` expansion one
  side was compared unexpanded against the other, and read as "object → any". Both
  sides are now compared as written, with a notice saying why.

- **`diff` compares inside parameters:** fields of object parameters and of array
  items are compared at every depth, with the same rules and their path
  (`gen.body.text`). Before, a breaking change nested in a parameter was a
  "schema-other" notice and a patch bump.
- **`diff` expands local `$ref`s** before comparing. A block moved into `$defs` read
  as "type widened: object → any" on every parameter that used it, with a minor bump;
  it's now one `diff/schema-equivalent` notice with the token change. A breaking
  change inside `$defs` is breaking.
- **Repeated blocks inside one schema:** the token breakdown fingerprints every
  nested piece of every schema, and reports blocks repeated inside a tool (with what a
  `$defs` entry could save) as well as across tools. `repeated` in `--json` gains
  `count`, `within`, `withinTool`, `saving` and `where`.
- **Unused `$defs`:** the breakdown reports definitions nothing in the tool refers to
  (`unusedDefs` in `--json`).
- **`diff` compares union options:** `anyOf`/`oneOf` options (zod unions,
  discriminated unions, `.nullable()` on a non-primitive) are paired by discriminator
  value, else by type, and compared with every rule; an option removed is breaking,
  one added widens. An enum narrowed inside a union was a "review it" and a patch bump
  while the same change behind a plain `$ref` was an error. mongodb-mcp-server
  2.1.2 → 3.0.0: `numCandidates` and `limit` narrowed from number to integer, found.
- **Fix, `diff` and recursive schemas:** a recursive `$ref` kept `$defs` on both sides,
  so a refactor into `$defs` reported nothing at all, not even the promised
  `diff/schema-equivalent`. Recursion is unrolled one level and `$defs` dropped.
  And a schema change no rule classifies is now always a `diff/schema-other`.
- **`--auto` and open-world servers:** a read-only unlock runs without `--open-world`
  (it spends no search credits); other open-world tools still wait for the flag. A
  run that calls nothing is `session/nothing-called` (warn), with the reasons, not a
  clean pass; an unlock `--auto` skips is `session/unlock-coverage`, with why. Each
  unlock's first value is repeated, as in the `--init` starter.
- **`diff/schema-dialect`** (notice): only the declared `$schema` changed. Said once for
  every tool that switched: mongodb-mcp-server 3.0.0 moved 27 tools from draft-07 to
  2020-12, which read as 27 "review it" notices.

- **Fix, `init`:** only `--env` names that looked like credentials became secrets,
  so values like `DATABASE_URL` or `SENTRY_DSN` went into the workflow as text.
  Every value is a `${{ secrets.… }}` now; `GITHUB_*` names get an `MCP_` prefix
  (GitHub reserves them, and `secrets.GITHUB_TOKEN` is the job's own token). uv
  projects got `astral-sh/setup-uv@v10`, a tag that doesn't exist: now `v10.2.0`.
- **Fix, `session`:** a server that holds a file or a port can't start a second copy
  mid-session, and that ended the run with no report. The scope is left unchecked
  instead (`session/scope-unchecked`, info).
- **`menu/duplicate-name`** (error): two tools with one name. Such a menu was
  reported as `menu/nondeterministic`, which it wasn't.
- **`spec/tools-capability`** (error): a server that doesn't declare `tools`, which
  SDK clients never list. Its "0 tools" came with no reason, and the SDK's log line
  broke `--format json`; library logging goes to stderr now.
- **Fix, `description/buried`:** another tool's name counts only as a whole word
  (`search` isn't in "research").
- **Fix, `diff`:** a changed or added `const` is a breaking change, like a narrowed
  enum. Versions with trailing text (`1.2.3foo`) aren't read as semver.
- **Fix, `session --init`:** the regex that reads a tool's description for "loads
  more tools" held stray control bytes where `\b` belonged, so it never matched: an
  unlock tool was only found by its name. Descriptions count again (whole words),
  and `namespace` alone no longer marks a tool as an unlock (Kubernetes and Pinecone
  take one on every read).
- **Unlock detection, checked on live servers** (github-mcp-server 1.0.5
  `--dynamic-toolsets`, toolception 0.6.3, excalidraw-room-mcp staged tools, Serena,
  and the 22-server corpus): lookups like `get_toolset_tools` and `list_toolsets` no
  longer count as unlocks (one tied GitHub's `enable_toolset`); an unlock annotated
  destructive (toolception) is suggested instead of dropped; an unlock-named tool's
  one required parameter is its argument.
- **Every unlock value, not two:** `session --init` unlocks every value of an unlock
  (its enum, or, without one, the values the server's own read-only listing returns,
  like toolception's `list_toolsets`), and `session --auto` does the same outside the
  call budget. On github-mcp-server 1.0.5 `--dynamic-toolsets`, the union went from
  9 tools to 107: all 81 of `--toolsets all`, and 23 only the dynamic mode serves.
- **`session/unlock-coverage`** (warn): an unlock called with only some of its enum
  values, or, with `--union-out`, never called. The tools behind the rest aren't in
  the baseline, so `diff` can't check them.
- **Fix, `session` scope:** a step that takes the menu back to where it started (a
  room left, a toolset disabled) read as `global`. It's `unclear`: a fresh process
  starts there anyway.
- **`session/session-lost`** (error): a server that keeps one session per client
  ended toolmenu's when its second connection arrived, and every later step read as a
  server error, the calls as a "404 on the credentials". Now said once, and the run
  stops; `--processes 1` also turns off the scope probe, so the run completes.
- **Fix, `auth login` on Windows:** the browser opens without `cmd`, which cut the
  URL at its first `&`.

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
