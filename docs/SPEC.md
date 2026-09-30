# toolmenu — spec (v1.0, frozen 2026-09-27)

> **toolmenu: lint your MCP server's tool menu for changes that confuse agents or break caches.**
>
> **Observe the menu. Diff the menu. Catch the menu changing at the wrong time.**
>
> Free on npm. Uses the article's own metaphor: an MCP server is a menu the agent reads.
> GitHub topics: `mcp`, `linter`, `model-context-protocol`. License: MIT.
>
> Protocol claims are checked against the official spec source, pinned in §12.

## 1. Why this exists

There are already MCP linters: mcplint, mcp-lint, mcpx, mcp-tool-card-linter,
mcp-server-lint. They grade **one snapshot** of the tool list: missing descriptions,
token bloat, prompt injection. There are also conformance checkers for the
stateless 2026-07-28 spec: mcp-stateless-conformance, mcp-stateless, mcp-spec-check.

None of them look at **when** the menu changes. That's two different problems,
and they need different answers:

| When the menu changes | What it risks | toolmenu command |
|---|---|---|
| **During a live conversation** (unlocks, dynamic tools, unstable output) | Cache breaks. Prompt caches match a prefix, and most clients put the tool list at the start of the prompt (Claude's Messages API renders tools, then system, then messages), so a change anywhere in the tool list means everything after it, the whole conversation included, is processed again. In my logs, one mid-conversation unlock rewrote **40–57K tokens of cached prefix** | `session` |
| **Between releases** | Compatibility. Agents, saved prompts and evals break or quietly change behaviour. Little cache impact: prompt caches are short-lived (minutes to hours, depending on the provider), so a deploy costs roughly one rewrite | `diff` |

The 40–57K figure supports the first row only. v0.1 of this spec mixed the two up.

**Identity rule.** toolmenu is not a general "MCP best practices" linter. A feature
earns its place by serving *observe the menu, diff the menu, or catch the menu
changing at the wrong time*, and every rule must trace to a failure written up
in "I built 100+ tools for one MCP server". If it can't, it doesn't ship.

## 2. Users

- **MCP server authors** who run it in CI on every PR.
- **Agent builders** who check a third-party server before adopting it.
- **Researchers (me)** measuring how the ecosystem's menus behave over time.

## 3. Commands

```
snapshot → establish the menu
diff     → compare releases
session  → observe the menu changing while the agent runs   ← the centerpiece
history  → research release history (a wrapper around snapshot + diff)
```

```
toolmenu snapshot <server>  [--out menu.json] [--routes routes.yml]
toolmenu diff     <old.json> <new.json>
toolmenu session  <server>  --scenario scenario.yml
toolmenu history  <npm-package> [--versions 10] [--out dir/]
```

`<server>` is either a stdio command (`-- node dist/server.js`) or an HTTP URL.
It connects through the official MCP TypeScript SDK, which handles both
2025-11-25 (`initialize`) and 2026-07-28 (`server/discover`).

Every command offers pretty text by default, stable `--json`, and `--format github`
for PR annotations. Exit codes: `0` clean, `1` findings at or above `--fail-on`
(default `error`), `2` couldn't connect or bad usage.

**No LLM anywhere in v1.** Every command is deterministic, so CI is reproducible
and free. toolmenu doesn't ask "would an agent have noticed?". It asks "did the
server's menu change, and when?"

### 3.1 `snapshot`: establish the menu

Connects, lists the tools **twice**, writes `menu.json`, and runs the menu rules
(§4).

```json
{
  "toolmenu": 1,
  "server": { "name": "...", "version": "...", "protocolVersion": "2026-07-28" },
  "capturedAt": "...",
  "tools": [ { "name": "...", "description": "...", "inputSchema": {}, "outputSchema": {},
               "annotations": {}, "tokens": 312 } ],
  "totalTokens": 18234,
  "listMeta": { "ttlMs": 300000, "cacheScope": "private" }
}
```

Tools are kept **in server order**. The file is committed as the baseline so menu
changes show up in PR diffs.

### 3.2 `diff`: compare releases

Offline. Compares two snapshots and classifies each change the way OpenAPI
breaking-change checkers do, then suggests a semver bump.

| Change | Class |
|---|---|
| Tool removed | breaking |
| Tool renamed (heuristic: one removed + one added with near-identical schema) | breaking, reported as rename |
| New required parameter, parameter removed, type changed, enum narrowed | breaking |
| `readOnlyHint` true → false, or `destructiveHint` added | breaking (an agent's safety assumptions change) |
| New tool, new optional parameter, enum widened | minor |
| Description changed | notice, with a text diff. It doesn't break the protocol, but it changes what the agent does |
| Order changed | notice only. It matters within a session, not between releases (§1) |

Also reports:
- **Token change:** `this release adds ~1,240 tokens to every conversation`, with
  a per-tool breakdown and an optional `tokenBudget` in the config.
- **Version mismatch:** a breaking change released as a patch or minor bump.

The GitHub Action runs `snapshot` against the PR's build, then `diff` against the
committed baseline, and posts one PR comment: breaking changes, token change,
suggested bump.

### 3.3 `session`: observe the menu changing while the agent runs

The centerpiece. Runs a scripted, deterministic session and snapshots the menu
after every step. There's no agent and no LLM: the scenario *is* the agent.

```yaml
# scenario.yml
allow_writes: false          # refuse to call tools not marked readOnlyHint
steps:
  - list                     # baseline
  - call: search_forms
    args: { query: "onboarding" }
  - call: unlock_toolset
    args: { toolset: "audits" }
  - wait_for: tools_list_changed   # or a timeout
  - list
```

After each step it compares the menu to the previous one, and it listens for
`notifications/tools/list_changed`: on 2026-07-28 by opening a
`subscriptions/listen` stream with `toolsListChanged: true`; on earlier versions
through the notification on the session.

| Change during session | Severity | Why |
|---|---|---|
| Tool appended at the end | warn | The end of the tool list isn't the end of the prompt. With tools first, an append still invalidates the cached conversation after the list. Cache-safe only when the client adds new tools after the cached content, as tool search (deferred loading) does. (Corrected before 0.7.0: earlier drafts called appends "usually cache-friendly", which only holds for tool search.) |
| Tool inserted mid-list | error | Invalidates the cache from the insert point on, and the conversation after the list |
| Reorder | error | Same, from the first moved tool on |
| Tool removed | error | Same, from the removed tool on |
| Description/schema/annotations of existing tool edited | error | Same, from the edited tool on |

Each change is then **classified by scope**: toolmenu lists again from a fresh
connection with the same credentials.

| Scope | Meaning | Extra finding |
|---|---|---|
| **global** | The fresh connection sees the same new menu: the server's underlying tool set changed | none (the cache findings above still apply) |
| **connection-local** | Only the connection that made the call sees the change | `session/connection-local`, error, `since: 2026-07-28`. The spec says the tool set **MUST NOT** vary "per-connection or as a side effect of other requests on the connection" (§12) |

That second row matters: the unlock pattern behind the 40–57K figure, a tool call
that changes the menu for that conversation only, is exactly what 2026-07-28 rules
out. On earlier spec versions it's allowed, and toolmenu reports only the cache cost.

| id | sev | check |
|---|---|---|
| `session/unannounced` | warn | The menu changed, the server declared `listChanged: true`, and no `notifications/tools/list_changed` arrived. The spec says servers **SHOULD** send it |

It also runs a **connection-variance check**: the same `list` from two fresh
connections **with the same credentials** must return the same menu. On
2026-07-28 the tool set "MUST NOT vary per-connection" (§12). It **MAY** vary by
the authorization on the request, so toolmenu never compares menus across
different credentials.

**Every finding has a change origin**: the step that caused it, what changed, where,
and the estimated tokens affected.

```
SESSION  scenario.yml

step 3: call unlock_toolset { toolset: "audits" }
  ERROR session/mid-insert
    +3 tools inserted at position 42 (list_team_audits, get_team_audit, …)
    the change starts at position 42; any change to the tool list invalidates the cached
    prompt, so the whole tool list (this server's part: ~31,000 tokens, estimate) and the
    conversation after it are processed again

step 5: list
  ERROR session/edit
    get_form: description changed (no tool call in between)
    the change starts at position 17; … the whole tool list (~31,000 tokens) and the
    conversation after it are processed again
```

That turns "something bad happened" into "this operation changed the menu in a
cache-hostile way", which is the output a CI job needs.

**Safety:** `session` calls tools for real. Without `allow_writes: true` it refuses
any tool not annotated `readOnlyHint: true`. `--plan` prints the steps without
running anything.

### 3.4 `history`: research release history (best effort)

```
toolmenu history @acme/mcp-server
```

```
--versions <n>   Number of published versions to inspect (default: 10)
```

The default is bounded on purpose: predictable runtime, and limited exposure from
installing third-party packages. `--versions all` can come later if people ask for it.

A research wrapper around `snapshot` + `diff`, framed as **best-effort ecosystem
research**, not "any npm MCP package, inspected automatically".

1. Reads the published versions from the npm registry.
2. For each one: installs it into a temp dir with `--ignore-scripts` by default,
   starts its `bin` over stdio, `snapshot`s it, shuts it down.
3. Runs `diff` between consecutive versions.
4. Writes a timeline (text) and a dataset (`--json`/CSV): tools, tokens,
   breaking changes, determinism, version-bump mismatches per release.

**Expected to fail on plenty of packages**, and it says so: servers with odd
startup commands, required env vars or auth, native dependencies, packages that
aren't runnable on their own, or an npm package that isn't the server itself.
Options that help: `--arg`/`--env` for startup flags, `--cmd` template for
unusual entry points, `--allow-scripts` when install scripts are needed. Every
version that fails is recorded as `failed` with a reason category
(`no-bin`, `needs-env`, `install-failed`, `timeout`, `crashed`), never skipped
silently. The failure rate is reported too, since it's part of the finding.

**Security:** this runs third-party code. The README says to run `history` in a
container. `--sandbox docker` is a v1.1 item.

## 4. Menu rules (run by `snapshot`)

Each rule has an id, a severity, the article lesson it comes from, and a `since`
spec version when it only applies from that version on. §3.2 and §3.3 list the
`diff/*` and `session/*` rules.

**Determinism (lesson 05)**

| id | sev | check |
|---|---|---|
| `menu/nondeterministic` | error | Two identical `tools/list` calls return different menus. Reports what differed: order, description, schema, annotations, tool added, tool removed. Order and content changes are both cache-relevant. Spec basis for order: servers **SHOULD** return "the same ordering across requests when the underlying set of tools has not changed" (§12). Content changes are toolmenu's own rule (lesson 05), not a spec violation |

**Naming (lesson 04)**

| id | sev | check |
|---|---|---|
| `naming/vague-id` | warn | A parameter named `id`, `ids` or `key` that doesn't say which kind of thing it identifies (the ~13-wasted-calls bug) |
| `naming/shared-word` | info | The same noun is a primary term in tools from different areas (the "audit" collision). Lists groups for review, never fails the build |
| `naming/route` | error | A `routes.yml` expectation broke |

```yaml
# routes.yml: lesson 04's regression test as a config file
audit:
  must_match: [list_team_audits, get_team_audit]
  must_not_match: [get_audit_trail]
```

Keyword matching only in v1: deterministic, free and reproducible in CI.

**What the model has to type (lesson 01)**

| id | sev | check |
|---|---|---|
| `ids/authored` | warn | An input that looks like an opaque ID where no tool appears to return that kind of ID, so the agent would have to invent it. Heuristic, and worded as one. Stronger when `outputSchema` is present |

**Look before it leaps (lesson 02)**

| id | sev | check |
|---|---|---|
| `write/no-dry-run` | info | A `destructiveHint: true` or `readOnlyHint: false` tool with no `dry_run`/`preview`-style parameter and no matching preview tool |
| `write/unannotated` | warn | A tool whose name suggests writing (`delete_`, `send_`, `update_`…) has no annotations |

**Spec** (not observed failures: protocol requirements, kept minimal)

| id | sev | check |
|---|---|---|
| `spec/schema` | error | `tools/list` result fails the official `schema.json` for its version. Version-aware: a 2026-07-28 result missing `ttlMs`/`cacheScope` fails, because that version requires them on cacheable results (SEP-2549); a 2025 result is checked against its own schema, which doesn't have them |
| `spec/discover` | info | The server only speaks the 2025 protocol: no working `server/discover`, which 2026-07-28 servers **MUST** implement. Info, not error: see §13 |
| `spec/deprecated` | info | Advertises Sampling, Roots or Logging, or uses HTTP+SSE (`since: 2026-07-28`) |
| `spec/cache-hints` | info | Cache metadata recommendation, not a correctness error (`since: 2026-07-28`). `ttlMs: 0` on `tools/list`: valid, but tells clients the list is "immediately stale" and they may re-fetch every time. `cacheScope: "public"` on a server that required auth: valid only if the list has no user-specific data, because shared caches "MAY … serve it across authorization contexts". Worth a look if the tool set depends on the caller's scopes |

**Not linted:** lesson 03 (say how sure you are, per tool) can't be checked from
outside. The README says so and links the article. For full stateless conformance,
the README links to the existing checkers.

## 5. Limitations (stated in the README and the article)

- **Server order ≠ final client order.** Clients like Claude Code merge tools from
  several servers and may sort or filter them. A stable server menu is necessary for
  cache hits, not sufficient. toolmenu measures what the server controls.
- **"Tokens affected" is an estimate, not a bill.** Counts come from `js-tiktoken`,
  over each tool's name, description and input schema: what clients send the model.
  Output schemas, annotations, icons, `title` and `_meta` aren't counted (before
  0.7.1 they were, which inflated servers with embedded icons up to 5×).
  Vendors tokenize differently, and cache expiry, minimum cacheable size and
  cache-write pricing are all provider-specific. The figure is an upper bound on
  what a provider might need to write to the cache again.
- **Heuristic rules say they're heuristics** (`ids/authored`, rename detection,
  `naming/shared-word`).
- **`history` is best effort** (§3.4).

## 6. Config

`toolmenu.config.json` (optional): enable/disable rules, change severities, set
paths to `routes.yml` and the baseline, `tokenBudget`, and ignore tools by name or
glob. No config needed for a useful first run.

## 7. Tech

- Node 22+, TypeScript, ESM. `@modelcontextprotocol/client` (SDK v2) for connecting.
- `js-tiktoken` for estimates. No network calls except to the server being
  checked and, for `history`, the npm registry.
- Official `schema.json` per spec version, vendored and pinned.
- Tests: `node:test` plus **fixture servers** in `test/fixtures/`, each built to
  break one rule, including one that inserts mid-list on unlock for that connection only, one with
  random order, and one whose descriptions change between calls. Snapshot
  fixtures for `diff`. A fake registry for `history`.
- CI: GitHub Actions running its own tests plus toolmenu against its fixture servers.
  Published as a GitHub Action (`uses: niksa90/toolmenu@v1`).

## 8. Out of scope (v1)

Security and prompt-injection scanning (covered by others), full stateless
conformance (covered by others), letter grades, a web UI, LLM-judged description
quality, and anything else that makes it a generic best-practices linter.

**v1.1 candidates:** collisions across servers (`snapshot a b c`: duplicate names and
shared words across servers an agent loads together), `--sandbox docker` for
`history`, library matchers (`expect(menu).toMatchMenu()`).

**Later, maybe:** error-message lint (opt-in, read-only tools only: call with bad
arguments and check the error tells the agent what to fix).

## 9. Milestones

Build order follows reuse and gets the article's data early. It's not the same as
the importance order in §3.

1. **`snapshot`**: CLI, stdio and HTTP connections, menu.json, determinism check,
   menu rules.
2. **`diff`**: breaking-change classes, token change, semver suggestion.
3. **`history`**: cheap once 1 and 2 exist. Unlocks the article's dataset.
4. **`session`**: scenario runner, change detection with change origin, scope
   classification (global vs connection-local), `session/unannounced`,
   connection-variance check. *The centerpiece.*
5. **Polish**: `--json`, GitHub annotations, the Action with a PR comment, README
   with a GIF of `session` output.
6. **The run**: `history` across 10–20 popular stdio MCP servers on npm, plus
   `session` on the ones with dynamic tools.

## 10. The article

Working title: *"Your MCP server's menu changes at the wrong time. I built a check
for it."*

1. **The anecdote:** one mid-conversation unlock, **40–57K tokens of cached prefix
   rewritten**. What that can mean for the bill comes after, hedged per provider.
2. **The correction, straight after:** I originally thought the problem was tool
   ordering between releases. It wasn't. A deploy can reorder the menu, get cached
   again, and carry on. The expensive case was the menu changing after the
   conversation had already started. *It's not the order between releases. It's
   the order within a session.*
3. Why existing linters miss it: they check a snapshot, not when things change.
4. toolmenu: snapshot, diff, session, and `session` output with change origins.
5. What `history` found across real servers: unstable menus, breaking changes
   released as patch versions, token growth per release. Plus how many servers it
   couldn't run, and why. **Servers are named**: every finding gives the
   package@version and the exact command/config to reproduce it. Anonymise only
   with a reason (a private server, a client relationship, or a result that
   can't be reproduced).
6. The spec now agrees, quoted from §12, with the limitation up front (server
   order isn't client order):
   - deterministic order is a **SHOULD**, for prompt cache hit rates;
   - the tool set **MUST NOT** vary per-connection or as a side effect of other
     requests on the connection, which rules out the unlock pattern I used;
   - `ttlMs`/`cacheScope` are required on cacheable results (`tools/list` among
     them) in 2026-07-28. Older protocol versions don't have these fields.

Discipline for the whole piece: "tokens of cached prefix rewritten" or "tokens
affected", never "tokens cost", unless it's a measured bill.

## 11. Decisions (frozen)

| Question | Decision |
|---|---|
| Public servers in the article | Named, with package@version and the exact command/config. Anonymise only with a reason |
| License | MIT, `LICENSE` in the repo from day one |
| `history` default | 10 versions, shown in `--help`. `--versions all` only if people ask |
| Tagline | "lint your MCP server's tool menu for changes that confuse agents or break caches" |

## 12. Protocol references (verified)

Checked against `modelcontextprotocol/modelcontextprotocol` at commit
`ab3a39c13bd23be691c2760e1c6c5c15a64582e1` (main, 2026-09-27).
Re-check these before the article goes out.

| Claim in this spec | Source | Wording |
|---|---|---|
| Tool set must not vary per connection or by side effect; may vary by authorization | `docs/specification/2026-07-28/server/tools.mdx` | "**MUST NOT** vary per-connection or as a side effect of other requests on the connection. The set **MAY** vary by the authorization presented on the request" |
| Deterministic order | same file | "Servers **SHOULD** return tools in a deterministic order (i.e., the same ordering across requests when the underlying set of tools has not changed)… improves LLM prompt cache hit rates" |
| List-changed notifications | same file | Servers that declared `listChanged` "**SHOULD** send a notification to clients that have opened a `subscriptions/listen` stream with `toolsListChanged: true`" |
| `server/discover` | `schema/2026-07-28/schema.ts` (`DiscoverRequest`) | "Servers **MUST** implement `server/discover`. Clients **MAY** call it" |
| `ttlMs` | `schema.ts` (`CacheableResult`, which `ListToolsResult` extends) | Required, `@minimum 0`. "If 0, The response SHOULD be considered immediately stale" |
| `cacheScope` | same | Required, `"public"` or `"private"`. Public: "does not contain user-specific data… MAY cache the response and serve it across authorization contexts" |
| Sessions removed, lists no longer per-connection | `docs/specification/2026-07-28/changelog.mdx`, major change 1 | SEP-2567 |

## 13. Implementation notes (0.1)

Things building `snapshot` settled or changed. The spec above is updated to match.

- **SDK:** `@modelcontextprotocol/client` 2.1.0, which negotiates both eras
  (`versionNegotiation: 'auto'`: probe `server/discover`, fall back to
  `initialize`). Lists use `cacheMode: 'bypass'` so both calls reach the server.
- **Raw wire, not the SDK's copy.** toolmenu taps the transport and reads
  `tools/list` results as received. The SDK re-parses results, and it throws on
  results that fail its validation; toolmenu still reads those off the wire and
  reports them under `spec/schema`, noting that the official client rejects them.
- **`spec/discover` is info, not error.** With automatic negotiation, a server
  without a working `server/discover` *is* a 2025-era server. There's no way to see
  a "2026 server missing discover" from outside, so the rule reports the era and
  that 2026-07-28 rules were skipped.
- **Official SDK default:** `serveStdio`/`createMcpHandler` servers return
  `ttlMs: 0` and `cacheScope: "private"` unless configured. `spec/cache-hints`
  says so, so it doesn't read as an accusation.
- **stdio environment:** the SDK gives stdio servers a minimal environment
  (PATH, HOME, …). Anything else goes through `--env K=V`. Kept as a safety default.
- **First real runs** (`@modelcontextprotocol/server-filesystem` 0.2.0,
  `@modelcontextprotocol/server-everything` 2.0.0): both work, both still speak
  2025-11-25, 0 errors. The filesystem server's `edit_file` has a `dryRun`
  parameter and is correctly not flagged.

## 14. Implementation notes (0.2: `diff`)

- **Effective annotation hints.** Safety changes compare hints after the spec's
  defaults (`readOnlyHint: false`, `destructiveHint: true`). An unannotated tool is
  already "destructive", so making that explicit isn't a change. Becoming safer is
  never breaking.
- **Two notice rules beyond §3.2:** `diff/annotations` (any other annotation
  change, e.g. `openWorldHint` added) and `diff/other` (title, icons, `_meta`…).
  Without them, a release changed every tool's tokens with no finding (FINDINGS F7).
- **Empty or invalid schemas aren't compared** parameter by parameter: that
  produced 17 false breaking changes on real data. Reported as `diff/schema-other`.
- **Renames:** one removed + one added tool with the same non-empty parameter names,
  types and required set, and only when exactly one candidate matches.
- **Version checks:** under 1.0.0 a minor bump may carry breaking changes (see below). Calendar
  versions (major ≥ 1000) are skipped. `diff` uses `server.version` from the
  snapshots; see below for `history`.
- **Under 1.0.0 both steps shift** (npm's caret: `^0.2.3` accepts any 0.2.x):
  breaking changes need a minor bump, new features a patch; under 0.1.0 anything
  goes. `requiredBump` in the JSON says which applied. Found on Tavily 0.2.16,
  0.2.19 and HubSpot 0.3.3, whose features in a patch were flagged as too small.
- **The same change in many tools is one finding** (§25): the same rule, the same
  path inside each tool, and the same schema before and after (descriptions
  aside). It lists the tools (`tools`, and the full list in `detail` past six) and
  every place (`places`); `tool` is left out. chrome-devtools-mcp 1.8.0 made
  `pageId` required in 25 tools: one finding, not 25. **Counts are per change**:
  `classes.breaking.changes` counts findings, `classes.breaking.tools` the tools
  they touch; the bump is the same either way.
- **Paths in messages** are written as they nest: `a.b` for a field, `a[]` for
  array items, `a(kind="x")` or `a(object{p,q})` for a union option.
- **Likely renames** (`diff/param-renamed`, warn, unsure, no class): a tool loses
  a parameter and gains a required one next to it with a close name (case,
  separators, a plural, an edit or two) and the same type or an array of it,
  one to one. A hint for the author; both changes stay breaking.
- **All published protocol schemas are bundled** (2024-11-05 → 2026-07-28), draft-07
  and draft 2020-12, pinned to the commit in §12.

### Consequences for `history` (from FINDINGS F4, F5)

- **Key versions on the npm version**, not `serverInfo.version`: the official
  filesystem server reported `0.2.0` across 19 months of releases.
- **Record the resolved dependency versions** (at least the MCP SDK and zod) with
  every snapshot, and state the install date. Installing an old release today
  resolves today's dependencies: two filesystem releases now serve empty schemas
  they didn't ship with.
- A lockfile-respecting mode (install exactly what shipped, where a lockfile or
  `npm-shrinkwrap.json` exists) is a later option.

## 15. Implementation notes (0.3: `history`)

- **Registry and install go through the user's own `npm`** (`npm view`, `npm install`),
  so their config, proxy and private registries apply. Both sit behind a
  `PackageSource` interface; the tests use a fake one (copied packages plus a
  written lockfile), so they need no network.
- **Versions are ordered by publish time**, oldest first. Prereleases are left out
  unless `--include-prereleases`. `--versions` (default 10) keeps the most recent.
- **Installs:** one temp directory per version, `--ignore-scripts` by default,
  deleted afterwards unless `--keep-installs`. Sequential, not parallel.
- **Dependencies recorded per version:** `declared` (the package's own ranges) and
  `resolved` (every installed copy, from the lockfile npm wrote) for the MCP SDK
  packages, zod and zod-to-json-schema.
- **Diffs compare by npm version** and skip failed versions: each working version is
  compared with the previous one that worked.
- **Failure reasons:** `install-failed`, `no-bin`, `needs-env`, `needs-args` (added:
  a server that prints usage and exits), `timeout`, `crashed`. The saved error
  keeps the lines that say what went wrong, not the stack.
- **Outputs:** `history.json` (the dataset), one `<version>.json` menu per working
  version, optional `--csv`, and a text timeline.
- **Exit codes:** 0 when at least one version could be inspected, 1 when every one
  failed, 2 for usage or registry errors. It's research, so findings don't fail it.
- **First real run:** all 19 releases of `@modelcontextprotocol/server-filesystem`
  in about two minutes: 16 inspected, 3 crashed (FINDINGS F6, F8).

## 16. Implementation notes (0.4: `session`)

- **The menu is listed after every step**, not only at `list` steps, so each change
  is pinned to the step that caused it. A `list` step that finds a change reports
  "no tool call in between".
- **Notifications** are read off the wire. On 2026-07-28 toolmenu opens
  `subscriptions/listen` with `toolsListChanged: true` when the server declares
  `listChanged`; on 2025-era servers they arrive on the session. After a change,
  toolmenu waits up to 500 ms for a notification before reporting
  `session/unannounced`.
- **Scope is decided per step, from that step's changes:** after a change, a fresh
  connection with the same credentials lists the menu. If it sees all of the step's
  additions, removals and edits, the change is `global`; none, `connection-local`
  (HTTP) or `per-process` (stdio); a mix, or a reorder alone, `unclear`.
- **stdio can't separate global from per-connection:** a fresh connection is a
  fresh process. So `session/connection-local` (error on 2026-07-28, info before)
  is HTTP-only, and stdio gets `session/side-effect` (warn, 2026-07-28 only).
- **The fresh-connection check** runs once before the first step: HTTP, error on
  2026-07-28 and warn before; stdio, warn.
- **Extra rules beyond §3.3:** `session/refused` (a call to a tool not marked
  `readOnlyHint` without `allow_writes: true`, error) and `session/step-failed`
  (a call that throws, or a tool that isn't in the menu at that point, error).
- **Not covered end-to-end:** `session/connection-local` as an *error* needs a
  2026-07-28 HTTP server that keeps per-connection state, and the official SDK's
  stateless HTTP can't produce one (FINDINGS F9). The rule is covered by unit tests
  on the scope logic and end-to-end on a 2025-era HTTP server with sessions.

## 17. Implementation notes (0.5: polish, and a second real-world round)

- **New rule, `description/buried`** (warn): a description longer than the assumed
  client cut-off (280, `descriptionLimit` in the config) whose first routing
  instruction ("don't", "use this when", "not a…", "call this", "instead"…) starts
  after the cut-off. From an observed failure: a client cut every description at 280
  characters, and the line that decided routing sat at character 1,222 of 1,919.
- **Heuristics tuned on a 115-tool server:** `ids/authored` strips qualifiers
  (`creator`, `new`, `target`, `parent`…) before looking for a source, and skips an
  optional ID whose description says not to invent it. `naming/shared-word` ignores a
  word that opens every tool name it appears in (a group prefix like `task_`), and
  reports one summary finding instead of one per word (`--json` has them all).
- **`diff` on real release history:** widening a type (`boolean` → `boolean|string`,
  `object` → any, `integer` → `number`) is `diff/type-widened`, minor, not breaking.
  `0.0.x` versions promise nothing, so `diff/version-bump` skips them. Removing an
  optional parameter is `diff/param-dropped` (notice) unless the new schema sets
  `additionalProperties: false`: calls that still send it stay valid. `history`
  records the version-bump verdict per release (`bumpTooSmall`). All three came from
  FINDINGS F11.
- **`session --init`** writes a starter scenario from the live menu: every read-only
  tool that needs no arguments, then a repeat; tools that look like they change the
  menu and read-only tools that need arguments as commented-out steps, with enum,
  boolean and number examples filled in.
- **`session`** reports stdio's side-effect warning once, naming the steps.
- **`--format markdown`** for `snapshot`, `diff` and `session`: errors and warnings
  in a table, info folded away.
- **The GitHub Action** (`action.yml` + `action/run.sh`): snapshot, diff against the
  baseline, optional session, one PR comment updated in place, the job summary.
  toolmenu's own CI runs it on every PR against a fixture server.
- **Release:** pushing a `v*` tag that matches `package.json` publishes to npm with
  provenance (`NPM_TOKEN` secret).
- **`--versions all`** for `history`.
- **Not done: `--sandbox docker`.** No Docker daemon was available to test it, and it
  won't ship untested.

## 18. Implementation notes (0.6: precision, from a run on a 115-tool server)

A private run of 0.5 on the 115-tool server the rules came from found the rules
pointed at real problems but too loosely. Each change below comes from a false
positive or a miss in that run.

- **`description/buried` reads instructions, not words.** An instruction addresses
  the agent or names another tool: "use X instead", "call X first", "don't retry",
  "never guess one", "if the user…". The same words describing behaviour ("never
  throws", "instead of failing the call", "rather than erroring", "were never
  recognized") no longer count; about half of 0.5's findings there were those. Every
  instruction past the cut is checked, one per sentence, not only the first routing
  word: 0.5 missed the rule's own origin case, because "not a…" early in the description
  counted as the routing line.
- **The cut is per client.** `descriptionLimit` sets it, and `fullDescriptions`
  (names or `*` globs) lists tools the client sends uncut.
- **`routes.yml`:** a route with only `must_not_match` is evaluated on its own: the
  tool must not match at all. A multi-word route matches a tool that has every
  (non-stop) word in its name or description, not only the exact phrase; the phrase
  still scores higher. When a route matches a tool through a sentence with "not" in
  it, the message says so: keyword search can't read "not", so a disclaimer puts the
  words into the tool it disclaims. The "doesn't match" message names the missing
  words.
- **`session --init` finds unlock tools** by a parameter that names what to unlock
  (`domains`, `toolset`, `capabilities`…, strongest with an enum), "unlock",
  "capabilities" or "toolset" in the name, and a description about loading tools.
  "scope" or "mode" alone no longer count. The best read-only candidate with enum
  values runs for real: two unlocks and a repeat, with array parameters filled as
  arrays. An optional unlock parameter is still filled in.
- **New rule, `session/tool-error`** (warn): a call that returns `isError`. A run
  where every step fails on an expired token used to end "0 errors, 0 warnings".
- **`ids/authored`** skips an optional ID when the tool description names it in a
  "don't invent" sentence, or its own description says to omit it.
- **Checked on that server again** (0.6 as above): 5 of the 6 fixes did what they
  should, and the follow-ups below fixed the rest.
- **An instruction the cut falls inside counts.** "Use task_…" starting at character
  271 shows the model "Use task_" and loses the tool name. A hit is past the cut when
  it *ends* past it; the message says "mid-instruction". Hits are filtered by the cut
  before they're reduced to one per sentence, so an early hit in a long sentence no
  longer hides a later one. Sentences also end at a newline, so a bullet list isn't
  one sentence.
- **Error text is clipped by code point**, at a word boundary, and a trailing U+FFFD
  (a server that cut its own message by bytes) is dropped.
- **Route scores reward the name:** 1 per route word in the tool name, plus 2 when the
  name has them all; the description adds 1 per exact phrase (up to 3), or 1 when
  every word is somewhere. Two tools whose names and descriptions really can't be
  told apart still tie, and the message now says so and asks for a route word only
  the right tool has.
- **`--init`** no longer ends with two `list` steps in a row.

## 19. Implementation notes (0.7: the cut belongs to the client)

- **No guessed cut.** 0.5 and 0.6 assumed 280 characters, the cut of one private
  client. Documented cuts differ: Claude Code sends 2,048 characters and appends
  "… [truncated]", silently (anthropics/claude-code#87650; changeable since 2.1.280
  with `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`); Amazon Q CLI 10,024, with a
  warning. Other clients send descriptions in full or don't document a cut.
  `descriptionLimit` takes a number or `"claude-code"` / `"amazon-q"`; the default is
  `"claude-code"`, and the message names the client and says it's the default.
- **New rule, `description/cut`** (info): descriptions longer than the client sends,
  with nothing past the cut that reads as an instruction, as one summary. From the
  same Claude Code report: a cut prefix can read as complete, and the model then
  uses a narrower API with confidence.
- **Routes to tools that appear later.** On a server that declares
  `tools.listChanged`, a route naming a tool that isn't in the menu yet is info, not
  an error: gated servers unlock tools later. On other servers it's still an error.
- **A contrast names tools too:** another tool's name in a sentence with "don't",
  "doesn't", "isn't", "unlike"… ("(get_a and get_b don't answer this)") counts as an
  instruction.
- **Release version vs server-reported version** (FINDINGS F5). `diff` checks the
  semver bump only against release versions: `--release <old>..<new>` (npm, a git
  tag), or `serverInfo.version` when asked (`--server-version-is-release`,
  `serverVersionIsRelease` in the config). Without either, the bump is suggested but
  not checked, and the header marks the versions "(server-reported)". `history`
  passes the npm versions.
- **`description/cut`** says, when the default cut is in use, that a client cutting
  shorter needs `descriptionLimit`, or this run can't see what's buried in between.
- **Before tagging 0.7.0** (a review of the release-prep PR):
  - The Action passes release versions to `diff` (`release` input, default `auto`:
    `package.json` on the PR's base branch → head), so the bump check still runs in CI.
  - `diff` says why the bump wasn't checked: "not checked (calendar version)" or
    "(pass --release)", and keeps "(server-reported)" when it checks against that
    version.
  - The "set descriptionLimit" hint is its own `description/cut` finding: with the
    default cut, descriptions that give instructions after character 280 (one real
    client's cut) are listed, whether or not any description passes 2,048.
  - The Action's `release: auto` works in any language: on a pull request it reads the
    version from `package.json`, `pyproject.toml` (`[project]` or `[tool.poetry]`) or
    `Cargo.toml` (`[package]`) on the base branch and the head; on a tag push it takes
    the previous version tag and this one. A project versioned only by tags (Go,
    setuptools-scm) has no next version in a PR, so its bump is checked at the tag.

## 20. Before the first release: a claims check and a code review

Nothing had checked the claims themselves: the reviews so far covered writing, and the
tests checked the code against the spec, not the spec against reality. Two passes
before 0.7.0:

- **The cache model was wrong.** The end of the tool list isn't the end of the
  prompt. Claude's Messages API renders tools, then system, then messages, and its
  docs say adding, removing or reordering a tool invalidates the entire cache. So a
  tool appended mid-session still re-processes the whole conversation, unless the
  client adds new tools after the cached content (tool search / deferred loading).
  `session/append` is now a warning, and the mid-list estimate is labelled as a floor.
  (0.8 goes further: the estimate "from position p on" still implied the prompt before
  p stayed cached. Findings now give the whole tool list's size and where the change
  starts.)
- **Key order counts.** Comparisons for caching and determinism are byte-exact now:
  a new property order is a `serialization` change. `diff` between releases stays
  semantic.
- **`diff`:** every parameter is checked for changes it doesn't classify, so a
  description change on one parameter can't hide a narrowed enum on another (array
  item enums count too). The suggested bump only counts findings that survive
  `ignore` and rules set to off. A version that goes backwards is flagged; a
  prerelease isn't judged.
- **`history`** orders versions by semver, not publish time, so a backport is diffed
  against its own line.
- **`session`** lists the menu after a failed or timed-out step too, so a change the
  server applied anyway is pinned to that step. An append in the same step as an
  edit is still an append. Removals at the end get a sensible cost line.
- **The Action** diffs against the baseline as it is on the base branch (or the
  previous tag), not the PR's own copy, so a PR that commits its refreshed snapshot
  is still checked.
- **The CLI** waits for stdout to drain before exiting, so piped `--json` isn't cut.
- Wording: "the linters I found", no "common today", and determinism scoped to the
  same inputs (`history` excepted).
- **A second review, of those fixes**, found ten more, several introduced by them: a
  failed menu listing after a step was swallowed (now `session/step-failed`); array
  item types weren't compared; ignored tools could still pair into a rename or a
  reorder (they now leave the comparison); a version going backwards now has its own
  rule, `diff/version-backwards`; build metadata (`+build-1`) no longer reads as a
  prerelease, with one semver parser shared by `diff` and `history`; and piping into
  `head` keeps the exit code instead of crashing on EPIPE.


## 21. 0.8: a second process, and setup failures told apart

From running 0.7 on 25 public servers (FINDINGS F12) and an independent review of
the plan (docs/plans/0.8-roadmap.md).

- **A second process.** `menu/nondeterministic` lists twice on one connection, which
  can't see a menu that's stable within a process and different in the next one.
  mcp-atlassian 0.23.1 is that case: a tool default built from a Python `set`. So
  `snapshot` starts a second process (stdio) or connection (HTTP) and compares
  (`menu/process-variance`, `menu/connection-variance`; HTTP retries once, for rolling
  deploys). `--processes <n>`, default 2.
- **Pinned hash seed.** The main process runs with `PYTHONHASHSEED=0` unless the user
  set it: a Python server's saved menu is then the same on every run, so `diff` and
  the Action don't report set order as a change. The probe gets another seed, so the
  bug shows every time, not by chance. The seed covers `str`/`bytes` hashing (sets of
  strings); Go and Rust maps vary per process with no env var, and the second process
  catches those by chance. A server started through `docker run` doesn't get the
  seed unless it's passed with `-e`; findings say so. `session`'s scope probes use
  the main seed, so ordering variance can't leak into scope verdicts.
- **The value that differs.** Variance and determinism findings name the JSON path
  and both values, and spot the same items in a different order.
- **Setup failures.** With dummy credentials, most calls in a session fail on
  authentication, and 0.7 reported each as `session/tool-error` or
  `session/step-failed`. Failures are classified by their text (patterns from the
  corpus's real errors): authentication, something missing on the machine, the
  network, a 404 on a call that named nothing, invalid arguments, other. The first
  four are one `session/untested` finding: a warning, or an error when no call got
  through, so an expired CI secret can't pass a run that tested nothing.
- **Cache wording.** "~N tokens from position p on, a floor" implied the prompt
  before p stayed cached, which §20 already says isn't so. Findings now give where
  the change starts and the whole tool list's size.
- **Heuristics.** `ids/authored` became `info`, one finding per kind of ID, with
  abbreviations (`org` = `organization`), no kind for a lone qualifier (`parentId`),
  and "found in the URL" as a source. `naming/vague-id` dropped `ref`.

## 22. 0.9: OAuth, `--auto`, the union menu

- **OAuth.** Most hosted MCP servers need an OAuth login, so toolmenu couldn't check
  them. `auth login` implements the SDK's `OAuthClientProvider`: dynamic
  registration (deprecated by 2026-07-28 in favour of Client ID Metadata Documents,
  still supported for a year; CIMD needs a hosted metadata document and comes when a
  server requires it) or a pre-registered client; a loopback redirect on a fixed port
  (`127.0.0.1:33418`), because registration records the exact redirect URI; `state`
  generated and checked by toolmenu (the SDK checks `iss`, not `state`); PKCE and the
  token exchange by the SDK. Stored credentials are bound to the issuer and never
  handed to another authorization server. Outside `auth login`, a flow that would need
  a browser fails with "run `toolmenu auth login`" instead of waiting. Tested end to
  end against a local authorization server (`test/fixtures/oauth-server.mjs`):
  registration, login, refresh, revocation, a forged `state`.
- **`--auto`.** Values only from the schema (`const`, `default`, `examples`, `enum`,
  type and format), never a guessed ID or anything with a `pattern`. Tools marked
  `openWorldHint: true` are opt-in (`--open-world`): they're the web search, fetch and
  scraping tools that spend credits. Unmarked tools are called: on the corpus,
  GitHub, Atlassian and Notion leave the hint unset on every read, and skipping them
  left 18 of 262 read-only tools callable; with this rule it's 60 (84 with
  `--open-world`). The reviewed plan's unlock phase is deferred: no public server in
  the corpus unlocks tools (§ docs/plans/0.8-roadmap.md, 10).
- **The union menu.** Every tool a session saw, first-seen order, last-seen
  definition, as a `toolmenu: 1` file. It replaces the plan's full session traces:
  `diff` already does the comparison.

## 23. 0.10: init, the token breakdown, the catalog

- **`init`**, because setting up CI by hand (baseline, workflow, the project's build
  steps, secrets) was the biggest barrier. Env var and header names that look like
  credentials go into the workflow as `${{ secrets.NAME }}`; values never reach the
  file. Setup actions are pinned to their current majors, checked when written.
- **The token breakdown** is information, not findings. The planned
  `size/dominant-tool` rule was dropped: its evidence came from 0.7.0's inflated
  counts, and recounted, no server in the corpus has a problem it would catch.
- **The catalog.** Search and execute is where large servers go (FINDINGS F14): the
  menu stays small and the operations move behind a search tool, out of `diff`'s
  sight. `--catalog` finds the search tool (read-only, one required query, named
  `search_*_tools`, `discover`…), asks a fixed set of queries (from the config, or
  derived from the menu's nouns: the same menu gives the same queries), and collects
  objects with a name and a JSON Schema, or Atlassian's `inputs` list, converted.
  Operations found in both snapshots go through the tool rules; found on one side
  only, or with different or failed queries, they're notices: a search is ranked and
  partial, and a false "removed" would be worse than a missed one. Hosted servers
  rate-limit searches (Sentry did after ~70), so queries are paced (300 ms) and a
  rate limit is retried (2, 4, 8 s) before a query is left out.


## 24. 0.11: the catalog crawls

0.10's fixed queries found 8 of Atlassian's ~154 operations. Most of that was a bug:
`discover` returns JSON followed by a prose list of related operations, and the whole
text was dropped as invalid JSON. The leading JSON value is read now. The rest was
the query design: a search returns its top matches, so a fixed list only reaches what
it happens to name. The catalog's own names reach the rest: every operation found or
mentioned becomes a query (its name split into words), breadth first in the order
found, so the same catalog gives the same path. Seeds are the search tool's own
example phrases (quoted in its description), then the menu's nouns, or the config's
queries. It stops when 20 queries in a row find nothing new, at most 200. Measured
against Atlassian's `?tools=all` as ground truth: 154 of 154, no false operations.


## 25. Messages: what every finding and error says

Every finding and every error is read by two kinds of reader: a person skimming a PR
comment, and an agent that has to act on it without seeing toolmenu's code. Both need
the same four things, in this order:

1. **The problem**, in the first sentence, in plain words: what is wrong and why it
   matters ("A second server process served a different menu, so every restart misses
   the prompt cache."). No rule jargon; the rule id is shown next to it already.
2. **Where**: the tool, the parameter path (`list_transactions.end_date.default`), the
   step, the file or the URL. Name it exactly, so it can be searched for.
3. **How it happened**: the observed values, the call, the two versions compared
   (`"…21.528Z" vs "…21.537Z"`), the server's own words. In `detail` when it's long.
4. **The next step**, in `fix`: one instruction the reader can act on ("Build the
   default from a fixed value, not the current time."; "Rerun with --processes 1.").
   Shown as `→ Next:` in every format. Left out only when there is nothing to do.

When toolmenu is not sure, because the finding is a heuristic (names, words) or an
inference (a failure whose cause it can't see), the finding sets `confidence:
'unsure'` (shown as `· unsure` next to the rule), and the message says what was seen and where, not
what it means: "get_form needs a form_id, and no tool in the menu appears to return
one" rather than "the agent will invent form_id". It still gives a next step when one
is safe ("If an ID comes from a URL the user pastes, ignore this.").

Errors that stop a command follow the same order: what failed, at which stage
(starting the server, `server/discover`, `initialize`, `tools/list`, a call), what was
seen (exit code, HTTP status, the server's last stderr lines, the first stray stdout
line), and what to try next.

Also:
- One root cause, one finding. A finding caused by another one (a menu that changes on
  every list also changes mid-session) points to it instead of repeating it.
- The same change in many places is one finding that lists the places, not one per place.
- Numbers carry their unit and whether they are estimates (`~1,240 tokens, estimate`).
- No internal names (function names, variable names) in messages.
