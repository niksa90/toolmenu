# Findings

A research log: what toolmenu found on real, public MCP servers. Every entry says
when it was checked and how to reproduce it. Servers are named on purpose: the
data is public and anyone can re-run it.

**Corrected 2026-09-28:** toolmenu 0.7.0 counted every field of a tool definition as
tokens, including output schemas, annotations and icons that clients don't send the
model. Token numbers in F6, F10 and F11 are recounted with 0.7.1, and F11 is re-run;
what changed is in F7, items 7 and 8.

**Caveat for every entry:** installing an old version today resolves its
dependencies *today* (see F4). So these describe "this version as installed on the
date shown", not necessarily what users got when it shipped.

Setup (toolmenu from this repo, `npm run build`, in a container: `history` installs
and runs third-party packages):

```sh
# the whole release history in one go
toolmenu history @modelcontextprotocol/server-filesystem --versions 19 --arg /tmp --csv fs.csv

# or by hand, one version
mkdir -p fs/$V && cd fs/$V && npm init -y && \
  npm i --ignore-scripts @modelcontextprotocol/server-filesystem@$V && cd ../..
toolmenu snapshot --out fs/$V.json -- fs/$V/node_modules/.bin/mcp-server-filesystem /tmp
toolmenu diff fs/$OLD.json fs/$NEW.json
```

---

## F1. The official reference servers don't speak 2026-07-28 yet

*Checked 2026-09-27, two months after the 2026-07-28 spec release.*

| Server (npm) | Protocol it speaks | SDK dependency |
|---|---|---|
| `@modelcontextprotocol/server-filesystem@2026.8.31` | 2025-11-25 | `@modelcontextprotocol/sdk ^1.30.0` (v1) |
| `@modelcontextprotocol/server-everything@2026.8.31` | 2025-11-25 | `@modelcontextprotocol/sdk ^1.30.0` (v1) |

Both answer the 2025 `initialize` handshake and have no working `server/discover`.
toolmenu reports it as `spec/discover` (info).

Reproduce: `toolmenu snapshot -- npx -y @modelcontextprotocol/server-filesystem@2026.8.31 /tmp`
(install first if `npx` is slow; see the setup above).

## F2. Getting to 2026-07-28 takes two steps, and the first one is a rename

- The package most people know, **`@modelcontextprotocol/sdk` (latest 1.30.1), tops
  out at 2025-11-25.** 2026-07-28 support lives in the v2 packages under new names:
  `@modelcontextprotocol/client` and `@modelcontextprotocol/server` (2.1.0), whose
  README says v2 "is the stable release line, implementing the 2026-07-28 MCP spec".
- **Upgrading isn't enough on its own.** A v2 server wired the old way,
  `server.connect(new StdioServerTransport())`, still only speaks 2025. You get
  2026-07-28 through the new entry points: `serveStdio(factory)` for stdio,
  `createMcpHandler(factory)` for HTTP. (toolmenu's own first test server hit this.)
- A trap for anyone checking by hand: v2's exported `LATEST_PROTOCOL_VERSION` is
  still `'2025-11-25'`. That constant only covers the legacy `initialize` list. The
  2026 versions are in a separate internal list, negotiated via `server/discover`.

Reproduce: `npm view @modelcontextprotocol/sdk version`,
`npm view @modelcontextprotocol/client version`, and the fixtures in
`test/fixtures/sdk-server.mjs` (with and without `LEGACY=1`).

## F3. Official SDK v2 servers say "don't cache this" by default

A v2 server built with `serveStdio` or `createMcpHandler` and no cache settings
returns `ttlMs: 0` and `cacheScope: "private"` on `tools/list`. `ttlMs: 0` means
"immediately stale": clients may re-fetch the list every time. It's valid per
spec, but it's the opposite of what a stable tool menu wants. toolmenu reports it
as `spec/cache-hints` (info) and says it's the SDK default.

Reproduce: `toolmenu snapshot -- node test/fixtures/sdk-server.mjs`.

## F4. The same published version can serve a different menu depending on install date

*Checked 2026-09-27.* Installed today, **10 of the 19 releases** of
`@modelcontextprotocol/server-filesystem`, every one from 0.5.1 (Nov 2024) through
2025.8.21 (Aug 2025), serve all but one of their tools with an **empty input
schema**: the whole schema is `{"$schema": "http://json-schema.org/draft-07/schema#"}`,
with no `type` and no `properties`. Only `list_allowed_directories` (hand-written
schema) survives. 2025.11.25 is the first clean release.

Why: these releases build their schemas with `zod-to-json-schema` 3.x, which
returns an empty schema when handed a zod 4 schema. And zod 4 gets in through
ranges resolved today:

| Releases | How zod 4 gets in |
|---|---|
| 0.5.1 – 0.6.2, 2025.1.14, 2025.3.28 | SDK pinned exactly (0.5.0 or 1.0.1, zod 3), but `zod-to-json-schema ^3.23.5` now resolves to 3.25.2, which brings its own **zod 4.6.5** |
| 2025.7.1 – 2025.8.21 | no direct `zod` dependency; `@modelcontextprotocol/sdk ^1.12.3` / `^1.17.0` resolves to 1.30.1, which brings **zod 4.6.5** |

What that means:
- An agent sees tools with no parameters at all.
- The result fails the official schema for its protocol version (`inputSchema`
  requires `type: "object"`), and **the official v2 client rejects the whole
  `tools/list` result**. toolmenu still reads it off the wire and reports `spec/schema`.
- The packages didn't change. Their dependency resolution did.

For toolmenu: this is a menu changing "at the wrong time" with no release at all.
`history` now records the declared and the resolved (installed today) versions of
the SDK, zod and zod-to-json-schema for every release.

Reproduce:
`toolmenu history @modelcontextprotocol/server-filesystem --versions 19 --arg /tmp`
(then look at `resolved` in `history.json`), or install one version by hand and run
`npm ls zod zod-to-json-schema`.

## F5. A server's self-reported version can't be used for semver checks

All 19 npm releases of the filesystem server, from 0.2.0 (2024-11-21) to 2026.8.31
(2026-08-31), report the same `serverInfo.version`: **`0.2.0`**.

For toolmenu:
- `diff` used to check the bump against the versions in the snapshots, so on raw
  snapshots every release tripped `diff/version-bump` ("version stayed 0.2.0").
  That's accurate about `serverInfo`, but it's not the version people install. Since
  0.7, `diff` keeps the two apart: the **release version** (npm, a git tag, passed with
  `--release`) is what the bump is checked against, and the **server-reported
  version** (`serverInfo.version`) is only shown, unless `--server-version-is-release`.
- `history` compares by **npm version**, and calendar versions (2026.8.31) are
  treated as carrying no compatibility promise.

## F6. One server's menu, release by release

`toolmenu history @modelcontextprotocol/server-filesystem --versions 19 --arg /tmp`,
run 2026-09-27 (26 s for the last 5 versions, about 2 min for all 19). Token counts
recounted 2026-09-28 with 0.7.1, which counts only what the model reads (F7, item 7):

```
  version     published   protocol         tools  tokens  sdk     zod            findings      vs previous
  0.2.0       2024-11-21  failed: crashed                 0.5.0   3.25.76
  0.3.0       2024-11-21  failed: crashed                 0.5.0   3.25.76
  0.5.0       2024-11-25  failed: crashed                 0.5.0   3.25.76
  0.5.1       2024-11-25  2024-11-05       9      ~674    0.5.0   3.25.76+4.6.5  1 err 3 warn  —
  0.6.0       2024-12-03  2024-11-05       9      ~674    1.0.1   3.25.76+4.6.5  1 err 3 warn  ±0 tokens · no changes
  0.6.1       2024-12-03  2024-11-05       9      ~674    1.0.1   3.25.76+4.6.5  1 err 3 warn  ±0 tokens · no changes
  0.6.2       2024-12-04  2024-11-05       9      ~674    1.0.1   3.25.76+4.6.5  1 err 3 warn  ±0 tokens · no changes
  2025.1.14   2025-01-14  2024-11-05       11     ~833    0.5.0   3.25.76+4.6.5  1 err 4 warn  +159 tokens · 2 minor
  2025.3.28   2025-03-28  2024-11-05       11     ~833    0.5.0   3.25.76+4.6.5  1 err 4 warn  ±0 tokens · no changes
  2025.7.1    2025-07-01  2025-11-25       12     ~951    1.30.1  4.6.5          1 err 4 warn  +118 tokens · 1 minor · 1 notice
  2025.7.29   2025-07-31  2025-11-25       14     ~1,062  1.30.1  4.6.5          1 err 4 warn  +111 tokens · 2 minor · 2 notice
  2025.8.18   2025-08-18  2025-11-25       14     ~1,074  1.30.1  4.6.5          1 err 4 warn  +12 tokens · 1 notice
  2025.8.21   2025-08-21  2025-11-25       14     ~1,074  1.30.1  4.6.5          1 err 4 warn  ±0 tokens · no changes
  2025.11.25  2025-11-25  2025-11-25       14     ~1,640  1.30.1  4.6.5          clean         +566 tokens · 57 notice
  2025.12.18  2025-12-18  2025-11-25       14     ~1,640  1.30.1  4.6.5          clean         ±0 tokens · no changes
  2026.1.14   2026-01-14  2025-11-25       14     ~1,640  1.30.1  4.6.5          clean         ±0 tokens · no changes
  2026.7.4    2026-07-04  2025-11-25       14     ~1,640  1.30.1  4.6.5          clean         ±0 tokens · 1 breaking
  2026.7.10   2026-07-10  2025-11-25       14     ~1,664  1.30.1  4.6.5          clean         +24 tokens · 16 notice
  2026.8.31   2026-08-31  2025-11-25       14     ~1,664  1.30.1  4.6.5          clean         ±0 tokens · no changes
```

What stands out:
- **The menu an agent loads grew 2.5×** from the first release that runs today to the
  latest (~674 → ~1,664 tokens per conversation, estimate). The biggest single jump
  is 2025.11.25 (+566): `read_text_file` and `read_media_file` added, `read_file`
  kept but marked "DEPRECATED: Use read_text_file instead", and longer descriptions.
  The same release added output schemas and annotations across the menu, which
  clients keep and don't send the model. (0.7.0 counted those too and reported
  +1,564 and 4.2×.)
- **The one breaking-class change is in 2026.7.4:** `move_file`'s
  `destructiveHint` went `false` → `true`, with no token change and nothing in the
  version number to signal it. Clients that auto-approve additive-only tools would
  have stopped doing so for `move_file`.
- **2026.7.10** added `openWorldHint: false` to all 14 tools and widened
  `read_media_file` to any file type (+24 tokens; 0.7.0 said +183, counting the
  annotations the model never sees).
- **The protocol a release speaks depends on today's install**, not its publish
  date: 2025.7.1 (July 2025) speaks 2025-11-25 because its SDK range resolves to
  1.30.1 today.
- The SDK pin went **backwards** once: 0.6.x pinned SDK 1.0.1, 2025.1.14 pinned 0.5.0.

## F7. What toolmenu got wrong on the first real run (fixed)

The first `diff` run on these releases produced misleading output. Recorded here
because the fixes came from real data:

1. **17 false "breaking" changes** (2025.7.1 → 2025.11.25): every parameter looked
   "new and required" because the old schemas were empty (F4). Now `diff` reports
   an empty or invalid schema as unclassifiable instead of guessing.
2. **"write_file is now marked destructive"** was wrong. The old version had no
   annotations, and MCP's defaults (`readOnlyHint: false`, `destructiveHint: true`)
   already made it destructive. `diff` now compares effective hints after
   defaults.
3. **A silent change to every tool** (2026.1.14 → 2026.8.31: `openWorldHint` added)
   had no matching finding: `diff` only looked at two safety hints. It now reports
   every annotation change (`diff/annotations`) and any other changed field
   (`diff/other`).

4. **2025.1.14's empty schemas went unreported** because toolmenu had no schema
   for protocol 2024-11-05 and skipped the check. It now bundles the official
   schemas for 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25 and 2026-07-28
   (draft-07 and draft 2020-12), from the same pinned commit.

5. **`history` first reported the three crashes with a useless stack frame**
   ("at ModuleLoader.getModuleJobForImport…"). It now keeps the lines that say what
   went wrong (F8).

6. **The ID and naming heuristics were noisy on real menus** (F10): `uid` read as
   "u" + "id", keyboard `key`s read as identifiers, `status` "singularised" to
   `statu`, tool-name prefixes like `API-` and `firecrawl_` hiding verbs or counted
   as shared nouns, and 18 separate dry-run notes for one browser server. On ten
   real servers, `ids/authored` went from 48 findings to 4, `naming/shared-word` from
   19 to 7, and `write/no-dry-run` from 70 to one line per server.

7. **Token counts included what the model never reads** (fixed in 0.7.1, found
   running 25 servers on 2026-09-28, F12). 0.7.0 counted the whole tool definition.
   Clients send the model a tool's name, description and input schema; output
   schemas, annotations, icons, `title` and `_meta` stay with the client. The error
   was largest where it mattered most: GitHub's official server embeds an icon in
   every tool, so its full menu read ~115,000 tokens instead of ~23,000. It also
   invented findings: Firecrawl 3.25.5's "+6,300 tokens in a patch release" was
   output schemas (the real change: −110), and several "grew N×" claims in F6, F10
   and F11 were annotations and output schemas.
8. **A type written two ways was a breaking change.** Sentry 0.38.0's schemas went
   from `anyOf: [{type: string}, {type: null}]` to `type: [string, null]` (a zod
   upgrade), the same thing. `diff` read only `type` and reported "any →
   null|string" as breaking. Simple `anyOf`/`oneOf` type alternatives now count as
   the type.

All of these are covered by tests, most using the real menus in `test/fixtures/menus/`.

## F8. The first three releases can't start: an undeclared dependency

`@modelcontextprotocol/server-filesystem` 0.2.0, 0.3.0 and 0.5.0 (November 2024)
crash on start when installed today:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod-to-json-schema'
imported from …/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js
```

They import `zod-to-json-schema` without declaring it; their only dependency is
`@modelcontextprotocol/sdk 0.5.0`. 0.5.1, published the same day as 0.5.0, adds
`zod-to-json-schema ^3.23.5`. (They may have worked in the monorepo at the time, via
a hoisted copy; from npm they don't.) `history` records these as `failed: crashed`
with the cause.

## F9. The unlock pattern, on the official SDK v2: allowed on stdio, a silent no-op on HTTP

*Checked 2026-09-27 with `@modelcontextprotocol/server` 2.1.0.* The same server code,
a tool that calls `enable()` on hidden tools (the "unlock" pattern behind the 40–57K
tokens in lesson 05), behaves in two opposite ways depending on transport:

- **stdio (`serveStdio`), 2026-07-28:** it works. The call inserts two tools in the
  middle of the menu for that connection, and the server sends
  `notifications/tools/list_changed`. So the SDK doesn't stop the pattern that
  2026-07-28 rules out ("MUST NOT vary … as a side effect of other requests on the
  connection"). toolmenu reports `session/mid-insert` plus `session/side-effect`.
- **Streamable HTTP (`createMcpHandler`), 2026-07-28:** the SDK builds a fresh
  server instance for every request (4 factory calls for 3 requests in the
  experiment). The unlock call **returns success, "unlocked audits", and the next
  `tools/list` is unchanged**. State kept on the instance is simply gone. toolmenu
  sees "no change". There's no error for the agent or the developer to notice.
- **HTTP with state kept outside the instance** (shared across requests): the
  change is visible to every connection (toolmenu: scope `global`), but **no
  `list_changed` notification arrives**, although the server declares
  `listChanged: true`: the instance that changed the menu isn't the one holding the
  `subscriptions/listen` stream. toolmenu reports `session/unannounced`.
  **The fix is one line:** call `handler.notify.toolsChanged()` (the handler
  `createMcpHandler` returns) wherever the tool set changes. With it, the
  notification reaches the open `subscriptions/listen` stream and
  `session/unannounced` goes away (checked 2026-09-27, same fixture). The SDK
  doesn't infer it from `enable()` or `registerTool()` on a per-request instance;
  on stateless HTTP the server has to say so itself.

For the article: moving a stateful MCP server to the stateless protocol doesn't
fail loudly. The same code keeps "working" on stdio and quietly stops working on
HTTP.

Reproduce: `test/fixtures/session-server.mjs` and the HTTP cases in
`test/session.test.mjs`, or
`toolmenu session --scenario examples/unlock.scenario.yml -- node test/fixtures/session-server.mjs`.

## F10. Ten popular MCP servers, as installed from npm

*Checked 2026-09-27.* `toolmenu snapshot` on the latest npm version of each, over
stdio, with dummy credentials where a server wanted one at start-up. (A dummy
token is enough to list tools; none of them checked it before answering
`tools/list`.) `@supabase/mcp-server-supabase` 0.13.0 couldn't be included then; with network access
it lists its 29 tools on a dummy token (F12).

| Server (npm) | Built on | Protocol | Tools | Menu size (est., recounted with 0.7.1) |
|---|---|---|---|---|
| `@upstash/context7-mcp@4.1.1` | `@modelcontextprotocol/server` 2.0.0 (v2) | **2026-07-28** | 2 | ~983 |
| `@modelcontextprotocol/server-memory@2026.8.31` | sdk ^1.30.0 | 2025-11-25 | 9 | ~900 |
| `@modelcontextprotocol/server-sequential-thinking@2026.8.31` | sdk ^1.30.0 | 2025-11-25 | 1 | ~863 |
| `@playwright/mcp@0.0.82` | bundled | 2025-11-25 | 25 | ~3,725 |
| `chrome-devtools-mcp@1.10.1` | bundled | 2025-11-25 | 30 | ~5,537 |
| `@notionhq/notion-mcp-server@2.5.2` | sdk ^1.29.0 | 2025-11-25 | 24 | ~17,161 |
| `@sentry/mcp-server@0.42.0` | sdk 1.30.0 | 2025-11-25 | 9 | ~5,497 |
| `firecrawl-mcp@3.25.5` | fastmcp 4.3.2 | 2025-11-25 | 29 | ~11,481 |
| `mcp-server-kubernetes@4.1.7` | sdk 1.26.0 | 2025-11-25 | 23 | ~5,088 |
| `@modelcontextprotocol/server-github@2025.4.8` (archived) | sdk 1.0.1 | 2024-11-05 | 26 | ~3,546 |

What stands out:
- **One of ten speaks 2026-07-28**, two months after it shipped: Context7, the only
  one on the v2 SDK. It returns `ttlMs: 0` (the SDK default, F3) and declares no
  `listChanged`.
- **All ten menus are deterministic** and **all ten pass the official schema** for
  their protocol version. No `menu/nondeterministic`, no `spec/schema`.
- **Menu size varies 4.6×** for similar tool counts: Notion's 24 tools cost ~17,200
  tokens per conversation (its schemas are generated from the Notion API),
  Playwright's 25 cost ~3,700, Firecrawl's 29 ~11,500.
- **Annotations are mostly there now.** The archived GitHub server (April 2025) has
  9 write tools with no annotations; the current servers annotate almost
  everything (Kubernetes misses one, `kubectl_create`).
- **Firecrawl names 8 parameters just `id`** (`firecrawl_monitor_get.id`,
  `firecrawl_check_crawl_status.id`, …), lesson 04's vague-ID pattern.
- **`session` on Memory and Context7:** stable menus through lookups and searches,
  nothing to report.

Reproduce:

```sh
npm i --ignore-scripts @upstash/context7-mcp@4.1.1   # etc.
toolmenu snapshot -- node_modules/.bin/context7-mcp
toolmenu snapshot --env FIRECRAWL_API_KEY=fc-dummy -- node_modules/.bin/firecrawl-mcp
toolmenu session --scenario mem.yml --env MEMORY_FILE_PATH=/tmp/mem.jsonl -- node_modules/.bin/mcp-server-memory
```

### Buried routing instructions (`description/buried`)

Where a description is cut depends on the client. The documented cuts: Claude Code
sends 2,048 characters and appends "… [truncated]" (anthropics/claude-code#87650;
changeable since 2.1.280), Amazon Q CLI 10,024. My own client cut at 280, which is
where the rule came from. So the same menu reads differently per client:

- **At Claude Code's 2,048** (0.7's default): none of these ten servers has an
  instruction past the cut. One description is longer than the cut:
  `sequentialthinking` (2,781), whose tail ("Don't hesitate to add more thoughts"…)
  the model never sees in Claude Code (`description/cut`, info).
- **At 280** (`descriptionLimit: 280`, a client that cuts short): **15 tool
  descriptions on 4 servers give the agent instructions past the cut** (0.6, SPEC
  §18; 0.5 found 6 on 2, counting only the first routing word):

| Server | Tools | Examples past character 280 |
|---|---|---|
| Sentry | 7 of its tools (`search_issues`, `search_events`, `get_sentry_resource`, `analyze_issue_with_seer`, `update_issue`, `search_sentry_tools`, `execute_sentry_tool`) | char 700: "DO NOT USE FOR COUNTS/AGGREGATIONS → use search_events"; char 309: "Do NOT call this tool as an automatic follow-up to get_sentry_resource" |
| Firecrawl | 5 (`firecrawl_find_tools`, `firecrawl_agent`, `firecrawl_agent_status`, `firecrawl_parse`, `firecrawl_scrape`) | char 367: "Prefer normal firecrawl_search for a data task"; char 461: "do not send both fields together" |
| Context7 | 2 (`resolve-library-id`, `query-docs`) | char 1,875: "IMPORTANT: Do not call this tool more than 3 times per question." |
| Sequential Thinking | 1 (`sequentialthinking`) | char 273, cut mid-heading: "When to use this tool:", and the whole list under it |

These are the lines that tell an agent which tool *not* to use, or when to stop. They
are lost only in a client that cuts that short; in Claude Code they arrive. Checked
by hand: every one of the 15 is an instruction.

### What the first pass got wrong

The first run of the heuristic rules on these servers was noisy, and I fixed the
rules before recording the table above (F7, item 6). The remaining heuristic
findings are plausible rather than proven: `ids/authored` still flags IDs that only
ever appear in a tool's text output (`serviceWorkerId`, `insightSetId`,
`resourceId`), and `sequentialthinking.branchId`, which the agent is *meant* to
invent. The rule says it's a heuristic; these are the cases where that matters.

## F11. Ten servers' last releases

*First run 2026-09-27 with toolmenu 0.5; re-run 2026-09-28 with 0.7.1* (F7, items 7
and 8): `toolmenu history <package> --versions 12` for each server from F10 (10 for
memory, sequential-thinking, everything and kubernetes), in a container. Same caveat
as always: each version was installed today, so its dependencies resolve as of
today (F4).

| Package | Releases | Protocol | Tools | Menu (est.) | × | Releases with breaking changes | Bump too small |
|---|---|---|---|---|---|---|---|
| `@modelcontextprotocol/server-memory` | 0.6.0 → 2026.8.31 (2024-12 → 2026-08) | 2024-11-05, 2025-11-25 | 9 → 9 | ~765 → ~900 | 1.2× | 0 (0 changes) | – |
| `@modelcontextprotocol/server-sequential-thinking` | 0.5.1 → 2026.8.31 (2024-12 → 2026-08) | 2024-11-05, 2025-11-25 | 1 → 1 | ~773 → ~863 | 1.1× | 0 (0 changes) | – |
| `@modelcontextprotocol/server-everything` | 2025.9.12 → 2026.8.31 (2025-09 → 2026-08) | 2025-11-25 | 10 → 13 | ~762 → ~1,084 | 1.4× | 1 (11 changes) | – |
| `@upstash/context7-mcp` | 3.2.4 → 4.1.1 (2026-07 → 2026-09) | 2025-11-25, 2026-07-28 | 2 → 2 | ~977 → ~983 | 1.0× | 0 (0 changes) | – |
| `@playwright/mcp` | 0.0.71 → 0.0.82 (2026-04 → 2026-09) | 2025-11-25 | 22 → 25 | ~2,949 → ~3,725 | 1.3× | 3 (6 changes) | – |
| `chrome-devtools-mcp` | 1.1.0 → 1.10.1 (2026-05 → 2026-09) | 2025-11-25 | 29 → 30 | ~4,474 → ~5,537 | 1.2× | 2 (28 changes) | 1.6.0, 1.8.0 |
| `@notionhq/notion-mcp-server` | 1.9.0 → 2.5.2 (2025-08 → 2026-09) | 2025-06-18, 2025-11-25 | 19 → 24 | ~3,637 → ~17,161 | 4.7× | 1 (4 changes) | – |
| `@sentry/mcp-server` | 0.31.0 → 0.42.0 (2026-03 → 2026-09) | 2025-11-25 | 21 → 9 | ~11,832 → ~5,497 | 0.5× | 4 (21 changes) | – |
| `firecrawl-mcp` | 3.23.4 → 3.25.5 (2026-08 → 2026-09) | 2025-11-25 | 27 → 29 | ~8,607 → ~11,481 | 1.3× | 2 (2 changes) | 3.25.0, 3.25.3 |
| `mcp-server-kubernetes` | 4.0.8 → 4.1.7 (2026-07 → 2026-09) | 2025-11-25 | 23 → 23 | ~5,044 → ~5,088 | 1.0× | 0 (0 changes) | – |

- `chrome-devtools-mcp`: failed: 1.10.0 (crashed)

Reproduce: the commands in F10 with `history` instead of `snapshot`, then
`node scripts/history-report.mjs out/*/history.json` for this table (it reloads the
saved menus and re-diffs them with the current build).

What stands out:
- **Firecrawl grew 1.3× in six weeks**, most of it in one minor release: 3.25.0 added
  two tools and ~2,900 tokens (+32%) to every conversation that loads it. (0.7.0
  reported 2× and "+6,300 tokens in patch 3.25.5"; that was output schemas, F7.)
- **Notion grew 4.7× in its 2.0.0 major** (~3,600 → ~14,600 tokens): schemas
  generated from the Notion API. The major version said so.
- **Sentry went the other way, with a design change.** `@sentry/mcp-server` 0.37.0 cut
  22 tools to 9 (~13,800 → ~6,000 tokens) by adding `search_sentry_tools` and
  `execute_sentry_tool`: it looks like the "deferred" setup from lesson 05, a small
  core menu plus a way to look up the rest. The removals are real breaking changes
  for anything that called the old tools, released in 0.x minors (which semver
  allows).
- **Breaking changes in 1.x minor and patch releases:** `chrome-devtools-mcp` 1.8.0
  made a new `pageId` required on 25 tools, and 1.6.0 narrowed an enum.
  `firecrawl-mcp` 3.25.0 narrowed `limit` from number to integer, and patch 3.25.3
  dropped `github` from `firecrawl_search`'s `categories`.
- **Renames happen, and break callers:** `server-everything` 2026.1.14 renamed its
  tools from camelCase to kebab-case (`add` → `get-sum`, …) and dropped five;
  `@playwright/mcp` 0.0.72 renamed `browser_run_code` to `browser_run_code_unsafe`.
- **Another undeclared dependency:** `chrome-devtools-mcp` 1.10.0 crashes on start
  (`Cannot find package 'pkce-challenge'`); 1.10.1, a day later, works. Same pattern
  as F8.
- **No menu was unstable and none failed the official schema** in any release that
  ran.

### What this run fixed in toolmenu

Three `diff` rules were too strict on real release history, and I fixed them before
recording the table:
1. Widening a type (`sequential-thinking` 2026.8.31: `boolean` → `boolean|string`;
   `notion` 2.3.1: `object` → any) was reported as breaking. It's now
   `diff/type-widened`, minor.
2. Removing an optional parameter from a schema that allows extra properties (`notion`
   2.3.1 dropped `Notion-Version` from 21 tools) was reported as 21 breaking changes.
   Calls that still send it stay valid, so it's now `diff/param-dropped`, a notice.
3. `0.0.x` releases (`@playwright/mcp`) were held to semver bump rules they never
   promised. They no longer are.

## F12. 25 servers, from GitHub and Atlassian to Miro

*Checked 2026-09-28 with toolmenu 0.7.0 and recounted with 0.7.1.* The latest
release of each, over stdio, in a `node:22` container with no credentials: dummy
keys where a server wanted one to start, network on. For each: `snapshot`, then
`session --init` and the starter scenario it writes (read-only tools only, so calls
that needed a real account returned errors: `session/tool-error`, expected here).

| Server | Protocol | Tools | Menu (est.) | What stood out |
|---|---|---|---|---|
| `github-mcp-server` v1.12.2 (official, Go), default toolsets | **2026-07-28** | 45 | ~10,963 | Embeds an icon in every tool: 0.7.0 counted ~56,000 (F7, item 7) |
| same, `--toolsets all` | **2026-07-28** | 90 | ~22,892 | 0.7.0 counted ~115,000 |
| `mcp-atlassian` 0.23.1 (Jira + Confluence, Python) | 2025-11-25 | 98 | ~20,613 | **A different menu in every process** (below) |
| `@aashari/mcp-server-atlassian-jira` 3.3.0 | 2025-11-25 | 5 | ~3,540 | 4 write tools unannotated |
| `@sentry/mcp-server` 0.42.0 | 2025-11-25 | 9 | ~5,497 | |
| `firecrawl-mcp` 3.25.5 | 2025-11-25 | 29 | ~11,481 | 8 parameters named just `id` |
| `figma-developer-mcp` 0.13.2 (Framelink) | 2025-11-25 | 2 | ~896 | |
| `@k-jarzyna/mcp-miro` 1.0.11 | 2025-11-25 | 97 | ~17,506 | 53 write tools without annotations |
| `@notionhq/notion-mcp-server` 2.5.2 | 2025-11-25 | 24 | ~17,161 | |
| `@playwright/mcp` 0.0.82 | 2025-11-25 | 25 | ~3,725 | |
| `chrome-devtools-mcp` 1.10.1 | 2025-11-25 | 30 | ~5,537 | |
| `@upstash/context7-mcp` 4.1.1 | **2026-07-28** | 2 | ~983 | |
| `@supabase/mcp-server-supabase` 0.13.0 | **2026-07-28** | 29 | ~4,192 | |
| `mongodb-mcp-server` 3.0.4 | **2026-07-28** | 27 | ~13,673 | Advertises `logging`, deprecated in 2026-07-28 |
| `@brave/brave-search-mcp-server` 2.1.4 | 2025-11-25 | 8 | ~8,289 | |
| `@hubspot/mcp-server` 0.4.0 | 2025-11-25 | 21 | ~8,431 | |
| `@browserbasehq/mcp-server-browserbase` 2.4.3 | 2025-11-25 | 9 | ~1,054 | |
| `@apify/actors-mcp-server` 0.16.0 | 2025-11-25 | 10 | ~4,791 | An instruction past Claude Code's 2,048-character cut (`search-actors`) |
| `exa-mcp-server` 3.4.1 | 2025-11-25 | 2 | ~412 | |
| `tavily-mcp` 0.2.22 | 2025-11-25 | 5 | ~1,651 | |
| `@modelcontextprotocol/server-everything` 2026.8.31 | 2025-11-25 | 13 | ~1,084 | |
| `@modelcontextprotocol/server-github` 2025.4.8 (archived) | 2024-11-05 | 26 | ~3,546 | 9 write tools unannotated |

Not included: `@stripe/mcp` 0.3.3 (no answer within 30 s on a dummy key; its `--tools`
flag is gone, and the key's permissions now decide the tools)
and `@heroku/mcp-server` 1.2.9 (failed to import its SDK in my shared install, likely
my setup rather than the package).

### mcp-atlassian serves a different menu every time it starts

Every process of `mcp-atlassian` 0.23.1 describes four Jira tools (`jira_get_issue`,
`jira_search`, `jira_get_board_issues`, `jira_get_sprint_issues`) differently: the
default of their `fields` parameter lists the same eleven fields in a new order each
time.

```
"default": "assignee,description,updated,created,labels,summary,reporter,…"
"default": "issuetype,assignee,reporter,status,description,priority,created,…"
"default": "updated,summary,priority,created,labels,status,assignee,versions,…"
```

The defaults are built with `",".join(DEFAULT_READ_JIRA_FIELDS)`, a Python `set`,
whose order changes with every process (hash randomization). Within one process the
menu is stable, so a check that lists twice on one connection can't see it; `session`
did, because it starts a second process to compare (`session/connection-variance`).
The cost: prompt caches match bytes, so every restart of the server, and every
client that starts its own copy, gets a tool list that can't reuse a cached prefix.
The maintainers fixed it on 2026-09-19 (`sorted(...)`,
[sooperset/mcp-atlassian#1685](https://github.com/sooperset/mcp-atlassian/pull/1685));
0.23.1, the latest release, still has it.

Reproduce: start `mcp-atlassian` with `JIRA_URL`, `JIRA_USERNAME` and
`JIRA_API_TOKEN` set to anything, snapshot it twice, and diff the two.

### Release histories (`history --versions 12`)

| Package | Releases | Tools | Menu (est.) | × | Releases with breaking changes | Bump too small |
|---|---|---|---|---|---|---|
| `exa-mcp-server` | 3.1.2 → 3.4.1 | 2 → 2 | ~465 → ~412 | 0.9× | 4 (11 changes) | 3.1.4, 3.1.8, 3.1.9, 3.2.0, 3.2.1 |
| `@brave/brave-search-mcp-server` | 2.0.77 → 2.1.4 | 6 → 8 | ~4,858 → ~8,289 | 1.7× | 0 | 2.0.81 |
| `mongodb-mcp-server` | 1.12.0 → 3.0.4 | 25 → 27 | ~4,034 → ~13,673 | 3.4× | 2 (25 changes) | – |
| `@supabase/mcp-server-supabase` | 0.8.1 → 0.13.0 (0.6.2–0.8.0 crash) | 29 → 29 | ~3,420 → ~4,192 | 1.2× | 1 (1 change) | – |
| `figma-developer-mcp` | 0.7.0 → 0.13.2 | 2 → 2 | ~842 → ~904 | 1.1× | 0 | – |
| `@k-jarzyna/mcp-miro` | 1.0.2 → 1.0.11 | 97 → 97 | ~17,506 → ~17,506 | 1.0× | 0 | – |

- **Exa removes tools and parameters in patch releases.** 3.1.9 removed
  `company_research_exa`; 3.2.1 removed `crawling_exa`, `get_code_context_exa` and
  three parameters of `web_search_exa`, whose schema sets `additionalProperties:
  false`, so calls that still send them are rejected. 3.1.8 dropped `deep` from
  `type`'s values.
- **Brave's 2.0.81, a patch, added two tools and ~3,400 tokens (+70%)** to every
  conversation that loads it. (0.7.0 said +20,000: output schemas.)
- **MongoDB's majors say what they do:** 2.0.0 made `connectionId` required on 21
  tools and marked `rename-collection` and `update-many` destructive; 3.0.0 more than
  tripled the menu (~4,500 → ~13,700 tokens).

### What this run says about toolmenu

- The token counting was wrong, and wrong by the most on the biggest menus (F7,
  item 7). Fixed in 0.7.1.
- One `diff` false positive (F7, item 8). Every other breaking change above was
  checked against the schemas by hand.
- No server changed its menu mid-session: none of these unlocks tools on request, so
  `session`'s main check had nothing to find. What it did find was the Atlassian
  bug, through its second-process check.
- The heuristics are the weak part. `naming/vague-id` flags GitHub's `ref` (a git
  ref, a well-known name), and `ids/authored` flags IDs that come from a URL the user
  pastes (Figma's `nodeId`, Sentry's `resourceId`). The starter scenario's unlock
  guess matched two search filters (`category`).


## F13. 0.8 on the same servers: what changed

*Checked 2026-09-28.* `bench/run.sh` (the F12 servers at pinned versions, dummy
credentials) with 0.7.1 and with 0.8.0, compared with `node bench/report.mjs`.

| Finding | 0.7.1 | 0.8.0 |
|---|---|---|
| `menu/process-variance` | – (rule didn't exist) | 2: mcp-atlassian only (`snapshot` and `session`) |
| `session/connection-variance` (0.7 name) | 1: mcp-atlassian | – |
| `session/tool-error` | 33 warnings | 3 |
| `session/step-failed` | 1 error (GitHub, a 401) | 0 |
| `session/untested` | – | 7 errors (no call got through), 3 warnings |
| `ids/authored` | 49 warnings | 20 info |
| `naming/vague-id` | 15 warnings | 10 |

- **One server, one finding, and the fix.** `menu/process-variance` fires only on
  mcp-atlassian, and says what to do: "`jira_get_issue`:
  `inputSchema.properties.fields.default`: same 11 items, different order … Sort
  them." Nothing on the other 21.
- **The pinned seed works.** Two 0.8 runs saved identical mcp-atlassian menus (`diff`:
  0 changes). 0.7.1's menu against 0.8's shows 4 notices for the same release: the
  noise every pull request on such a server would have seen.
- **The 31 failures that went away** (30 tool errors and the one failed step) were all
  setup: 22 on authentication, 6 on Chrome missing from the container, 3 on a 404
  from an account or site that doesn't exist (HubSpot's answer to a bad token, the
  made-up Jira URL). The 3 left are real argument problems in the
  starter scenarios (Sentry's `get_sentry_resource`, Atlassian's `get_page`) and one
  bare "HTTPError" that can't be classified.
- **`session/untested` is an error on 7 servers** because no call got through with
  dummy keys. That's the honest result: the run tested nothing but the menu.
- **`ids/authored`:** Miro 34 → 6 (17 `orgId`s are returned by the organization
  tools; findings are grouped per kind), Figma's `nodeId` is gone (it comes from the
  URL), and GitHub's are info. `naming/vague-id` no longer flags GitHub's `ref`.

Reproduce: `npm run build && bench/run.sh out/0.8` and `node bench/report.mjs out/0.8 out/0.7.1`.

## F14. Hosted servers, behind OAuth

*Checked 2026-09-29 with `toolmenu auth login` (0.9), on the maintainer's own
accounts.* The hosted versions of three servers from F12, which toolmenu couldn't
reach before 0.9.

| Server | Registration | Protocol | Tools | Menu (est.) |
|---|---|---|---|---|
| Sentry, `https://mcp.sentry.dev/mcp` | dynamic | **2026-07-28** | 9 | ~5,529 |
| GitHub, `https://api.githubcopilot.com/mcp/` | **none**: needs an OAuth app you register | **2026-07-28** | 45 | ~11,008 |
| Atlassian, `https://mcp.atlassian.com/v2/mcp` | dynamic | 2025-11-25 | 21 | ~14,135 |
| same, `?tools=all` | | 2025-11-25 | 171 | ~79,906 |

- **Hosted and packaged versions speak different protocols.** Sentry's hosted server
  speaks 2026-07-28; its npm package, the same version (0.42.0), speaks 2025-11-25
  (F12). Checking the package says little about what hosted users get.
- **Atlassian uses search and execute, not unlocks.** Its default menu is 21 tools:
  a few common ones, `discover` (searches ~302 operations) and `executeRead`,
  `executeWrite`, `executeDestructive` (run one by name). The menu never changes:
  `session` listed it, called `discover`, and listed again, with no change and the same
  menu on a second connection. `?tools=all` serves the operations as 171 tools
  instead, for gateways that can't search: ~80K tokens against ~14K, 5.7× the menu for
  the same capabilities. Together with Sentry (`search_sentry_tools` +
  `execute_sentry_tool`, F11), Apify (`fetch-actor-details` + `call-actor`) and GitHub
  dropping its dynamic-toolsets flag (F12), that's the direction: a small fixed menu plus a way to reach the
  rest, not a menu that grows.
- **What `diff` can't see.** Operations behind `discover` aren't in the menu, so a
  breaking change to one never shows in a `diff` of the default endpoint. Atlassian's
  `?tools=all` makes them a menu, which `diff` can compare: snapshot that endpoint as
  the baseline.
- **Default scopes are broad.** Every server's default scope set includes writes:
  Sentry `project:write`, `event:write`; GitHub `repo`, `write:packages`; Atlassian 38
  scopes, including `delete:jira` and writes to Confluence, Bitbucket and Loom.
  `auth login` prints the scopes it asks for; `--scope` narrows them.
- **GitHub marks its list `cacheScope: "public"` on an authenticated request**, and
  its server documents that OAuth scopes filter the tools. A token with different
  scopes (the `gh` CLI's) got the same 45 tools here, so a caller-dependent menu isn't
  shown. A deliberately narrow token would settle it.
- **What toolmenu fixed on the way:** it didn't persist the SDK's discovery state, so
  the SDK couldn't check that a login's code goes back to the server that started it
  (SEP-2352; warned on Sentry); a pre-registered app (GitHub) wasn't stamped with its
  issuer, nor stored for refresh; and a server without dynamic registration gave only
  "Incompatible auth server". All fixed and tested before 0.9.0.

## F15. The catalogs behind search tools

*Checked 2026-09-29 with `snapshot --catalog`, on the maintainer's accounts.* 0.10.0
asked a fixed set of queries; 0.11.0 crawls the catalog by its own names. Atlassian's
`?tools=all` endpoint lists the same operations as tools, which makes it a ground
truth: 171 tools, 154 of them not in the default menu.

| Server | Menu | Search tool | 0.10.0 (fixed queries) | 0.11.0 (crawl, defaults) |
|---|---|---|---|---|
| Atlassian (hosted, `/v2/mcp`) | 21 tools | `discover` | 8 operations (40 queries) | **154 of 154** (181 queries) |
| Sentry (hosted) | 9 tools | `search_sentry_tools` | 61 (25 queries) | 65 (47 queries) |

- **The 8 was a toolmenu bug, not a weak search.** Atlassian's `discover` returns its
  results as JSON followed by a prose list of related operations ("createJiraBoard —
  Create a new company-managed…"). That makes the whole text invalid JSON, and 0.10.0
  dropped it. 0.11.0 reads the leading JSON and follows the names in the prose.
- **Crawling by the catalog's own names reaches everything.** Each operation found or
  mentioned is searched for by name, which returns it and its neighbours. On
  Atlassian, one result per search plus the mentioned names reached all 154
  operations; it stops when 20 queries in a row find nothing new. At a fixed 60
  queries it had 93 (60%), at 150, 143 (93%). Every operation found was real.
- **Reproducible.** Two crawls of Sentry asked the same 47 queries in the same order
  and found the same 65 operations; `diff` between them reported nothing.
- **Sentry's catalog is most of the server**, 65 operations behind 9 tools: alert
  rules, monitors, DSNs, teams, releases. Before `--catalog`, `diff` saw none of them.
- **Rate limits are real.** Sentry answered "Rate limit exceeded" after about 70
  searches in a few minutes. Paced at 300 ms with retries (2, 4, 8 s), later runs had
  no failed queries, including Atlassian's 181.
