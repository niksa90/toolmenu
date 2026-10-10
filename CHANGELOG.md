# Changelog

## 0.14.1

- **diff: a recursive schema whose `definitions` moved to `$defs` with a new `$schema`
  is the dialect change, not a removed option.** 0.14.0 fixed this for schemas too
  large to expand; a recursive reference, which is unrolled once and then left as a
  `$ref`, still showed `no longer accepts #/definitions/x` as a false
  `diff/param-type` error beside the `diff/schema-dialect` notice. The pool spelling is
  now normalised, and an option really removed under the same move is still breaking.

## 0.14.0

A handshake flag for baselines, and two fixes found on real servers. Checked on the 22
bench servers (identical menus and findings against the build before these changes)
and on 37 more, where the Azure tool errors now show their reason.

- **`--protocol <auto|legacy|modern>`** (and `"protocol"` in the config file): which
  handshake to make. `auto` (the default) is as before. `legacy` makes the 2025
  handshake only, so a server that now serves both is still checked as a 2025 server
  and a baseline stays comparable. `modern` pins 2026-07-28 and fails, with a next
  step, when the server has no `server/discover`.
- **`session`:** a tool error that carries a JSON body is shown by its message, and
  `--json` keeps the tool's whole error text in `serverText`. The "isn't available
  here" hint no longer fires on the bare words permission or role.
- **`diff`:** for a schema too large to expand, `definitions` → `$defs` together with a
  changed `$schema` is the dialect change only. It no longer reads as a removed union
  option (an error) next to the dialect finding.

## 0.13.0

Every finding and error now says what's wrong, where, what toolmenu saw, and what to
do next. Checked on 70 server setups against 0.12.0: the same menus and tokens on all
61 that started, findings 406 → 291 with no real finding lost, and every one of the
291 with a next step.

- **Messages (SPEC §25):** findings gain `fix`, shown as `→ Next:` in text, markdown
  and GitHub annotations, and `confidence: "unsure"`, shown as `· unsure`, for
  heuristics and inferences, whose messages say what was seen rather than what it
  means. One root cause is one finding; the same change in many places is one finding
  that lists them. Text summaries lead with ✗ / ! / ✓.
- **Connection errors** say what failed, at which stage, what was seen and what to do:
  - stray stdout lines are quoted;
  - timeouts name the stage and each wait, and why stdio waits twice
    (`server/discover`, then `initialize`);
  - crashes give the exit code or signal and the last stderr lines, read to the end;
  - a server whose stderr says its key was rejected (401, Unauthorized,
    invalid_api_key) gets that in the headline, as a reading of its log;
  - a page that isn't an MCP endpoint gives its status, type and title, not its HTML;
  - DNS, refused, TLS and blocked-port failures are unwrapped from "fetch failed".

  A server that never answered is stopped at once. A mistyped option suggests the
  nearest one, and an unreadable menu file says why.
- **Per-command help:** `toolmenu <command> --help` (or `toolmenu help <command>`)
  shows that command's usage, options, examples and exit codes. `--help` is a short
  overview, and an unknown command lists the commands.
- **`init` makes a workflow that works on the runner:**
  - Paths in the command that are inside the repository become relative to where the
    server starts. An absolute program on PATH (node from nvm) is called by name.
    Paths outside the repository, `localhost` URLs, `--env` values that are local
    paths, and a virtualenv the runner lacks are listed under "Won't work in CI as
    written", each with what to do.
  - It can be run from a subfolder: `.github/` goes to the git root, the project file
    is found in a parent folder, and the server starts in CI where `init` ran. In a
    monorepo, packages install where their lockfile is and build in their folder, and
    `release` is off there.
  - The printed refresh command keeps `--env` and `--header`, with values as shell
    variables. Files the server needs that git doesn't have yet join the `git add`
    line.
- **`session --auto` reaches more tools:**
  - `--value name=value` (or `tool.param=value`, or `--values-file`) fills required
    parameters the schema has no value for.
  - `--assume-read-only a,b` calls named tools a server doesn't mark readOnlyHint.
    It takes exact names only, never a tool marked or named as a write, and is loud in
    the report (`session/assumed-read-only`).
  - On mcp-server-git 0 → 4 tools called, on DeepWiki 0 → 3.
  - A required list with no fillable item is "needs values", not `[]`, and a default
    that doesn't fit its type isn't used.
  - A call that runs out of toolmenu's `--timeout` says so and suggests a longer one,
    rather than blaming the server.
- **One finding per cause in `session`:**
  - The same tool error at several steps is one finding.
  - A mid-session change only in values that vary on every tools/list (PayPal 1.8.1's
    clock-built defaults) is `session/known-variance` (info), pointing to the finding
    that reported it.
  - `session/untested` gives a step for each failure class it saw.
- **`snapshot --catalog` reads command routers:** tools that take a `command` and its
  `parameters` and list their commands with a flag like `learn: true` (Azure's
  namespace mode).
  - Each router is called once in its listing mode, never with a command. Its
    operations land in the same catalog, so `diff` compares them.
  - On `@azure/mcp` 3.0.0-beta.47 that's 412 operations behind 65 routers, all real.
  - `catalog.routers` names routers that detection misses.
  - `catalog/read`, `catalog/failed` and `catalog/skipped` (info) say what was called,
    what came back and what failed.
- **`diff`:**
  - The same change in several tools is one finding that lists them (`tools`,
    `places`): chrome-devtools-mcp 1.8.0's 25 "pageId is new and required" rows are
    one. Counts are per change, and `classes` gives changes and tools touched per
    class.
  - Under 1.0.0 the bump check reads versions as npm's caret does: breaking changes
    need a minor bump, new features a patch. `requiredBump` and `releaseAs` are new in
    the JSON.
  - New `diff/param-renamed` (warn, unsure) flags a likely rename; both changes stay
    breaking.
  - Paths are code as they nest (`tool.param[](kind="x")`), also in `places`.
  - Reports lead with the changes and the version verdict, and markdown groups
    findings by class.
- **Snapshot rules:**
  - `write/unannotated` and `naming/vague-id` are one finding per menu (Miro's 53
    warnings become one), the latter with a suggested name.
  - New `description/late-instruction` (info) takes over the "instructions after
    character 280" hint from `description/cut`, and a setting for `description/cut`
    still applies to it.
  - Determinism findings name the value that differs and what kind of change it is,
    and variance findings with the same cause point to `menu/nondeterministic`.
  - `ignore`d tools are left out of summaries.
- **`history`:**
  - A failed version says what happened and what to try, and identical failures are
    one entry.
  - npm install failures show npm's own words.
  - `--format markdown` is a table; JSON rows gain `message`, `fix` and `confidence`,
    and the report gains `written`.
- **`auth`** messages say what failed and what to try. A stored login that can't be
  used says whether it never finished, expired, or was removed.
- **The token breakdown** gives units and a next step for unused `$defs`.
- **JSON:** new fields only. `places` in `diff` uses the path form above.

## 0.12.0

- **`diff` is tested by mutation, on real menus:** `test/mutation.test.mjs` edits the
  schemas of five published servers (mongodb, Notion, Firecrawl, Playwright,
  Supabase) and the field report's document schema at every position `diff`
  compares, ten ways (enum narrowed or widened, type changed, field made required,
  removed or added, union option removed or reordered, block moved to `$defs`,
  description changed), and checks each gives exactly the rule and bump it should.
  About 3,100 mutations, every `npm test`. On 0.11.0's code (main at 8b41fc2) 166 were
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
- **`session` and rate limits:** a request refused for being too many is waited out,
  2 s up to 32 s, and sent again, when that repeats nothing: connecting, listing, the
  list_changed subscription, the second connections that compare menus and check a
  change's scope, and a tool call the transport refused with a 429 (the server never
  ran it). A tool that says it was rate-limited, thrown or as its result, is called
  again only if it's marked readOnlyHint: it may have done part of the work first. A
  limit that outlasts the waits, or a write's, stops the run with one
  `session/rate-limited` (error) naming the steps that didn't run; one while
  connecting says so instead of the transport's error. A session and a scenario run
  back to back against a server with a per-IP limit was 19 errors, three for each
  refused step, and kept calling. An unlock the stopped run never got to isn't also
  `session/unlock-coverage`. "Order 429 not found" or "rateLimit must be a positive
  number" isn't a rate limit, for catalog either. `snapshot` (so the Action and
  `init`), `session --init` and `session --auto` wait out a refused connection and
  menu read the same way, and say what to do when it outlasts the waits instead of
  the transport's error.

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
