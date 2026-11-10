![toolmenu](logo.svg)

# toolmenu for Claude Code

Lets Claude test the MCP server you're building the way clients and agents will meet
it: the menu they read, the calls they make and the results they get back, and
breaking changes between releases. No LLM is involved, so the same inputs always
give the same answer.

```
/plugin marketplace add niksa90/toolmenu
/plugin install toolmenu@toolmenu
```

It adds:

- **The toolmenu MCP server** (Node 22 or later), the toolmenu release the plugin
  pins: `snapshot_menu`, `check_session`, `diff_menus` and `explain_rule`; releases
  after 0.27.0 add `review_baseline` and `check_auth`. A plugin
  update moves it to a new release.
- **Four skills**, each for one moment of work on an MCP server:
  - `check-mcp-menu`: after changing tools (names, descriptions, schemas,
    annotations), or when an agent picks the wrong tool.
  - `release-check`: before tagging or publishing: what changed since the last
    release, what breaks clients, and the version bump it needs.
  - `check-mcp-auth`: when an HTTP server answers 401 or a client can't sign in to it:
    its OAuth discovery, walked without logging in.
  - `setup-ci`: adds toolmenu to CI with `toolmenu init`, so every pull request gets
    a comment.

Installing the plugin installs toolmenu with it: Claude Code runs npm on the plugin's
`package-lock.json`, which pins toolmenu and each of its dependencies to an exact
version and hash, with install scripts off. The server then starts from the plugin's
folder, with no download at start.

## What it runs, sends and stores

- **Runs:** toolmenu's MCP server, through `bin/toolmenu-mcp.mjs`, which starts
  `toolmenu mcp` from the toolmenu package installed from the npm registry at plugin
  install, as `package-lock.json` pins it (source: https://github.com/niksa90/toolmenu, published with npm provenance).
  `snapshot_menu` and `check_session` start the server command you give them, in the
  folder you give, or connect to the URL you give, as `toolmenu snapshot` does on the
  command line. Claude Code asks before each call unless you allow the tools.
- **Calls:** `check_session` calls only the tools your server marks `readOnlyHint`,
  with arguments its schemas allow. `check_auth` sends unauthenticated requests to
  the URL you give and the metadata addresses it names. The others call none.
- **Sends:** nothing to toolmenu or anyone else: no telemetry, no account. The only
  network traffic is to the server URL you give (and its sign-in server, if you
  signed in to it) and the npm install.
- **Stores:** the menu files you ask it to write (`save_as`). If you sign in to a
  server with `toolmenu login`, its tokens stay in `~/.config/toolmenu/auth` on your
  machine, and the tools use them for that server.
- **Credentials** you pass (`env`, `headers`) go only to the server you name. They
  reach toolmenu through its environment, not its command line, so other processes
  on the machine don't see them in a process list.

Without the plugin, see the toolmenu docs: https://github.com/niksa90/toolmenu#readme

## Evals

`evals/` holds cases for `claude plugin eval`: each skill must fire on its own
prompts and no toolmenu skill on unrelated work, and `setup-ci` must give the right
`init` command for a scaffolded project.

Every run is a real Claude session on the account running it: it counts against
that account's usage (or API credits). Pick the size to fit, from this folder:

| When | Command | Sessions |
|---|---|---|
| Editing a skill | `claude plugin eval . --scaffold --model haiku --runs 1 --ablation none` | 9 |
| One case | `claude plugin eval . --case setup-ci --scaffold --model haiku --runs 1 --ablation none` | 1 |
| Before a release | `claude plugin eval . --scaffold --model sonnet --runs 3 -j 4` | 54 |

A run measures whether the model it runs on picks the skill up, so do the release
pass on a model people use the plugin with (Sonnet, Opus), not only Haiku.
`--ablation none` skips the without-plugin comparison; `--scaffold` runs
`evals/setup-ci/scaffold.sh`, which writes a small TypeScript project into that
case's sandbox. The evals don't run in CI.
