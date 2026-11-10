---
name: check-mcp-menu
description: Check an MCP server with toolmenu after adding, removing or renaming a tool, editing a tool's description, input or output schema or annotations, or when an agent picks the wrong tool, misreads one, or a client drops the server's tools or rejects a result. Use while working on any MCP server's tools, in any language.
---

# Checking an MCP server's menu

toolmenu tests an MCP server the way clients and agents meet it: the tool list (the
menu) against the spec and each client's limits, the calls and whether results match
their own schemas, and what the menu costs in tokens. It's deterministic: no LLM, same
input, same answer.

## When

- After adding, removing or renaming a tool, or changing a tool's description, input
  schema or annotations (`readOnlyHint`, `destructiveHint`, …).
- When an agent calls the wrong tool, fills arguments wrongly, or misses a tool: the
  menu is usually why.
- When a client shows none of the server's tools, or an error where a tool answered:
  the SDK client rejects a list or a result that breaks its schema.
- When the server adds or removes tools while it runs (unlocks, toolsets).

Releasing, or asked whether a change is breaking: use the release-check skill.
An HTTP server that answers 401, or a client that can't sign in: check-mcp-auth.
Adding toolmenu to CI: use the setup-ci skill.

## How

1. Build the server first if it needs a build (`npm run build`, `cargo build`, …).
2. Call `snapshot_menu` with `command` (stdio, one word per item:
   `["node", "dist/server.js"]`, `["uv", "run", "server.py"]`) or `url` (HTTP). Pass
   `cwd` as the server's project folder: the server starts there and
   `toolmenu.config.json` is read from it. Credentials go in `env` (stdio) or
   `headers` (HTTP), never in `command`. When the user names the client that has the
   problem, pass `client` (`claude-code`, `openai`, `vscode`, `gemini-cli`, …): the
   report then says what that client cuts, refuses or leaves out.
3. If the project has a committed `menu.json`, also call `snapshot_menu` with
   `save_as: "new-menu.json"`, then `diff_menus` with `before: "menu.json"`,
   `after: "new-menu.json"`. Delete `new-menu.json` afterwards. Don't overwrite
   `menu.json` unless the user wants the baseline updated; when they do, get the
   verdict first (`review_baseline`, or `npx -y toolmenu review menu.json new-menu.json`).
4. If a tool's code or `outputSchema` changed, or the server can change its tool list
   while running, call `check_session`. It calls only tools marked `readOnlyHint`
   whose arguments the schema can fill, checks each result against the tool's
   `outputSchema`, and lists the menu after each call. If it says nothing was called
   (`session/nothing-called`), say so: the run only listed the menu.
5. For a finding you don't understand, call `explain_rule` with its rule id.

Without the toolmenu MCP tools, run the same commands with the CLI (Node 22+):
`npx -y toolmenu snapshot --no-write -- node dist/server.js` (or a URL instead of
`-- <command>`), `npx -y toolmenu diff menu.json new-menu.json`,
`npx -y toolmenu explain <rule>`.

## Reading the report

- Every finding says what's wrong, where and what was seen, and ends with
  `→ Next:`. Follow that step: it's the fix toolmenu means.
- `error` breaks clients or the spec; `warn` misleads agents or costs tokens; `info`
  is context. `spec/` and `session/output-schema` findings rest on the protocol;
  `naming/`, `ids/`, `description/` and `write/` are how agents read the menu. Findings marked `· unsure` are heuristics: weigh them, don't just obey.
- "Exit 1" only means findings at or above the fail level. A tool error means
  toolmenu couldn't run (server didn't start, bad path): fix that first.
- Fix findings in the server's code, rebuild and check again to confirm. Tell the
  user the token total and anything breaking.
