# Rules

Every rule toolmenu reports, by the command that reports it. `toolmenu explain <rule>`
prints one entry from this file (it ships inside the package as `dist/rule-docs.json`,
built from this file). Set a rule's level, or turn it off, with `rules` in the config:
`{ "rules": { "naming/shared-word": "off", "write/unannotated": "error" } }`.

Severity is the default. For `diff` rules, the class in brackets is what the change
means for semver: breaking → major, minor → minor, notice → no bump.

## snapshot

| Rule | Severity | What it checks |
|---|---|---|
| `auth/invalid-accepted` | warn | HTTP with credentials, `--processes` 2 or more. toolmenu lists the menu once more with an invalid credential in the same scheme (Bearer, Basic, the API-key header, or the stored login). A server that answers it with a menu, not 401 or 403, gives a client whose token expired or was revoked no reason to log in again: the agent just sees fewer tools (Atlassian Rovo served 4 tools to any `Authorization` header) |
| `catalog/failed` | info | `--catalog`: searches or router listings that failed, grouped by cause (rate limit, authentication, unreadable output). Their operations aren't in the catalog, so `diff` can't see them |
| `catalog/read` | info | `--catalog`: what was read behind a search tool or command router, with how many searches or which listing call. A search returns its top matches, so the catalog is what the searches reached, not a guaranteed full list |
| `catalog/skipped` | info | `--catalog`: tools that look like command routers but weren't called, because no listing mode needs no command. toolmenu never sends a command to list one |
| `description/buried` | warn | A sentence that reads as an instruction to the agent sits past the point where the client cuts descriptions, so the model never sees it. Read from the words, so marked unsure |
| `description/cut` | info | Descriptions longer than the client sends, with where the cut falls. Nothing past it reads as an instruction, so it's a check, not a bug |
| `description/late-instruction` | info | Only with the default cut: an instruction past 280 characters, where one real client cut, but inside the default cut. Split out of `description/cut` in 0.13; a setting for `description/cut` still applies to it unless it's set itself (`RULE_ALIASES`) |
| `ids/authored` | info | An input that looks like an opaque ID where no tool appears to return that kind of ID, so the agent would have to invent it. Heuristic, and worded as one. Stronger when `outputSchema` is present |
| `ids/handle-lifetime` | info | 2026-07-28. A tool that creates a handle (`create`/`start`/`open`/`new`/`begin`/`acquire` + session, basket, cart, checkout, handle, lease or lock) that another tool takes back (`session_id`, `sessionToken`, `session`), whose description and output schema don't say how long it lasts. The spec asks for retention in the creation tool's description. Unsure |
| `lists/schema` | error | Each list's raw result pages against the official schema of the protocol version (`ListPromptsResult`, `ListResourcesResult`, `ListResourceTemplatesResult`); 2026-07-28 requires `ttlMs` and `cacheScope`. A declared list that fails to answer is a warning; Method not found (-32601) is info, and a setup failure (credentials, this machine) is info that says it wasn't checked. A list asked for whose capability the server doesn't declare isn't read, and the snapshot says so in a note, not a finding |
| `lists/variance` | warn | `snapshot --lists prompts,resources` (or `lists` in the config) reads `prompts/list`, `resources/list` and `resources/templates/list` (only those the server declares a capability for, up to 50 pages each, bypassing the SDK's list cache) twice on the main connection and once from a second process or connection (`--processes 1` turns that off). A difference by item (name, uri, uriTemplate), in content, key order or order is the finding |
| `menu/auth-variance` | info | `snapshot --as name:credential` (repeatable) or `identities` in the config lists the menu once per identity: a header set (HTTP) or env vars (stdio) over `--header`/`--env`. The first identity's menu is saved and checked; each other one, from its own process or connection, is compared with it: tools it adds, lacks, or defines differently, and its tokens. The tool set **MAY** vary by authorization, so this is info. An identity that can't be listed is reported here, and the others are still compared |
| `menu/connection-variance` | error | The same over HTTP: a second connection with the same credentials gets a different menu. Retried once before reporting |
| `menu/duplicate-name` | error | Two tools with the same name: only one can be called, and some clients reject the list |
| `menu/gated` | warn | The server declares `listChanged: true` and has a tool that unlocks more (an enum of toolsets or domains), and the unlock's values aren't already listed. The snapshot may be only the starting set, so a baseline made from it misses every tool behind the unlock (a real server: 18 of 115 tools). Run `session --auto` to walk the unlocks |
| `menu/host-specific` | info | A description holds a value that differs per host (a container, host or instance ID in hex), so the menu differs on every install and every machine misses the prompt cache. Heuristic |
| `menu/nondeterministic` | error | Two identical `tools/list` calls return different menus. Reports what differed: order, description, schema, annotations, tool added, tool removed. Order and content changes are both cache-relevant. Spec basis for order: servers **SHOULD** return "the same ordering across requests when the underlying set of tools has not changed" (§12). Content changes are toolmenu's own rule (lesson 05), not a spec violation |
| `menu/process-variance` | error | A second server process, started the same way, serves a different menu, so every restart misses the cache. Seen on mcp-atlassian: a default built from a Python set, in a new order every start (FINDINGS F12). toolmenu runs the main process with `PYTHONHASHSEED=0`, so a Python server's saved menu is reproducible, and the second with another seed. `--processes 1` turns it off |
| `naming/client-name` | warn | `--client` only. Tool names outside the client's API name format: the Claude API's `^[a-zA-Z0-9_-]{1,128}$` (platform.claude.com define-tools) for `claude-code` and `claude-api-search`, OpenAI's `FunctionToolParam.name` (`^[a-zA-Z0-9_-]+$`, maxLength 128, openai/openai-openapi) for `openai`. The detail names the source and read date |
| `naming/route` | error | A `routes.yml` expectation broke |
| `naming/shared-word` | info | The same noun is a primary term in tools from different areas (the "audit" collision). Lists groups for review, never fails the build |
| `naming/vague-id` | warn | A parameter named `id`, `ids` or `key` that doesn't say which kind of thing it identifies (the ~13-wasted-calls bug) |
| `search/findable` | info | For a menu a client would defer (10+ tools and 10K+ tokens, or 30+ tools): a tool that a BM25 search for its own name words doesn't put in the top 5, the number a tool search returns by default. With `routes.yml`, a `must_match` tool past the top 5 for its keyword is a warning. Ranked over the name, description, argument names and argument descriptions, as Claude's tool search reads them; the client's tokenizer and parameters aren't published, so marked unsure |
| `spec/cache-hints` | info | Cache metadata recommendation, not a correctness error (`since: 2026-07-28`). `ttlMs: 0` on `tools/list`: valid, but tells clients the list is "immediately stale" and they may re-fetch every time. `cacheScope: "public"` on a server that required auth: valid only if the list has no user-specific data, because shared caches "MAY … serve it across authorization contexts". Worth a look if the tool set depends on the caller's scopes |
| `spec/cache-scope-public` | warn | `since: 2026-07-28`. The tool set differs by identity and `tools/list` says `cacheScope: "public"` (shared caches **MAY** serve it across authorization contexts). With identities to compare, it replaces `spec/cache-hints`' public-scope hint, which has no evidence either way |
| `spec/deprecated` | info | Advertises Sampling, Roots or Logging, or uses HTTP+SSE (`since: 2026-07-28`) |
| `spec/discover` | info | The server only speaks the 2025 protocol: no working `server/discover`, which 2026-07-28 servers **MUST** implement. Info, not error: see §13 |
| `spec/ref` | error | `since: 2026-07-28`. A `$ref` in a tool's input or output schema that doesn't resolve inside the schema: a network URI (clients **MUST NOT** fetch it, SEP-2106) or a pointer, `#anchor` or `$id` that names nothing. In an `outputSchema`, error: the official SDK client fails every call to the tool ("has an invalid outputSchema"). In an `inputSchema`, error for a ref to nothing (the schema isn't valid, and the SDK's server won't register it), warn for a network URI (clients **SHOULD** reject the schema). `#/$defs`, `#anchor`, `$dynamicAnchor`, `$id` (pointers resolve inside the resource an `$id` names), draft-07 `#name` ids, `""` and `#` refs resolve. The token breakdown's unused-`$defs` count uses the same resolver. Composition-keyword bounds are left to each implementation by the spec, so not checked. Checked against the SDK client's behaviour in the tests |
| `spec/schema` | error | `tools/list` result fails the official `schema.json` for its version. Version-aware: a 2026-07-28 result missing `ttlMs`/`cacheScope` fails, because that version requires them on cacheable results (SEP-2549); a 2025 result is checked against its own schema, which doesn't have them |
| `spec/server-info` | warn | The handshake's `serverInfo` has no `name` or no `version`, so a client (and `diff --server-version-is-release`) can't tell which server or release answered |
| `spec/tools-capability` | error | The server doesn't declare the `tools` capability, so clients (the official SDK included) never ask for its tools |
| `spec/x-mcp-header` | error | `since: 2026-07-28`. An `x-mcp-header` annotation the spec doesn't allow (SEP-2243): empty; not an RFC 9110 token; the same header twice ignoring case; on a parameter that isn't `string`, `integer` or `boolean`, or has no single `type`; anywhere but a parameter reached through `properties` alone. Streamable HTTP clients **MUST** leave such a tool out of `tools/list`, and the official SDK client does, with only a console warning. Error on an HTTP server, warn on stdio (clients there MAY ignore the annotation). `number` is warn on both: the spec forbids it, the SDK client accepts it for now. Every broken annotation in a tool is listed (the SDK stops at the first). Checked against the SDK client's behaviour in the tests |
| `write/no-dry-run` | info | A `destructiveHint: true` or `readOnlyHint: false` tool with no `dry_run`/`preview`-style parameter and no matching preview tool |
| `write/read-only-mismatch` | warn | `readOnlyHint: true` on a tool whose name starts with a write verb (create, delete, send, upload, set…). Unsure: a tool can write only local state. `session --auto` skips such a tool, saying why, rather than call it on the hint alone |
| `write/unannotated` | warn | A tool whose name suggests writing (`delete_`, `send_`, `update_`…) has no annotations |

## diff

| Rule | Severity | What it checks |
|---|---|---|
| `diff/annotations` | info (notice) | Other annotations changed (`title`, `idempotentHint`, `openWorldHint`, a hint removed). Grouped when the same change is in several tools |
| `diff/catalog-added` | info | Operations behind a search tool that are new, or newly found by the same queries |
| `diff/catalog-missing` | info | Operations behind a search tool (`--catalog`) that the same queries didn't return this time: removed, renamed, or ranked lower. A notice, no bump |
| `diff/catalog-queries` | info | Only one snapshot has a catalog, the two were read with different queries, or one is partial: what's on one side only says less |
| `diff/description` | info (notice) | A description changed, with a text diff. It doesn't break the protocol, but it changes what the agent does |
| `diff/enum-narrowed` | error (breaking) | A parameter now accepts fewer values, or became limited to a fixed set. Calls that send any other value fail validation |
| `diff/enum-widened` | info (minor) | A parameter accepts more values, or is no longer limited to a fixed set |
| `diff/lists-unread` | info | Only one menu was snapshotted with `--lists`, so prompts or resources weren't compared |
| `diff/order` | info (notice) | The tool order changed. It matters within a session (the prompt cache), not between releases |
| `diff/other` | info (notice) | Other tool fields changed (`title`, `icons`, `_meta`). Clients may show these; the agent may read them |
| `diff/param-added` | info (minor) | A new optional parameter |
| `diff/param-default` | info (notice) | A parameter's default changed: calls that leave it out now behave differently |
| `diff/param-dropped` | info (notice) | An optional parameter removed from an object that accepts properties it doesn't list: calls that still send it stay valid, but the server may ignore it |
| `diff/param-relaxed` | info (minor) | A required parameter became optional |
| `diff/param-removed` | error (breaking) | A required parameter removed (every existing call sends it, and the server no longer reads it), or an optional one removed from an object that rejects properties it doesn't list (calls that still send it fail validation) |
| `diff/param-renamed` | warn | A tool lost a parameter and gained a required one with a close name: likely a rename. A hint next to the two breaking findings, not a change of its own |
| `diff/param-required` | error (breaking) | A parameter that's new and required, or was optional and is now required. Calls that don't send it fail |
| `diff/param-type` | error (breaking) | A parameter's type changed to one that doesn't accept every old value (`string` → `integer`), or a `oneOf`/`anyOf` option was dropped |
| `diff/prompt-added` | info (minor) | `--lists`: a new prompt |
| `diff/prompt-argument-required` | error (breaking) | `--lists`: a prompt argument that's new and required, or now required. Invocations that don't pass it fail |
| `diff/prompt-changed` | info (notice) | `--lists`: a prompt's description or arguments changed, and nothing it requires |
| `diff/prompt-removed` | error (breaking) | `--lists`: a prompt removed. Users and clients that invoke it by name (a slash command, a saved workflow) get an error |
| `diff/properties-closed` | error (breaking) | `additionalProperties: false` added: calls that send extra arguments now fail validation |
| `diff/properties-opened` | info (minor) | `additionalProperties: false` removed: the tool accepts extra arguments |
| `diff/resource-template-added` | info (minor) | `--lists`: a new resource template |
| `diff/resource-template-removed` | error (breaking) | `--lists`: a resource template removed. Clients that read resources through it get an error |
| `diff/resources` | info (notice) | `--lists`: concrete resources that came or went. Resources are data (files come and go): listed, no bump |
| `diff/safety-hint` | error (breaking) | `readOnlyHint` true → false, or `destructiveHint` added. An agent or client that ran the tool without asking now has a write it didn't approve |
| `diff/schema-dialect` | info (notice) | Only the declared `$schema` dialect changed. One finding for the menu |
| `diff/schema-equivalent` | info (notice) | The schema was restructured or respelled (`$ref`, `$defs`, key order) but accepts the same input: bytes and tokens changed, nothing else |
| `diff/schema-other` | info (notice) | The input schema changed in keywords toolmenu doesn't classify, a schema that's empty or invalid, or one too large to expand through its `$ref`s. Review it by hand |
| `diff/token-budget` | error | The new menu is over `tokenBudget` from the config. Every conversation that loads it pays that before its first message |
| `diff/tool-added` | info (minor) | A new tool. It costs tokens in every conversation that loads the menu (see the token change) |
| `diff/tool-removed` | error (breaking) | A tool in the old menu isn't in the new one. Agents and saved workflows that call it get an error |
| `diff/tool-renamed` | error (breaking) | One tool removed and one added with a near-identical schema: reported as a rename, still breaking for anything that calls the old name |
| `diff/type-widened` | info (minor) | A parameter's type now accepts more (`integer` → `number`, a type added to a union) |
| `diff/version-backwards` | warn | The release version went backwards, so the bump can't be checked |
| `diff/version-bump` | warn | `--release old..new` (or `--server-version-is-release`): the bump is smaller than the changes need, a breaking change released as a minor or patch |
| `diff/x-mcp-header` | info (notice) | 2026-07-28: a parameter mirrored into an `Mcp-Param-*` HTTP header was added, removed or renamed. Callers don't change; proxies and WAFs that route on the header do |
| `diff/x-mcp-header-invalid` | warn (notice) | The new release has an `x-mcp-header` annotation that breaks the spec's rules, so Streamable HTTP clients must leave the tool out of their menu. A warning, not breaking: a menu file doesn't say whether the server is served over HTTP |

## session

| Rule | Severity | What it checks |
|---|---|---|
| `session/append` | warn | Tools added at the end of the list. Still a cache miss for the conversation when your client sends tools at the start of the prompt (Claude's Messages API does); cache-safe only when the client adds new tools after the cached content, as tool search (deferred loading) does |
| `session/assumed-read-only` | info | Tools called on your word (`--assume-read-only`, `assume_read_only`) although the server doesn't mark them readOnlyHint |
| `session/connection-local` | error on 2026-07-28 (HTTP) | A change only this connection sees. 2026-07-28: the tool set MUST NOT vary "per-connection or as a side effect of other requests on the connection" |
| `session/decline-fails` | warn | The retry carrying the decline fails with a JSON-RPC error, not a result the model can read. A tool error (`isError`) after a decline is the right answer and isn't reported |
| `session/edit` | error | A tool's description, schema or annotations changed mid-session, with which value changed. The prompt cache is invalidated from that tool on |
| `session/handle-error` | warn | A handle that can't exist answered with a JSON-RPC error, not a tool error (`isError`) the model can read and recover from by making a new one. A tool error, or an answer, isn't reported. One finding per tool; unsure |
| `session/handle-roundtrip` | warn, info when no handle was found | `--create-handles`: the handle a creating tool just returned (`start_session` → `session_id`) refused by the tools that take it back (warn), or a creating tool whose result has no handle to find (info), so the made-up one was used instead |
| `session/input-loop` | warn | After a decline the tool asks the same question again (the same kind and schema, whatever the request key or wording), or keeps asking something else, until the round limit; or it returns `requestState`-only rounds without end. An agent whose user says no can't finish the call |
| `session/input-required` | info | Which tools asked for input, for what, how many rounds, and what the decline led to. One finding for the run |
| `session/known-variance` | info | A mid-session change only in values that already vary from one tools/list to the next: same cause as the finding it names, not counted again |
| `session/mid-insert` | error | Tools inserted into the menu mid-session anywhere but the end. Any change to the tool list invalidates the cached prompt: the whole tool list and the conversation after it are processed again |
| `session/nothing-called` | warn | `--auto` called no tools (all open-world, missing values, or not read-only): the run only listed the menu |
| `session/rate-limited` | error | The server kept refusing requests for being too many (a 429) after toolmenu waited about a minute, or a tool not marked `readOnlyHint` said it was rate-limited (it isn't called again). The run stops there, with the steps it didn't check; give the run its own server instance or raise the limit for it |
| `session/refused` | error | A call the scenario didn't allow: a tool not marked `readOnlyHint` without `allow_writes`, or one marked `destructiveHint`. Nothing was sent |
| `session/remove` | error | A tool gone from the menu mid-session. A model that already planned to call it gets an error, and the prompt cache is invalidated |
| `session/reorder` | error | The same tools mid-session in a different order: a cache miss for everything after the first moved tool |
| `session/result-type` | error | A 2026-07-28 `tools/call` result without `resultType` (**MUST**), or an `input_required` result whose `requestState` isn't a string (it can't be echoed as it came; toolmenu stops the call). The official SDK client rejects a result without `resultType` |
| `session/scope-unchecked` | info | A second server process or connection couldn't start mid-session (a server that holds a file or a port), so whether a change was global wasn't checked. Said once for the run |
| `session/session-lost` | error | The server ended the session after toolmenu opened a second connection with the same credentials (servers with one session per client; 2025-era servers only). The run stops there; rerun with `--processes 1` |
| `session/side-effect` | warn on 2026-07-28 (stdio) | The same, where stdio can't tell per-connection from global |
| `session/step-failed` | error | A step that failed for a reason that isn't setup (authentication, network, missing software): a JSON-RPC error, a timeout, or a server that exited |
| `session/tool-error` | warn | A tool that answered with an error for another reason (`isError`): the run tested less than it looks. The same error at several steps is one finding that names them |
| `session/unannounced` | warn | The menu changed, the server declared `listChanged: true`, and no `notifications/tools/list_changed` arrived. The spec says servers **SHOULD** send it |
| `session/undeclared-input` | warn | The server asked for something the request didn't declare (roots, sampling) instead of returning `-32021` |
| `session/unlock-coverage` | warn | An unlock whose enum lists its values, called with only some of them: the tools behind the rest were never seen, so a baseline from the session misses them. With `--union-out` or `--auto`, an unlock never called at all too, with why `--auto` skipped it |
| `session/untested` | warn, error if no call got through | Calls that failed before reaching the tool: authentication, something missing on this machine (no Chrome), the network. One finding for the run, not one per step, so an expired CI secret doesn't pass a run that tested nothing |
