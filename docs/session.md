# `session`: the calls, the results, and the menu while the agent works

`session` runs a scripted session (the scenario *is* the agent), lists the menu
after every step, and reports each change with the step that caused it.

```
 step   the scenario (the agent)          the menu the client sees          toolmenu
 ────   ───────────────────────────────   ───────────────────────────────   ─────────────────────────────
  1     list                              search_forms, get_form, …         baseline: 5 tools
  2     call search_forms                 (unchanged)                       no change
  3     call unlock_toolset audits        search_forms, list_team_audits,   +2 tools at position 1:
                                          get_team_audit, get_form, …       session/mid-insert (error)
                                                                            fresh process: not there →
                                                                            session/side-effect (warn)
```

Each step's menu is compared with the one before it, so a change is pinned to the call
that caused it, with where in the list it starts and what it costs the prompt cache.
toolmenu then starts a second process (or opens a second connection) to see whether
the change is global, or only this session's, which 2026-07-28 rules out.

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
name, a description that says it enables or loads tools), the starter unlocks
**every** value, listing after each, then repeats the first, so the session sees every
tool behind the unlock. The values come from the parameter's enum or, without one,
from the server's own read-only listing (`list_toolsets`). Lookups that only describe
toolsets (`list_toolsets`, `get_toolset_tools`) aren't unlocks, and one not marked
read-only is suggested, never called. Anything it can't fill in is left as a
commented-out step. An unlock nothing in the menu names, like joining a room that
brings more tools, needs a step you add yourself. A scenario is only as good as its
steps, so the starter is a floor, not a ceiling.

On github-mcp-server 1.0.5 with `--dynamic-toolsets` (3 tools at the start, 19
toolsets), unlocking every toolset reaches 107 tools: all 81 that `--toolsets all`
serves, and 23 issue and pull-request tools that only the dynamic mode has.

| Rule | Default | Catches |
|---|---|---|
| `session/mid-insert`, `session/reorder`, `session/remove`, `session/edit` | error | The menu changing mid-session anywhere but the end, with where the change starts and which value changed. Any change to the tool list invalidates the cached prompt: the whole tool list (its size, estimated) and the conversation after it are processed again |
| `session/append` | warn | Tools added at the end of the list. Still a cache miss for the conversation when your client sends tools at the start of the prompt (Claude's Messages API does); cache-safe only when the client adds new tools after the cached content, as tool search (deferred loading) does |
| `session/connection-local` | error on 2026-07-28 (HTTP) | A change only this connection sees. 2026-07-28: the tool set MUST NOT vary "per-connection or as a side effect of other requests on the connection" |
| `session/side-effect` | warn on 2026-07-28 (stdio) | The same, where stdio can't tell per-connection from global |
| `menu/process-variance`, `menu/connection-variance` | error | Checked before the first step, as in `snapshot` (below) |
| `session/unannounced` | warn | The menu changed without `notifications/tools/list_changed`, although the server declared `listChanged` |
| `session/untested` | warn, error if no call got through | Calls that failed before reaching the tool: authentication, something missing on this machine (no Chrome), the network. One finding for the run, not one per step, so an expired CI secret doesn't pass a run that tested nothing |
| `session/refused`, `session/step-failed` | error | A write the scenario didn't allow, or a call that failed for another reason |
| `session/tool-error` | warn | A tool that answered with an error for another reason (`isError`): the run tested less than it looks. The same error at several steps is one finding that names them |
| `session/known-variance` | info | A mid-session change only in values that already vary from one tools/list to the next: same cause as the finding it names, not counted again |
| `session/assumed-read-only` | info | Tools called on your word (`--assume-read-only`, `assume_read_only`) although the server doesn't mark them readOnlyHint |
| `session/unlock-coverage` | warn | An unlock whose enum lists its values, called with only some of them: the tools behind the rest were never seen, so a baseline from the session misses them. With `--union-out` or `--auto`, an unlock never called at all too, with why `--auto` skipped it |
| `session/nothing-called` | warn | `--auto` called no tools (all open-world, missing values, or not read-only): the run only listed the menu |
| `session/session-lost` | error | The server ended the session after toolmenu opened a second connection with the same credentials (servers with one session per client; 2025-era servers only). The run stops there; rerun with `--processes 1` |
| `session/handle-error` | warn | 2026-07-28: `--auto` called a read-only tool with a handle that can't exist (`toolmenu-unknown-session`), and it answered with a protocol error instead of a tool error the model can read |
| `session/error-not-flagged` | warn | A tool answered with an HTTP error from the API behind it (`{"status":401,"object":"error",…}`) as a plain result, not marked `isError`, so a client that reads `isError` takes the call for a success (Notion's server). An auth one also counts toward `session/untested`. Tools that take a URL are left out: their answer is the page's (heuristic) |
| `session/server-unresponsive` | error | The server stopped answering after a step: even `tools/list` timed out. The run stops there with this one finding, instead of every later step waiting out its timeout (a server that polls a device-code sign-in inside a tool call) |
| `session/handle-roundtrip` | warn | With `--create-handles`: the tool that creates a session, basket or cart was called, and the tools that take it back refused the handle it had just returned (info when its result had no handle to find) |
| `session/output-schema` | error | A tool that declares an `outputSchema` answered with no `structuredContent`, or one that doesn't match it: from 2025-06-18 a **MUST**, and the official SDK client raises an error instead of the answer |
| `session/rate-limited` | error | The server kept refusing requests for being too many (a 429) after toolmenu waited about a minute, or a tool not marked `readOnlyHint` said it was rate-limited (it isn't called again). The run stops there, with the steps it didn't check; give the run its own server instance or raise the limit for it |
| `session/scope-unchecked` | info | A second server process or connection couldn't start mid-session (a server that holds a file or a port), so whether a change was global wasn't checked. Said once for the run |

**No scenario? `session --auto`** builds the steps from the menu: every read-only tool
whose required arguments the schema itself gives (a `default`, `examples`, an `enum`,
a type or format), cheapest first, then every value of each read-only unlock (outside
`--max-calls`, and the first value twice: a second identical unlock should change
nothing), then the first call again. It never guesses an ID: a tool that needs
`owner`, `repo` or an issue key is skipped, and the report names the flag that fills
it: `--value repo_path=/src/app` fills that parameter on every tool that requires it,
`--value get_issue.issue_key=ABC-1` on one tool, `--values-file values.yml` takes a map
of either. Servers that don't mark their tools `readOnlyHint` (DeepWiki, every
2024-11-05 server) get nothing called unless you vouch for them by name:
`--assume-read-only read_wiki_structure,ask_wiki_question`. Only exact names are
accepted: a pattern would also cover tools a later release adds. A tool marked or
named as a write is never called, and the report says which tools ran on your word.
With `--create-handles` on 2026-07-28, `--auto` also calls the tool that creates a
session, basket or cart (`start_session`; a write, so only with the flag, and never
one marked `destructiveHint`; not locks, leases or checkouts) and gives the tools that
take it back the handle it returned, beside the made-up one.
`--save-scenario auto.yml` writes the steps, with the skipped tools commented out, for
you to fill in. Tools marked `openWorldHint: true` (web
search, fetch, scraping, which can cost API credits) are called only with
`--open-world`, except unlocks: changing the menu is what a session watches, and an
unlock spends no search credits, so it runs even on a server that marks every tool
open-world. A run that ends up calling nothing is `session/nothing-called` (warn),
with why each tool was left out, not a clean pass. On the 22 servers in `bench/`,
`--auto` reaches 60 of 262 read-only tools, 84 with `--open-world`.

**`session` calls tools for real.** Without `allow_writes: true` it refuses any tool
not marked `readOnlyHint: true`. `--plan` prints the steps without connecting.

**`--call-everything`** (with `--auto`, stdio only) calls **every** tool once, writes and
open-world ones included, with a made-up value (`toolmenu-test`, `1`, a one-item list)
where the schema gives none. It's for a server in a sandbox with nothing to lose: a
container with no credentials and no network, as `bench/scripts/batch-full.sh` runs
them with `SEALED=1`. Every tool's answer is then checked: results against their own
`outputSchema`, errors flagged as errors, calls that hang. It's refused over HTTP,
because a hosted server's tools act on someone's real account.
