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

- **The toolmenu MCP server** (`npx -y toolmenu@latest mcp`, Node 22 or later):
  `snapshot_menu`, `diff_menus`, `check_session` and `explain_rule`.
- **The `check-mcp-menu` skill**: when to run them while you work on a server's
  tools, and how to read the report.

`snapshot_menu` and `check_session` start the server command you give them (or
connect to its URL), as `toolmenu snapshot` does on the command line. Claude Code
asks before each call unless you allow the tools.

Without the plugin: `claude mcp add toolmenu -- npx -y toolmenu mcp`.
Docs: https://github.com/niksa90/toolmenu#readme
