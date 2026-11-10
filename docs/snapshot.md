# `snapshot`: one menu, checked

`snapshot` connects, lists the tools, checks the list and writes `menu.json`, the file
`diff` and `review` compare. This page has its rules, the token breakdown, `routes.yml`,
the config file, and `scan` for a whole client config. What each client does with the
menu is in [clients.md](clients.md).

## Rules

Every rule comes from a failure I actually hit building 115 tools for one MCP
server, or from the spec itself. If a rule can't point to one, it doesn't ship.

| Rule | Default | Catches |
|---|---|---|
| `menu/nondeterministic` | error | Two identical `tools/list` calls returning different menus (order, descriptions, schemas, annotations), with the value that differs |
| `menu/process-variance` | error | A second server process, started the same way, serves a different menu, so every restart misses the cache. Seen on mcp-atlassian: a default built from a Python set, in a new order every start (FINDINGS F12). toolmenu runs the main process with `PYTHONHASHSEED=0`, so a Python server's saved menu is reproducible, and the second with another seed. `--processes 1` turns it off |
| `menu/connection-variance` | error (warn on 2025 protocols) | The same over HTTP: a second connection with the same credentials gets a different menu. Retried once before reporting |
| `spec/schema` | error | A `tools/list` result that fails the official schema for its protocol version |
| `spec/tools-capability` | error | The server doesn't declare the `tools` capability, so clients (the official SDK included) never ask for its tools |
| `menu/duplicate-name` | error | Two tools with the same name: only one can be called, and some clients reject the list |
| `naming/route` | error | A `routes.yml` expectation broke: a keyword now matches the wrong tool at least as well as the right one |
| `description/buried` | warn | Instructions to the agent ("use X instead", "don't retry", "never guess one") past the point where your client cuts descriptions: in Claude Code 16,384 characters for a tool loaded through tool search (its default) and 4,096 for one that loads up front, or your `descriptionLimit`. From a real failure: a client cut at 280 characters, and the line that decided routing was at 1,222 |
| `description/cut` | info | Descriptions longer than the client sends, with nothing that reads as an instruction past the cut, as one summary that shows where each one is cut. The model gets a prefix that can read as complete |
| `description/late-instruction` | info | With the default cut: instructions after character 280, which a client that cuts descriptions short would hide, as one summary. Set `descriptionLimit` and `description/buried` checks your real cut instead. (Before 0.13 this was part of `description/cut`; that id's setting still applies.) |
| `naming/vague-id` | warn | Parameters called just `id` that don't say *which* thing, as one summary with a suggested name |
| `ids/authored` | info | An ID the agent must supply that no tool appears to return, so the agent may invent it, one finding per kind of ID (heuristic: IDs from a URL or another tool's text output look the same) |
| `ids/handle-lifetime` | info | 2026-07-28: a tool that creates a handle another tool takes back (`start_session` → `session_id`) doesn't say how long it lasts (heuristic) |
| `write/unannotated` | warn | Tools named like writes (`delete_`, `send_`…) with no annotations, as one summary grouped by the annotation each name suggests |
| `naming/shared-word` | info | Nouns that name different things across tools (`list_team_audits` vs `get_audit_trail`), as one summary |
| `write/read-only-mismatch` | warn | A tool marked `readOnlyHint: true` whose name says it writes (`create_my_account`): clients act on the hint, and `--auto` doesn't call it on the hint alone (heuristic) |
| `write/no-dry-run` | info | Destructive tools with no dry-run parameter or preview tool, as one summary |
| `spec/discover` | info | The server only speaks the 2025 protocol, so 2026-07-28 rules are skipped |
| `spec/deprecated`, `spec/cache-hints` | info | 2026-07-28: deprecated features still advertised; `ttlMs: 0`, or `cacheScope: "public"` on a server that took credentials |
| `lists/variance` | warn | With `--lists`: `prompts/list`, `resources/list` or `resources/templates/list` differs between two calls, or from a second process or connection (2026-07-28: lists no longer vary per connection) |
| `lists/schema` | error | With `--lists`: a list result that doesn't match the official schema (2026-07-28 requires `ttlMs` and `cacheScope` on each), or a declared list that fails to answer (warn; info for Method not found, or a setup failure such as missing credentials) |
| `lists/resource-unreadable` | warn | With `--read-resources`: a resource `resources/list` names that `resources/read` fails on, or answers with only an error for a body (unsure). info for an empty `contents` |
| `lists/resource-read-schema` | error | With `--read-resources`: a `resources/read` result that doesn't match the official schema of the negotiated version, or one the official SDK client refuses |
| `lists/resource-unread` | info | With `--read-resources`: the listed resources that weren't checked, and why (credentials, a rate limit, a timeout, `--max-reads`, the time running out) |
| `naming/client-name` | warn | With `--client`: tool names the client's API refuses: `^[a-zA-Z0-9_-]{1,128}$` for the Claude API, `^[a-zA-Z0-9_-]+$` up to 128 for OpenAI's functions. MCP allows names such as `files.read` that neither takes as they are |
| `menu/auth-variance` | info | With `--as` (or `identities` in the config): the tool set differs by identity, what each adds, lacks or defines differently against the first, and its tokens. Allowed by the spec; a baseline of one identity's menu doesn't cover the others. An identity that can't be listed is said here too |
| `spec/cache-scope-public` | warn | 2026-07-28, with `--as`: the tool set differs by identity, and `tools/list` says `cacheScope: "public"`, which lets shared caches serve one caller's list to another |
| `menu/capability-dependent` | info | Tools a server lists only to a client that supports elicitation, or only to one that doesn't. `snapshot` lists as a client with elicitation, so the menu file holds those tools (github-mcp-server 1.14 lists `delete_repository` only to a client that can ask the user to confirm; before 0.22 a baseline missed it), and once more without |
| `menu/network-dependent` | warn | With `--offline-check` (stdio): the menu listed once more with the network cut off (the proxy variables pointed at a closed port, loopback left alone) differs: inite-visibility serves 3 tools offline and 10 online, so a baseline made with the network doesn't match a machine without it. A server that doesn't start offline is info. A server that ignores the proxy variables still reaches the network where the machine has it directly; then nothing is reported, which isn't a pass |
| `auth/invalid-accepted` | warn | HTTP with credentials: the menu listed once more with an invalid credential in the same scheme. A server that serves a menu to it, not 401, gives a client whose token expired no reason to log in again; the agent just has fewer tools (Atlassian Rovo served 4 tools to any `Authorization` header). `--processes 1` turns it off |

The full list, `diff` and `session` rules included, is [docs/RULES.md](RULES.md).

The naming and ID rules are heuristics, tuned on real servers (FINDINGS F7 and
F10) and a private 115-tool one. They're the extras; the change checks are the point.

## Reading resources: `--read-resources`

```sh
toolmenu snapshot --lists resources --read-resources -- node dist/server.js
```

`--lists resources` checks the list. `--read-resources` also sends `resources/read` for
each resource the list names, the request a client makes when a user or an agent picks
one, and reports the ones that come back with an error or with nothing usable. A
resource can be listed correctly and still not be readable: `@dpantani/tdmcp` 0.13.2
listed five resources whose read answered `{"error": "Python class … not found."}` as
the content.

What is read:

- every concrete resource in `resources/list`, once per URI, in URI order, one at a time;
- not resource templates (a read needs an argument toolmenu would have to make up);
- not `http://` or `https://` URIs (the spec has the client fetch those itself);
- not a `ui://` resource a tool names: the MCP Apps check has read it already
  (`apps/resource`). Other `ui://` resources are read here.

The limits, and what they don't do:

- Each read gets `--timeout`. All the reads together get 120 s; what's left unread is
  counted in `lists/resource-unread`.
- A rate-limit answer stops the reads. The list reads wait and retry; these don't.
- Once 64 MB of content has arrived, no further read starts. That is checked between
  reads: `resources/read` has no way to ask for part of a resource, so one large
  response arrives whole. A resource whose listing declares a `size` over 16 MB isn't
  read at all.
- `--max-reads <n>` reads n resources spread evenly over the sorted list (the first, the
  last and the ones between), not the first n.

Content is checked in memory and never written anywhere: not to the menu file, not to
any report. A finding names URIs and quotes the server's error message, never a body.
The results aren't in the menu file, so `diff` and `review` don't compare them.

A read is not a tool call, but it is a request for every resource the server lists.
Against a hosted server you don't run, `--max-reads` keeps that to a few.

In the config: `"lists": ["resources"], "readResources": true`, and `"maxReads": 20`.

## Where the tokens go

`snapshot` also shows what the menu's tokens are spent on: the biggest tools (split
into description and schema), large enums, and waste you can remove:

- **Repeated blocks**: the same piece of schema at several places, inside one tool (a
  `$defs` entry could hold it once: "one ~230-token block ×5 in
  content_generateMessageHtml") or across tools (paid once per tool: mongodb-mcp-server
  3.0.4 repeats a ~2,200-token `pipeline` schema in 3 tools). Only the largest repeated
  block is named, not the pieces inside it.
- **Unused `$defs`**: definitions nothing in the tool refers to. Notion's server 2.5.2
  ships the same 9 in all 24 tools, 72% of its menu.

Every tool's estimate is in the menu file, for the ones the summary leaves out:
`jq -r '.tools[] | "\(.tokens)\t\(.name)"' menu.json | sort -rn`.

## Pin routing with `routes.yml`

Two tools fighting over one word needs a regression
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

## Config

An optional `toolmenu.config.json`:

```json
{
  "rules": { "naming/shared-word": "off", "ids/authored": "error" },
  "ignore": ["debug_*"],
  "routes": "routes.yml",
  "tokenBudget": 4000,
  "descriptionLimit": "claude-code",
  "fullDescriptions": ["search_capabilities", "lookup_*"],
  "offlineCheck": true
}
```

`offlineCheck` turns on `--offline-check` for every `snapshot` of a stdio server.

`descriptionLimit` is where your client cuts tool descriptions: a number, or a client
whose cut has been reported: `"claude-code"` (the default: Claude Code's own docs,
[code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp), read 2026-11-02:
16,384 characters for a tool loaded through tool search, which is on by default, and
4,096 for a tool that loads up front, marked `_meta["anthropic/alwaysLoad"]: true`;
the cut was 2,048 before v2.1.296), `"claude-code-upfront"` (4,096 for every tool:
Claude Code with tool search off) or
`"amazon-q"` (10,024, reported in
[makenotion/notion-mcp-server#145](https://github.com/makenotion/notion-mcp-server/issues/145)).
Clients that send descriptions in full don't need a setting beyond that. If your own
client cuts shorter, as mine did at 280, set its number. `fullDescriptions` lists the
tools it sends uncut, so the description rules skip them.

## Every server you use: `scan`

```sh
npx toolmenu scan ~/Library/Application\ Support/Claude/claude_desktop_config.json --allow-env LINEAR_API_KEY
npx toolmenu scan .mcp.json --format markdown
```

`scan` runs `snapshot` on every server in an MCP client config (Claude Desktop, Claude
Code's `.mcp.json`, Cursor, VS Code: the `mcpServers` or `servers` object) or in a
text file with one server per line (a URL or a command, optionally `name<TAB>` first),
four at a time (`--concurrency`), and prints them side by side, then each server's
findings, like this:

```
  server       tools  tokens  findings
  github          42  ~18K    1 error · 2 warn
  filesystem      11  ~2.1K   no findings
  linear           –      –   not checked: LINEAR_API_KEY is not set (the config refers to it)
```

`scan` starts every command the list names, so scan only lists you'd run yourself (not
a `.mcp.json` from a repository you haven't read). A config's `${VAR}` is filled only
from the variables you name with `--allow-env` (comma-separated, or `'*'` for all): the
config decides where each value goes, a URL or a header included, so one from someone
else could otherwise send your environment to a server of theirs. An entry that uses
a variable you didn't allow isn't checked, and says which `--allow-env` it needs.

`${VAR}`, `${VAR:-default}` and `${env:VAR}` in the config are filled from the
environment. A server whose variable isn't set isn't started with an empty
credential: it's a row that says so. A server that couldn't be started or read
makes the exit code 2, because it wasn't checked; one marked `disabled` is listed and
left alone. URLs are printed without their query, which can hold a key. Nothing is
written unless `--out-dir` names a folder for each server's menu file.
