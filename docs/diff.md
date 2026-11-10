# `diff`, `review`, `--catalog` and `history`: between releases

```sh
npx toolmenu diff menu.json new-menu.json
```

```
$ npx toolmenu diff --release 2026.1.14..2026.8.31 fs-2026.1.14.json fs-2026.8.31.json
toolmenu diff  secure-filesystem-server 2026.1.14 → 2026.8.31
  changes  1 breaking (1 tool) · 0 minor · 3 notice (13 tools)
  version  suggested bump: major · not checked (calendar version)
  tokens   ~1,640 → ~1,664 (+24, estimate): this release adds ~24 tokens to every conversation that loads the menu
  tools    14 → 14

ERROR  diff/safety-hint
       `move_file` was marked additive-only and is now destructive (destructiveHint false → true; unset means destructive). Clients that auto-approve additive tools may now ask first.
       → Next: If the tool still never deletes or overwrites, set destructiveHint: false; if it does now, say so in the release notes.
INFO   diff/annotations
       Annotations changed the same way (openWorldHint (unset) → false) in 13 of 14 tools: read_file, read_text_file, read_media_file, read_multiple_files, write_file, edit_file, … (+7).
…
```

That's two real releases of the official filesystem server. Its calendar versions
promise nothing about compatibility, so the bump isn't judged, but the breaking change
is still an error. Changes are classified
the way OpenAPI breaking-change checkers do it:

| Class | Changes | Rules |
|---|---|---|
| **breaking** (error) | tool removed or renamed, parameter removed, new required parameter, narrower or different type, enum narrowed, unlisted properties now rejected (`additionalProperties: false` added), a tool becoming less safe (no longer read-only, or additive → destructive); with `--lists` on both sides, a prompt removed or newly requiring an argument, a resource template removed | `diff/tool-removed`, `diff/tool-renamed`, `diff/param-removed`, `diff/param-required`, `diff/param-type`, `diff/enum-narrowed`, `diff/properties-closed`, `diff/safety-hint`, `diff/prompt-removed`, `diff/prompt-argument-required`, `diff/resource-template-removed` |
| **minor** (info) | tool added, new optional parameter, parameter now optional, type or enum widened, unlisted properties now accepted (`additionalProperties: false` removed), a prompt or resource template added | `diff/tool-added`, `diff/param-added`, `diff/param-relaxed`, `diff/type-widened`, `diff/enum-widened`, `diff/properties-opened`, `diff/prompt-added`, `diff/resource-template-added` |
| **notice** (info) | optional parameter dropped (extra properties still allowed), description changed (with the text diff: it changes what the agent does), output schema, annotations, other fields, order, a schema restructured but accepting the same input, only the declared `$schema` dialect changed, a prompt's description or optional arguments, resources added or gone (data, so no bump) | `diff/param-dropped`, `diff/description`, `diff/schema-other`, `diff/annotations`, `diff/other`, `diff/order`, `diff/schema-equivalent`, `diff/schema-dialect`, `diff/prompt-changed`, `diff/resources` |

The same rules apply inside parameters: fields of an object parameter, array items,
and the options of an `anyOf`/`oneOf` union (zod's unions, discriminated unions and
`.nullable()`) are compared at every depth, with their path (`gen.body.text`,
`search.filters[].field`, `gen.block(kind="image").url`). Union options are paired by
the value of a discriminator they all fix; without one (a plain `z.union` of objects),
identical options first, so a reorder is no change, then by type and shared property
names. An option gone is breaking, a new one widens. The same change reached through
one shared definition at several places is one finding that lists them (`places` in
`--json`). Local `$ref`s (`#/$defs/…`, `#/definitions/…`) are expanded first,
recursive ones one level deep, so a schema is compared by what it accepts, not how
it's spelled: moving a repeated block into `$defs` is one `diff/schema-equivalent`
notice with its token change ("accepts the same input: ~899 tokens fewer"), and a
breaking change inside `$defs` is breaking. A schema change no rule classifies is
never silent: it's a `diff/schema-other` "review it".

On mongodb-mcp-server 2.1.2 → 3.0.0 this finds `aggregate.pipeline[]…$vectorSearch.numCandidates`
and `.limit` narrowed from `number` to `integer` inside a union, where the whole
`pipeline` used to be one "review it".

Different spellings of the same schema are one schema (`additionalProperties` absent,
`true` or `{}`; zod 4's safe-integer bounds), and a change every tool shares is said
once for the menu: a server moving from zod 3 to zod 4 reads as its real changes (a
field that became required, the patterns zod 4 adds to `email` and `uuid`) plus one
`diff/properties-opened` line ("27 tools now accept properties they don't list … most
likely a schema generator upgrade"), not a "review it" per object.

The same change in many tools is reported once, with the tools it touches (`pageId`
is new and required in 25 of 29 tools, on chrome-devtools-mcp 1.8.0); counts are per
change. When a tool loses a parameter and gains a required one with a close name,
`diff/param-renamed` (warn, unsure) points out the likely rename; both changes stay
breaking. Every breaking finding's next step names the version to release when the
bump is too small.

It also reports the token change per tool and suggests a semver bump. To check the
bump, pass the **release** versions: `--release 1.4.0..1.5.0` (npm, a git tag).
`diff/version-bump` then warns when the release's bump is smaller. Under 1.0.0 it
reads versions as npm's caret does (`^0.2.3` accepts any 0.2.x): breaking changes need
a minor bump, new features a patch, and under 0.1.0 anything goes.
`diff/version-backwards` warns when the version goes down. Calendar versions and prereleases aren't judged. The version in the snapshot is what the
server reports (`serverInfo.version`), which is often not the release: the filesystem
server has said `0.2.0` for 19 releases (FINDINGS F5). It's shown, and only checked
with `--server-version-is-release`. `diff` also enforces an optional `tokenBudget`
(`diff/token-budget`). Order changes are only a notice here: between releases, prompt caches rebuild. Order
matters *within* a session.

## Accepting a new baseline: `review`

`diff` says what changed. Before you commit a refreshed `menu.json`, `review` answers
the question that follows: should it replace the baseline?

```sh
npx toolmenu snapshot --out new-menu.json -- node dist/server.js
npx toolmenu review --release 1.4.0..1.5.0 menu.json new-menu.json
```

```
toolmenu review  new-menu.json as the new menu.json
  verdict   ✗ don't accept as is: 1 breaking change, and the release's minor bump is too small (release 2.0.0).
  changes   1 breaking (1 tool) · 0 minor · 3 notice (13 tools)
  findings  0 new · 0 gone · 1 changed · 1 unchanged
```

It runs `diff`, and runs the menu rules on both files, so it also says which findings
the new menu **adds**, which it **clears**, and which **changed** (a summary that now
names another tool counts as worse). The verdict is one of:

| Verdict | Exit | When |
|---|---|---|
| `unchanged` | 0 | The same menu and the same findings |
| `safe` | 0 | Nothing breaks callers, and no finding at or above `--fail-on` is new or worse |
| `breaking-released` | 0 | Breaking changes, and `--release` shows a bump that allows them |
| `breaking` | 1 | Breaking changes, and no release that allows them: none given, too small, or not checkable (calendar versions) |
| `review` | 1 | Nothing breaks, but findings at or above `--fail-on` are new or worse, or `diff`'s own checks fail (`tokenBudget`) |

It reads only the two files, so rules that need the live server (a second process,
the raw `tools/list`) aren't part of it; `snapshot` runs those. `--format markdown`
gives the same as a PR comment, `--json` for scripts (`verdict`, `accept`, and the
findings by kind).

## Operations behind a search tool (`--catalog`)

Big servers increasingly keep most operations out of the menu: a small fixed menu, a
search tool, and an execute tool (Sentry's `search_sentry_tools` + `execute_sentry_tool`,
Atlassian's `discover` + `executeRead`). A breaking change to one of those operations
never shows in the menu. `snapshot --catalog` asks the search tool a fixed set of
queries and keeps the operations it returns in `menu.json`; `diff` then compares
operations found in both snapshots with the same rules as tools.

```sh
npx toolmenu snapshot --catalog -- node dist/server.js
```

A search returns only its top matches, so toolmenu crawls the catalog by its own
words: it starts from the search tool's own example phrases and the nouns in your tool
names, then searches for every operation it finds or sees mentioned, until 20 queries
in a row turn up nothing new (at most 200). On Atlassian's hosted server that finds all
154 operations behind its 21 tools; on Sentry's, 65 behind 9, the same on every run.
Queries are paced and a rate limit is waited out. An operation not found this time is a
notice (`diff/catalog-missing`: "not returned by the same queries"), never "removed";
one found only now is `diff/catalog-added`, and catalogs read with different queries,
or partly (a query failed), are `diff/catalog-queries`. To steer it, set
`"catalog": { "queries": [...], "maxQueries": 200, "crawl": true }` in
`toolmenu.config.json` (FINDINGS F15).

A crawl through search is a lower bound, not a proof: an operation that nothing in the
catalog names, and whose words no query uses, stays unfound. On `@sentry/mcp-server`
0.42 (stdio) it finds 63 of the 64 operations in the package's catalog; `whoami` comes
back only when asked for by name. Add queries like that to `catalog.queries`.

**Command routers.** Some servers put their operations behind router tools instead:
one tool per area that takes a `command` and its `parameters`, and lists its commands
when called with `learn: true` (Azure's MCP server serves 71 such tools in front of
~410 operations). `--catalog` detects them (a `command` parameter, an arguments
object, a boolean listing flag, and a description that says "router" or "sub
commands") and calls each once in its listing mode, never with a command, so nothing
runs. Routers whose command is required aren't called. Detection missed one? Name
them: `"catalog": { "routers": ["keyvault", "storage"] }`. A router lists everything
it has, so unlike a search the catalog is complete except for routers that failed
(`catalog/failed` says which, and why).

## `history`: a package's releases, researched

```sh
npx toolmenu history @modelcontextprotocol/server-filesystem --versions 19 --arg /tmp --csv fs.csv
```

It installs each published version into a temp directory (install scripts off),
snapshots it, and diffs it against the previous version that worked. For every
version it records the protocol, the menu, the findings and the **dependency
versions that actually got installed**: an old version installed today resolves its
dependencies today, and can serve a different menu than it shipped with.

It's best effort: packages that need env vars, arguments or auth are recorded as
failed, with a reason, never skipped. **It installs and runs third-party code. Run it
in a container.**
