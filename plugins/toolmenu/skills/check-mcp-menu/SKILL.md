---
name: check-mcp-menu
description: Check an MCP server's tool list with toolmenu after adding, renaming or editing its tools, or before a release. Use when working on an MCP server's tool names, descriptions, input schemas or annotations, when asked whether a change breaks clients, or when the tool list grows or changes mid-session.
---

# Checking an MCP server's menu

toolmenu checks the tool list (the menu) an MCP server serves, the way clients and
agents meet it. It is deterministic: no LLM, same input, same answer.

## When

- After changing any tool's name, description, input schema or annotations.
- Before a release, against the committed baseline (usually `menu.json`).
- When a server adds or removes tools while it runs (unlocks, toolsets).

## How

1. Build the server first if it needs a build (`npm run build`), then call
   `snapshot_menu` with `command` (stdio, one word per item:
   `["node", "dist/server.js"]`) or `url` (HTTP). Pass `cwd` as the server's
   project folder: the server starts there and `toolmenu.config.json` is read from it.
2. If the project has a committed `menu.json`, call `snapshot_menu` again with
   `save_as: "new-menu.json"`, then `diff_menus` with `before: "menu.json"`,
   `after: "new-menu.json"` for breaking changes, the token change and the version
   bump. Delete `new-menu.json` afterwards; don't overwrite `menu.json` unless the
   user wants the baseline updated.
3. If the server can change its tool list while running, call `check_session`.
   It calls only tools marked `readOnlyHint` whose arguments the schema can fill.
4. For a finding you don't understand, call `explain_rule` with its rule id.

## Reading the report

- Every finding says what's wrong, where and what was seen, and ends with
  `→ Next:`. Follow that step; it is the fix toolmenu means.
- `error` findings break clients or the spec; `warn` findings mislead agents or
  cost tokens; `info` is context. Findings marked `· unsure` are heuristics.
- "Exit 1" at the end only means findings at or above the fail level, not that
  toolmenu failed. A tool error means toolmenu couldn't run (server didn't start,
  bad path): fix that first.
- Fix findings in the server's code, rebuild and run `snapshot_menu` again to
  confirm. Report the token total and any breaking changes to the user.
