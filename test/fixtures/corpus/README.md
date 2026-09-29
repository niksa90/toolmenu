# Real menus for the mutation tests

Tool definitions (name, description, inputSchema, annotations) served by published
MCP servers, captured with `toolmenu history` on 2026-09-29 and reduced to those
fields. `test/mutation.test.mjs` edits their schemas at every position `diff`
compares and checks what `diff` reports.

| File | Package | License |
|---|---|---|
| `mongodb-mcp-server-3.0.4.json` | mongodb-mcp-server 3.0.4 | Apache-2.0 |
| `notionhq__notion-mcp-server-2.5.2.json` | @notionhq/notion-mcp-server 2.5.2 | MIT |
| `firecrawl-mcp-3.26.0.json` | firecrawl-mcp 3.26.0 | MIT |
| `playwright__mcp-0.0.83.json` | @playwright/mcp 0.0.83 | Apache-2.0 |
| `supabase__mcp-server-supabase-0.13.0.json` | @supabase/mcp-server-supabase 0.13.0 | Apache-2.0 |

The schemas belong to their authors, under the licenses above.
