![toolmenu](logo.svg)

# toolmenu for Claude Code

Lets Claude check the MCP server you're building, the way clients and agents will meet
its tool list: what agents misread, what breaks clients or prompt caches, and
breaking changes between releases. No LLM is involved, so the same inputs always
give the same answer.

```
/plugin marketplace add niksa90/toolmenu
/plugin install toolmenu@toolmenu
```

It adds:

- **The toolmenu MCP server** (`npx -y toolmenu@<this plugin's version> mcp`, Node 22 or later; a plugin update moves it to a new release):
  `snapshot_menu`, `diff_menus`, `check_session` and `explain_rule`.
- **Three skills**, each for one moment of work on an MCP server:
  - `check-mcp-menu`: after changing tools (names, descriptions, schemas,
    annotations), or when an agent picks the wrong tool.
  - `release-check`: before tagging or publishing: what changed since the last
    release, what breaks clients, and the version bump it needs.
  - `setup-ci`: adds toolmenu to CI with `toolmenu init`, so every pull request gets
    a comment.

The first start downloads toolmenu from npm, which can take a few seconds; later
starts use npx's cache.

## What it runs, sends and stores

- **Runs:** `npx -y toolmenu@<version> mcp`, downloaded once from the npm registry
  (source: https://github.com/niksa90/toolmenu, published with npm provenance).
  `snapshot_menu` and `check_session` start the server command you give them, in the
  folder you give, or connect to the URL you give, as `toolmenu snapshot` does on the
  command line. Claude Code asks before each call unless you allow the tools.
- **Calls:** `check_session` calls only the tools your server marks `readOnlyHint`,
  with arguments its schemas allow. `snapshot_menu` and `diff_menus` call none.
- **Sends:** nothing to toolmenu or anyone else: no telemetry, no account. The only
  network traffic is to the server URL you give (and its sign-in server, if you
  signed in to it) and the npm download.
- **Stores:** the menu files you ask it to write (`save_as`). If you sign in to a
  server with `toolmenu login`, its tokens stay in `~/.config/toolmenu/auth` on your
  machine, and the tools use them for that server.
- **Credentials** you pass (`env`, `headers`) go only to the server you name. They
  reach toolmenu through its environment, not its command line, so other processes
  on the machine don't see them in a process list.

Without the plugin: `claude mcp add toolmenu -- npx -y toolmenu mcp`.
Docs: https://github.com/niksa90/toolmenu#readme

## Evals

`evals/` holds cases for `claude plugin eval`: each skill must fire on its own
prompts and no toolmenu skill on unrelated work, and `setup-ci` must give the right
`init` command for a scaffolded project.

Every run is a real Claude session on the account running it: it counts against
that account's usage (or API credits). Pick the size to fit, from this folder:

| When | Command | Sessions |
|---|---|---|
| Editing a skill | `claude plugin eval . --scaffold --model haiku --runs 1 --ablation none` | 7 |
| One case | `claude plugin eval . --case setup-ci --scaffold --model haiku --runs 1 --ablation none` | 1 |
| Before a release | `claude plugin eval . --scaffold --model sonnet --runs 3 -j 4` | 42 |

A run measures whether the model it runs on picks the skill up, so do the release
pass on a model people use the plugin with (Sonnet, Opus), not only Haiku.
`--ablation none` skips the without-plugin comparison; `--scaffold` runs
`evals/setup-ci/scaffold.sh`, which writes a small TypeScript project into that
case's sandbox. The evals don't run in CI.
