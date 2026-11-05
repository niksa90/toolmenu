#!/usr/bin/env bash
# A minimal TypeScript MCP server project, as the prompt describes it.
set -euo pipefail
mkdir -p src dist
cat > package.json <<'JSON'
{
  "name": "orders-mcp",
  "version": "1.2.0",
  "type": "module",
  "bin": { "orders-mcp": "dist/server.js" },
  "scripts": { "build": "tsc", "start": "node dist/server.js" },
  "dependencies": { "@modelcontextprotocol/server": "^2.4.0", "zod": "^4.6.7" },
  "devDependencies": { "typescript": "^5.9.0" }
}
JSON
cat > src/server.ts <<'TS'
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

serveStdio(() => {
  const server = new McpServer({ name: 'orders', version: '1.2.0' }, { capabilities: { tools: {} } });
  server.registerTool('search_orders', { description: 'Search orders by customer.', inputSchema: { customer: z.string() } }, async () => ({ content: [{ type: 'text', text: '[]' }] }));
  return server;
});
TS
git init -q . && git add -A && git -c user.email=e@x -c user.name=eval commit -qm init
