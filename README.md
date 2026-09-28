# toolmenu

**Lint your MCP server's tool menu for changes that confuse agents or break caches.**

Most MCP linters grade one snapshot of the menu an agent reads: tool names,
descriptions, schemas. toolmenu observes how the menu behaves across calls,
connections and releases, and checks **when** it changes:

- **Mid-session.** A menu that changes after the conversation has started can break
  the prompt cache from that point on. In my logs, one mid-conversation unlock
  rewrote 40–57K tokens of cached prefix. `session` catches it, pins it to the step
  that caused it, and says where in the list it happened.
- **Ready for 2026-07-28.** The new MCP spec says the tool set **must not** vary per
  connection or as a side effect of other requests. Per-session "unlock" designs,
  common today, are ruled out. `session` tells you whether yours is one of them.
- **Between releases.** `diff` finds breaking changes and token growth, and checks
  the version bump.

![toolmenu session output: tools inserted mid-list, a description edited, each pinned to the step that caused it](docs/demo.svg)

No LLM anywhere: every command is deterministic, so CI gives the same answer every
run.

> **Status: 0.7, early.** Spec in [docs/SPEC.md](docs/SPEC.md). What it has found on
> real servers: [docs/FINDINGS.md](docs/FINDINGS.md).

## Start here

```sh
# write a starter scenario from your server's menu, then run it
npx toolmenu session --init -- node dist/server.js
npx toolmenu session --scenario scenario.yml -- node dist/server.js

# snapshot the menu and commit menu.json as your baseline
npx toolmenu snapshot -- node dist/server.js
```

HTTP servers work the same way: `npx toolmenu snapshot https://example.com/mcp --header "Authorization: Bearer $TOKEN"`.
Both protocol generations are supported: 2026-07-28 (`server/discover`, stateless)
and the 2025 `initialize` handshake, through the official TypeScript SDK.

## In CI: one PR comment

```yaml
# .github/workflows/toolmenu.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  toolmenu:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - uses: niksa90/toolmenu@v0.7.0
        with:
          command: node dist/server.js
          baseline: menu.json          # your committed snapshot
          scenario: scenario.yml       # optional: run a session too
```

It snapshots the PR's build, diffs it against the baseline, runs the scenario, and
posts **one comment that updates on every push**: breaking changes, the token change
("this PR adds ~1,240 tokens to every conversation"), the suggested version bump,
and anything `session` caught. The same report goes to the job summary. Inputs:
`command` or `url`, `baseline`, `scenario`, `fail-on` (default `error`), `comment`
(default `true`), `version`, and `release`: the release versions for the bump check.
Its default, `auto`, works in any language: on a pull request it reads the version in
`package.json`, `pyproject.toml` or `Cargo.toml` on the base branch and the head; on a
tag push it compares the tag with the previous version tag. Projects versioned only by
git tags (Go, setuptools-scm) get their bump checked when the tag is pushed, so add
`push: { tags: ['v*'] }` to the workflow's `on:`. Or set `"1.4.0..1.5.0"` yourself, or
`off`.

## `session`: the menu changing while the agent works

`session` runs a scripted session (the scenario *is* the agent), lists the menu
after every step, and reports each change with the step that caused it.

```yaml
# scenario.yml
allow_writes: false          # refuse to call tools not marked readOnlyHint
steps:
  - list
  - call: search_forms
    args: { query: onboarding }
  - call: unlock_toolset
    args: { toolset: audits }
  - wait_for: tools_list_changed   # optional; timeout_ms defaults to 5000
```

`--init` writes a starter scenario from the live menu: it calls every read-only tool
that needs no arguments, then repeats one. If a tool looks like it unlocks more tools
(a `domains` or `toolset` parameter with an enum, "unlock" or "capabilities" in its
name or description), the starter unlocks two values for real and repeats the first.
Anything it can't fill in is left as a commented-out step. A scenario is only as good
as its steps, so the starter is a floor, not a ceiling.

| Rule | Default | Catches |
|---|---|---|
| `session/mid-insert`, `session/reorder`, `session/remove`, `session/edit` | error | The menu changing mid-session anywhere but the end, with the estimated tokens of cached prefix affected |
| `session/append` | info | Tools added at the end: usually cache-friendly |
| `session/connection-local` | error on 2026-07-28 (HTTP) | A change only this connection sees. 2026-07-28: the tool set MUST NOT vary "per-connection or as a side effect of other requests on the connection" |
| `session/side-effect` | warn on 2026-07-28 (stdio) | The same, where stdio can't tell per-connection from global |
| `session/connection-variance` | error/warn | A second connection with the same credentials gets a different menu |
| `session/unannounced` | warn | The menu changed without `notifications/tools/list_changed`, although the server declared `listChanged` |
| `session/refused`, `session/step-failed` | error | A write the scenario didn't allow, or a call that failed |
| `session/tool-error` | warn | A tool that answered with an error (`isError`, an expired token): the run tested less than it looks |

**`session` calls tools for real.** Without `allow_writes: true` it refuses any tool
not marked `readOnlyHint: true`. `--plan` prints the steps without connecting.

## `diff`: compare releases

```sh
npx toolmenu diff menu.json new-menu.json
```

```
toolmenu diff  secure-filesystem-server 0.2.0 → 0.2.0
  14 → 14 tools · ~2,638 → ~2,821 tokens (+183, estimate): this release adds ~183 tokens to every conversation that loads the menu
  1 breaking · 0 minor · 15 notice · suggested bump: major · actual: none

ERROR  diff/safety-hint
       move_file was additive-only and is now destructive.
…
```

That's two real releases of the official filesystem server. Changes are classified
the way OpenAPI breaking-change checkers do it:

| Class | Changes | Rules |
|---|---|---|
| **breaking** (error) | tool removed or renamed, parameter removed, new required parameter, narrower or different type, enum narrowed, a tool becoming less safe (no longer read-only, or additive → destructive) | `diff/tool-removed`, `diff/tool-renamed`, `diff/param-removed`, `diff/param-required`, `diff/param-type`, `diff/enum-narrowed`, `diff/safety-hint` |
| **minor** (info) | tool added, new optional parameter, parameter now optional, type or enum widened | `diff/tool-added`, `diff/param-added`, `diff/param-relaxed`, `diff/type-widened`, `diff/enum-widened` |
| **notice** (info) | optional parameter dropped (extra properties still allowed), description changed (with the text diff: it changes what the agent does), output schema, annotations, other fields, order | `diff/param-dropped`, `diff/description`, `diff/schema-other`, `diff/annotations`, `diff/other`, `diff/order` |

It also reports the token change per tool and suggests a semver bump. To check the
bump, pass the **release** versions: `--release 1.4.0..1.5.0` (npm, a git tag).
`diff/version-bump` then warns when the release's bump is smaller (`0.0.x` promises
nothing and `0.x` may break in a minor). The version in the snapshot is what the
server reports (`serverInfo.version`), which is often not the release: the filesystem
server has said `0.2.0` for 19 releases (FINDINGS F5). It's shown, and only checked
with `--server-version-is-release`. `diff` also enforces an optional `tokenBudget` (`diff/token-budget`). Order
changes are only a notice here: between releases, prompt caches rebuild. Order
matters *within* a session.

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

## `snapshot` rules

Every rule comes from a failure I actually hit building 115 tools for one MCP
server, or from the spec itself. If a rule can't point to one, it doesn't ship.

| Rule | Default | Catches |
|---|---|---|
| `menu/nondeterministic` | error | Two identical `tools/list` calls returning different menus (order, descriptions, schemas, annotations) |
| `spec/schema` | error | A `tools/list` result that fails the official schema for its protocol version |
| `naming/route` | error | A `routes.yml` expectation broke: a keyword now matches the wrong tool at least as well as the right one |
| `description/buried` | warn | Instructions to the agent ("use X instead", "call X first", "don't retry", "never guess one") past the point where your client cuts descriptions: Claude Code's 2,048 characters by default, or your client's `descriptionLimit`. Each one past the cut counts, including one the cut falls inside; descriptions of behaviour ("never throws", "instead of failing") don't. From a real failure: a client cut a description at 280 characters, and the line that decided routing was at 1,222 |
| `description/cut` | info | Descriptions longer than the client sends, with nothing that reads as an instruction past the cut, as one summary. The model gets a prefix that can read as complete |
| `naming/vague-id` | warn | A parameter called just `id` that doesn't say *which* thing |
| `ids/authored` | warn | An ID the agent must supply that no tool appears to return, so the agent may invent it (heuristic) |
| `write/unannotated` | warn | A tool named like a write (`delete_`, `send_`…) with no annotations |
| `naming/shared-word` | info | Nouns that name different things across tools (`list_team_audits` vs `get_audit_trail`), as one summary |
| `write/no-dry-run` | info | Destructive tools with no dry-run parameter or preview tool, as one summary |
| `spec/discover` | info | The server only speaks the 2025 protocol, so 2026-07-28 rules are skipped |
| `spec/deprecated`, `spec/cache-hints` | info | 2026-07-28: deprecated features still advertised; `ttlMs: 0`, or `cacheScope: "public"` on a server that took credentials |

The naming and ID rules are heuristics, tuned on real servers (FINDINGS F7 and
F10) and a private 115-tool one. They're the extras; the change checks are the point.

**Pin routing with `routes.yml`.** Two tools fighting over one word needs a regression
test, not a rename you'll forget:

```yaml
audit:
  must_match: [list_team_audits]
  must_not_match: [get_audit_trail]
audit trail:
  must_not_match: [get_store_scores]   # on its own: must not match at all
```

Matching is keyword matching, the way a keyword or BM25 tool search sees the menu: a
tool matches if every word of the route is in its name or description (the exact
phrase scores higher). It can't read "not", and neither can those searches: a
disclaimer like "not the audit trail" puts "audit trail" into exactly the tool you
meant to steer away from, and toolmenu says so.

**Config** (optional `toolmenu.config.json`):

```json
{
  "rules": { "naming/shared-word": "off", "ids/authored": "error" },
  "ignore": ["debug_*"],
  "routes": "routes.yml",
  "tokenBudget": 4000,
  "descriptionLimit": "claude-code",
  "fullDescriptions": ["search_capabilities", "lookup_*"]
}
```

`descriptionLimit` is where your client cuts tool descriptions: a number, or a client
whose cut is documented: `"claude-code"` (2,048, the default; changeable since Claude
Code 2.1.280 with `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`) or `"amazon-q"` (10,024).
Clients that send descriptions in full don't need a setting beyond that. If your own
client cuts shorter, as mine did at 280, set its number. `fullDescriptions` lists the
tools it sends uncut, so the description rules skip them.

## What toolmenu can't catch

toolmenu sees what the server sends. Plenty of agent failures happen elsewhere:

- **Routing to a feature with no tools.** If the agent reaches for something your
  menu doesn't have, no menu check can see the gap.
- **What the client does with the menu.** Truncating descriptions, sorting or
  filtering tools, merging several servers. The description rules use Claude Code's
  documented cut unless you set yours (`descriptionLimit`); they can't see your client.
- **Your code and your logs.** A capability check that's answered with one yes/no
  for two different behaviours, or a log line that reads the same whether something
  happened or not. Those live in the client or the server's code.
- **Whether the agent actually picks the right tool.** That needs evals with a model.
  toolmenu stays deterministic on purpose.

## Options

```
--out <path>        where to write the menu (default: menu.json)
--no-write          don't write the menu file
--routes <path>     routes.yml
--config <path>     config file (default: toolmenu.config.json, if present)
--format <fmt>      text (default), json, github (annotations) or markdown
--fail-on <level>   error (default), warn or info
--header <k: v>     HTTP header, repeatable
--env <K=V>         env var for a stdio server, repeatable (it only gets a
                    minimal environment otherwise)
--timeout <ms>      per-request timeout (default: 30000)
```

Exit codes: `0` clean · `1` findings at or above `--fail-on` · `2` couldn't connect
or bad usage. `toolmenu --help` lists the `session` and `history` options.

## Limitations

- **Server order isn't final client order.** Clients merge tools from several servers
  and may sort or filter them. A stable server menu is necessary for cache hits, not
  sufficient. toolmenu measures what the server controls.
- **Token counts are estimates** (`o200k_base`). Vendors tokenize, cache and bill
  differently.
- **Heuristic rules say so** in their messages.
- Not a security scanner or a full conformance suite. Other tools do those well.

## License

MIT
