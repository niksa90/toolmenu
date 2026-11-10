# Connecting, signing in, and the other ways to run it

## HTTP servers and OAuth

HTTP servers work the same way: `npx toolmenu snapshot https://example.com/mcp --header "Authorization: Bearer $TOKEN"`.
Servers behind OAuth (most hosted ones: GitHub, Atlassian, Sentry…): log in once, in a
browser, and `snapshot` and `session` use that login from then on, refreshing it as
needed:

```sh
npx toolmenu auth login https://mcp.example.com/mcp
npx toolmenu snapshot https://mcp.example.com/mcp
```

Before logging in, `toolmenu auth check https://mcp.example.com/mcp` walks the server's
OAuth discovery the way a client that follows the spec does: the 401 and its
`WWW-Authenticate`, the protected resource metadata (and whether its `resource` is the
server's URL), the authorization server's metadata, PKCE and registration. No login, no
tokens: only the requests a client makes first.

Logins are stored per server in `~/.config/toolmenu/auth` (readable only by you);
`auth list` and `auth logout <url>` manage them. A server that doesn't allow
dynamic registration needs a pre-registered app: `--client-id` (and
`--client-secret`). Over SSH or in a container, `auth login --no-browser` prints the
login URL instead of opening it: open it on any device, sign in, and paste back the
address the browser ends on (a `localhost` page that doesn't load is expected). In
CI, where nobody can sign in, pass a token as a header.
Both protocol generations are supported: 2026-07-28 (`server/discover`, stateless)
and the 2025 `initialize` handshake, through the official TypeScript SDK.

## Behind a proxy

Behind a proxy (`HTTPS_PROXY`), stdio servers get the proxy and CA settings
(`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`…)
along with the minimal environment, and `NODE_USE_ENV_PROXY=1` so a Node server's
`fetch` uses the proxy. Without them a server that calls an API can't reach it, and
fails as if it were broken. A proxy URL with a password in it
(`https://user:pass@proxy:8080`) reaches the server that way too: give a server you
don't trust a proxy without one, or `--env HTTPS_PROXY=` to leave it out.

## For the agent building your server: `mcp`

`toolmenu mcp` is toolmenu as an MCP server (stdio), so Claude Code, Cursor or any
other client can check the server it's working on while it works. In Claude Code, as a
plugin (the server, and skills for checking a change, checking a release, and setting up CI):

```
/plugin marketplace add niksa90/toolmenu
/plugin install toolmenu@toolmenu
```

Or just the server, in any client: `claude mcp add toolmenu -- npx -y toolmenu mcp`, or
`{"command": "npx", "args": ["-y", "toolmenu", "mcp"]}` in an `mcpServers` config.

| Tool | Runs |
|---|---|
| `snapshot_menu` | `snapshot`: findings and token cost; writes the menu file only with `save_as` |
| `diff_menus` | `diff`: breaking changes, the token change and the version bump between two menu files |
| `check_session` | `session --auto`: calls the read-only tools, checks each result against its `outputSchema`, and reports each menu change |
| `review_baseline` | `review`: should a new menu file replace the baseline? One verdict, and the findings it adds or clears |
| `check_auth` | `auth check`: an HTTP server's OAuth discovery, walked without logging in |
| `explain_rule` | `explain`: what a rule checks and how to change its level |

Each tool runs the CLI in a child process and returns its text report, so options,
`toolmenu.config.json` and stored OAuth logins work as they do on the command line.
Relative paths resolve from the folder `toolmenu mcp` runs in, or a call's `cwd`.
`snapshot_menu` and `check_session` start the command you give them, as the CLI does;
clients ask before each tool call unless you allow it. toolmenu's own menu passes its
checks with no findings, on both protocols and in a session (the test suite checks).

## As a library

Everything the CLI does is exported from the `toolmenu` package, with types, for test
suites and scripts of your own:

```js
import { snapshot, diffMenus, loadMenu, session, loadScenario } from 'toolmenu';

// The menu and its findings, as `toolmenu snapshot` gives them.
const { menu, findings } = await snapshot({ kind: 'stdio', command: 'node', args: ['dist/server.js'] });
// or { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: `Bearer ${token}` } }

// What changed since the committed baseline, and the version bump it needs.
const diff = diffMenus(await loadMenu('menu.json'), menu);
console.log(diff.suggestedBump, diff.tokens);
if (diff.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
```

`snapshot`, `diffMenus`, `session` and `history` take the same options as their
commands (`SnapshotOptions`, `DiffOptions`, `SessionOptions`, `HistoryOptions`) and
return the findings the reports print: each `Finding` has its `rule`, `severity`,
`message`, `tool` and the `fix` shown as `→ Next:`. Lower down, `compareMenus(before,
after)` returns each tool's change (`ToolChange[]`) and `runRules` runs the menu rules
on a menu you built. The `menu.json` format is the `Menu` type (`toolmenu: 1`);
a later format will bump that number. Library functions don't print or exit: that's
the CLI's job.

## Options

```
--out <path>        where to write the menu (default: menu.json)
--no-write          don't write the menu file
--routes <path>     routes.yml
--config <path>     config file (default: toolmenu.config.json, if present)
--format <fmt>      text (default), json, github (annotations), markdown, sarif
                    (code scanning) or junit (CI test reports)
--junit <path>      snapshot, diff, session: also write the findings as JUnit XML
--html <path>       snapshot, diff, session: also write the report as one HTML page
--fail-on <level>   error (default), warn or info
--header <k: v>     HTTP header, repeatable
--env <K=V>         env var for a stdio server, repeatable (it only gets a
                    minimal environment otherwise)
--timeout <ms>      per-request timeout (default: 30000)
--protocol <p>      auto (default), legacy (2025 handshake only) or modern
                    (2026-07-28 only; an error if the server lacks it)
--processes <n>     server processes or connections to compare (default: 2);
                    1 opens no second one, session's scope check included
--lists <kinds>     snapshot: also read and check prompts, resources (comma-separated);
                    saved in the menu file beside the tools
--read-resources    snapshot, with --lists resources: read each listed resource and
                    report the ones a client gets nothing usable from
--max-reads <n>     with --read-resources: at most n reads, spread over the list
--client <name>     snapshot: check the menu for one client, from its own docs:
                    claude-code, claude-api-search, openai, codex, vscode,
                    copilot-cloud-agent, copilot-code-review, gemini-cli,
                    gemini-api or antigravity
--as <name>:<cred>  snapshot: list the menu as this identity too, repeatable:
                    "reader:Authorization: Bearer …" (HTTP) or "admin:ROLE=admin"
                    (stdio). The first is the menu saved; the others are compared
--offline-check     snapshot (stdio): also list the menu with the network cut off
--concurrency <n>   scan: servers checked at a time (default: 4)
--out-dir <dir>     scan: write each server's menu file there, as <name>.json
--allow-env <names> scan: variables a config's ${VAR} may be filled from (default:
                    none; '*' for all)
```

Exit codes: `0` clean · `1` findings at or above `--fail-on` · `2` couldn't connect
(for `scan`: a server wasn't checked) or bad usage. `toolmenu <command> --help` lists that command's own options.

Credentials on the command line (`--header`, `--env`, `--client-secret`) can be read by
every user of the machine while toolmenu runs (`ps`). To keep them off it, put the
options in `TOOLMENU_ARGS`, a JSON array of toolmenu options and their values; they go
before the server command's `--`. A process's environment is readable only by its own
user (and root), so this keeps them from other users, not from other processes of
yours. jq builds the array whatever the token holds:

```sh
TOOLMENU_ARGS=$(jq -cn --arg t "$TOKEN" '["--header", "Authorization: Bearer " + $t]') npx toolmenu snapshot https://example.com/mcp
```

The GitHub Action passes its `headers` and `env` this way (to toolmenu 0.26.0 and
later; an older `version` gets them as arguments, with a warning).
