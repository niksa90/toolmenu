# Changelog

## 0.16.1

Fixes from a review of 0.15.0 and 0.16.0. Each has a regression test made from the
failure the review found. On 86 registry servers `snapshot` gives the same results
as 0.16.0, and on 39 servers on 2026-07-28 `session --auto` gives the same steps and
findings (see the release notes for the runs).

- **`snapshot` no longer crashes on a malformed `$ref`.** One bad percent-escape
  (`#/$defs/100%`) in any tool's schema aborted the whole run (0.16.0; the token
  breakdown had the same bug before). `spec/ref` and the breakdown now share one
  resolver: parameters named `default` or `examples` are checked, pointers resolve
  inside embedded `$id` resources, and draft-07 `#name` ids, `""` refs,
  `$dynamicAnchor`, anchors nested in a definition and refs to boolean schemas
  resolve; draft-07 `dependencies` is walked. A local `#…` ref that doesn't resolve
  is "points to nothing", never "a network URI", whatever the schema's `$id`.
- **`menu/gated` and `session/unlock-coverage` warn again** for a tool whose
  parameter is named for tool sets (`toolsets`), even when its description doesn't
  say it unlocks tools. 0.15.0's Garmin fix had silenced them too. `domains`,
  `capabilities`, `packs` and `bundles` still need the description to say so (a
  device's capabilities, a price bundle).
- **`session`, tools that ask for input:**
  - only the server's own JSON-RPC error to a retry that carried a decline is
    `session/decline-fails`. A timeout, a rate limit (429 or its words), a lost
    connection, the SDK rejecting a result the server did send, or an error after
    rounds where nothing was asked is a failed call, waited out or reported as usual;
  - `--json` keeps the server's message (first line) when a decline is refused;
  - rounds that carry only `requestState` are the tool still working, not
    questions; one that never ends (10 rounds, or 3 × the request timeout in all)
    is `session/input-loop`, worded as such, also after a question it took;
  - the same question again is a loop whatever its request key or wording; pages
    to open (URL mode) are the same question only when the URL is (its query, often
    a nonce, is ignored); an `input_required` round with nothing in it ends the call;
  - a tool error answering a decline is never counted as a setup problem ("the user
    declined to connect GitHub" isn't an authentication failure);
  - a call that never finished its input rounds is counted in the summary ("never
    finished"), and doesn't count as having unlocked anything;
  - elicitation is declared only by `session`: `snapshot` sees the same menu as
    before 0.16, even from a server that lists more tools to clients that can be
    asked things. `session --init` honours `--elicitation`.
- **Startup hints:** "memory usage 120MB" or an `Options: {…}` log line is no longer
  read as usage text; a docs or update link is no longer taken for the server's
  HTTP address; a subcommand is suggested only from where commands go in the help,
  never from an option's description, and the suggested command is the whole one.
  Wrapped description lines and log lines never offer one either; commander-style
  rows (`serve [options]`) do. A server that
  hasn't exited (timed out, or only closed its stdout) never gets "printed its usage
  and exited", and rejected credentials come first. Checked again on the 25 registry servers these
  hints came from: `agentation-mcp` now gets its real subcommand (`server`, not `mcp`).
- **`Unsupported platform: myspace`** is the tool's own error again, not a missing
  piece of this machine; only an operating system's name counts (`linux`,
  `Windows_NT`, `(darwin)`…), or the message ending right after "platform".
- **`x-mcp-header`:** a duplicate involving a `number` parameter is caught. New
  `diff/x-mcp-header-invalid` (warn): a 2026-07-28 release whose annotation makes
  HTTP clients drop the tool. A warning, not breaking, because a menu file doesn't
  say whether the server runs over HTTP; never for operations behind a search tool.
  Also raised for a server upgrading to 2026-07-28 and for tools a release adds.
- The SDK's "excluding tool" warning is held back only while toolmenu lists or calls
  tools (also in `catalog`, `--init` and auth checks), not for the whole process (it was global for anyone importing toolmenu);
  overlapping runs share the filter and leave `console.warn` as it was.
- The client-capability label no longer says "roots or sampling" when `-32021` names
  something else.


## 0.16.0

The 2026-07-28 standard, part one: the menu as compliant clients actually show it,
and tools that stop to ask the user something. Each rule ships with tests that run
a fixture server through the CLI and use the official SDK client as the referee.

- **`session`: tools that ask the user something (2026-07-28 multi round-trip
  requests).** A 2026 tool can stop mid-call and ask for input (`input_required`):
  a form, a URL to open, or roots or sampling. toolmenu used to report every one as a
  failed call. It now declares elicitation, declines every request (the same answer
  every run, no LLM; `--elicitation cancel` for the other one), sends the tool's
  `requestState` back byte for byte and calls again, and reports what happened:
  - `session/input-required` (info): which tools asked, for what, and how they
    answered the decline.
  - `session/input-loop` (warn): a tool that asks the same thing again after a
    decline, so an agent whose user says no is stuck.
  - `session/decline-fails` (warn): a decline that gets a protocol error back
    instead of a result the model can read.
  - `session/undeclared-input` (warn): a server that asks for roots or sampling the
    client didn't declare, instead of returning `-32021`.
  - `session/result-type` (error): a result without `resultType`, which the official
    SDK client rejects.

  `-32021` is read by its code as a setup problem, with the capability it names.
  Roots and sampling stay undeclared: 2026-07-28 deprecates them. On
  `@modelcontextprotocol/server-everything` 2.1.0 all three elicitation tools take the
  decline and answer.
- **New rule `spec/x-mcp-header` (2026-07-28): tools that HTTP clients must hide.** A
  parameter can be mirrored into an `Mcp-Param-*` HTTP header, and Streamable HTTP
  clients **must** drop any tool whose annotation breaks the spec's rules: empty,
  not a valid header name, used twice, on an object or array or a parameter with
  no single type, or reached through anything but `properties`. The official SDK
  client drops it with only a console warning, so neither the agent nor the
  server's author sees it go. toolmenu reads the list off the wire, so it still
  sees the tool, and says which annotation is broken and why. Error over HTTP,
  warning over stdio. `number` is a warning everywhere: the spec forbids it, the SDK
  client accepts it for now. The tests run a real SDK client against a fixture
  server and check that the errors are exactly the tools it drops.
- **New rule `spec/ref` (2026-07-28): `$ref`s clients can't resolve.** Clients must
  not fetch a network URI, so a `$ref` has to point inside the schema. In an output
  schema, one that doesn't fails every call to the tool in the official SDK client
  ("has an invalid outputSchema"), however well the server answers: an error. In an
  input schema, a ref to nothing is an error (the schema isn't valid), a network URI
  a warning (clients should reject it). `#/$defs`, `#anchor`, `$id` and `#` refs
  resolve. None of the 788 `$ref`s in the scan corpus is broken; the tests serve
  each case from a fixture and check the SDK client's behaviour.
- **Token breakdown:** a `$defs` entry named by its `$anchor` or `$id` is no longer
  counted as unused.
- **`diff/x-mcp-header`:** a header added, removed or renamed between releases is
  said as such, with the old and new `Mcp-Param-*` name, instead of "changed in
  keywords toolmenu doesn't classify".
- The SDK client's own "excluding tool" warnings no longer clutter toolmenu's
  stderr: the finding says the same, once.

## 0.15.0

Fixes and one new rule, from starting ~235 servers: the recent npm and PyPI servers in
the official MCP registry, and the 60 most-downloaded npm MCP packages. On 86 recent
registry servers, `snapshot` gives the same tool counts, tokens and findings as 0.14.1,
apart from the new rule's 14 info findings and one false positive gone (Garmin's
`menu/gated`).

- **New rule `search/findable` (info): can an agent find each tool by searching?**
  Clients that defer a large menu (Claude's tool search, OpenAI's `tool_search`,
  Claude Code's deferred MCP tools) let the model search it, and a search returns 5
  tools unless the model asks for more. For menus of 10+ tools and 10K+ tokens (or
  30+ tools), toolmenu ranks every tool the way a BM25 tool search does, over its
  name, description, argument names and argument descriptions, and lists the ones
  that a search for their own name doesn't put in the top 5. With `routes.yml`, a
  `must_match` tool past the top 5 for its keyword is a warning. It flagged tools on
  14 of the 26 registry servers large enough to defer: Porkbun's `list_domains` comes
  37th for "list domains", behind tools whose 5,000-character descriptions say
  "domain" again and again. No LLM: the ranks are deterministic, but a client's own
  search can rank a little differently, so findings are unsure.
- **A server that doesn't start gets the right next step.** These were the commonest
  ways a first run failed:
  - **A CLI that prints its usage and exits** is now said to be one, with the
    subcommand its usage lists: `Its usage lists “mcp”: try hashgrid mcp` (also
    `mcp start`, `server start`, `serve`, …). Before, toolmenu told it to log to
    stderr, the wrong fix for about 25 of the servers that didn't start. Following
    the new hint started 6 of 10 of them, Azure MCP (73 tools) among them.
  - **A server that opens an HTTP port instead of talking on stdio**
    (`@modelcontextprotocol/server-pdf`, `figma-developer-mcp`) is told so, with the
    address it printed: start it in stdio mode, or run toolmenu against the URL.
- **`session`: fewer setup problems reported as the server's fault.**
  - A tool that asks the client for roots, sampling or elicitation, which toolmenu
    doesn't provide, counts toward `session/untested`. Before, it was a
    `session/step-failed` error: `@modelcontextprotocol/server-everything`'s
    `get-roots-list` failed the run.
  - "Admin auth is missing" and "Runtime credentials are missing" (securenow) are
    credential problems, so they count toward `session/untested` instead of failing
    the run.
  - A server that says it can't run on this operating system ("Editmamei runs on
    Windows and macOS; this process is on "linux"", "Unsupported platform: linux")
    counts toward `session/untested` (something missing on this machine), as one
    finding for the run, not a `session/tool-error` per call.
- **`session`: a long path in an error loses its middle, not its end.** A step's error
  is cut at 120 characters, and a long path pushed out what came after it: “spawn
  /tmp/…/scratch…” hid both the missing binary and the `ENOENT`. Absolute paths over 40
  characters are now kept to their last two parts when the text is too long (“spawn
  …/bin/editmamei-core-linux-x64 ENOENT”). URLs keep their paths.
- **False positives fixed.**
  - `menu/gated` and `session/unlock-coverage` need the tool's name or description to
    say it unlocks tools before an enum of domains counts: garmin-insights'
    `garmin_sync { domains: [sleep, hrv, …] }` downloads data. `session --auto` still
    tries such a tool once.
  - `ids/authored`: `viewUUID` is a view's ID. The kind came out as "view_uu", so the
    finding named it wrongly and missed `display_pdf`'s output schema, which returns
    `viewUUID` (server-pdf).
- **Docs:** the plan for 0.15 → 0.19, the 2026-07-28 standard
  (`docs/plans/0.15-2026-readiness.md`). SPEC §1: a rule also earns its place when a
  2026-07-28 MUST makes compliant clients hide, reject or misread part of the menu.

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
