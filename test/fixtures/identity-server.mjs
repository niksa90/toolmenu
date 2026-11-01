// A menu that depends on who asks (2026-07-28: the tool set MAY vary by
// authorization). On stdio an identity is an env var:
//   ROLE=reader (default)  list_items, get_item
//   ROLE=admin             also delete_item, and get_item says more
//   ROLE=banned            exits before answering: an identity that can't be listed
// SCOPE=private sends cacheScope "private" (default "public"). LEGACY=1 serves only 2025.
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

const role = process.env.ROLE ?? 'reader';
if (role === 'banned') {
  process.stderr.write('Forbidden: this account may not use the server\n');
  process.exit(1);
}

const tool = (name, description, extra = {}) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { item_id: { type: 'string' } }, required: name === 'list_items' ? [] : ['item_id'] },
  ...extra,
});

export function build() {
  const server = new Server({ name: 'identity-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = [
    tool('list_items', 'Lists the items you can see.', { inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }),
    tool('get_item', role === 'admin' ? 'Gets an item, with its audit trail.' : 'Gets an item.', { annotations: { readOnlyHint: true } }),
    ...(role === 'admin' ? [tool('delete_item', 'Deletes an item.', { annotations: { destructiveHint: true } })] : []),
  ];
  server.setRequestHandler('tools/list', async () => ({ tools, ttlMs: 3_600_000, cacheScope: process.env.SCOPE ?? 'public' }));
  server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
