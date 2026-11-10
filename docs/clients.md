# Checking for one client (`--client`)

What an agent sees depends on its client. `snapshot --client <name>` (or `"client"` in the
config) checks the menu against what that client's own docs say, and every value
toolmenu uses names its source and the date it was read (`src/clients.ts`). What a
client doesn't document is left out, not guessed.

| `--client` | Up front | Search | Description cut | Names |
|---|---|---|---|---|
| `claude-code` | tool names; full definitions for tools marked `_meta["anthropic/alwaysLoad"]` | reads a description up to 4,096 characters | 16,384 through search, 4,096 up front | Claude API's |
| `claude-api-search` | nothing from tools you defer (keep the 3–5 used most loaded) | name, description, argument names and descriptions; 5 results by default | none documented | `^[a-zA-Z0-9_-]{1,128}$` |
| `openai` | each deferred function's name and description (its schema loads on demand); a deferred MCP server shows only its own name and description | how many results, and which fields, isn't documented, so `search/findable` doesn't run | none documented | `^[a-zA-Z0-9_-]+$`, up to 128 |
| `codex` | not documented | not documented | none documented | OpenAI's (it sends tools to the Responses API) |
| `antigravity` | each tool's name; the agent reads a tool's schema before calling it, unless the user marks it `"eager"` | not a search: the agent reads the schema file | none documented | not documented |
| `gemini-cli` | not documented | not documented | none documented | rewrites: characters outside letters, digits, `_ - . :` become `_`, names over 63 characters are cut in the middle |
| `gemini-api` | not documented | not documented | none documented | letters, digits, `_ - . :`, up to 128 |

Three more check what a client limits rather than what it loads:

| `--client` | What it checks |
|---|---|
| `vscode` | VS Code (GitHub Copilot Chat) sends at most 128 tools a request: a server over it alone is `menu/client-limit` |
| `copilot-cloud-agent` | uses MCP tools only, not prompts or resources (`menu/client-features`, with `--lists`) |
| `copilot-code-review` | the same, and only tools marked `readOnlyHint: true`: the rest are listed |

Read, but nothing in them toolmenu can check yet: Copilot CLI defers tools behind a
search at about 30 (it searches names, descriptions and parameters; how many results
isn't said); Copilot in JetBrains, Visual Studio, Eclipse and Xcode documents no tool
limit; JetBrains AI Assistant and Junie document none either (Junie CLI times out any
request after 60 s, startup and `tools/list` included). Not here, because their docs
don't state it: Cursor's tool limit (forum posts say 40), Windsurf's (100 in older docs,
not in the current page), ChatGPT's. A value comes in when the client documents it.

The snapshot adds a line such as `as Claude Code: up front ~524 tokens · on demand ~344
per tool a search loads (largest: update_contacts, ~2,093)`, and `--json` a `client`
object. With a client that defers tools, `search/findable` runs at any menu size.
