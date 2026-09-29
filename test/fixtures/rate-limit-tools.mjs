// Tools that say "rate limit" in different ways, and count how often they ran:
// what session may send again after a refusal, and what isn't a refusal at all.
import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import * as z from 'zod';

export function build(ran = {}) {
  const server = new McpServer({ name: 'rate-limit-fixture', version: '1.0.0' });
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  const count = (name) => (ran[name] = (ran[name] ?? 0) + 1);
  const tool = (name, readOnlyHint, handler) =>
    server.registerTool(name, { description: `${name}.`, inputSchema: { id: z.string().optional() }, annotations: { readOnlyHint } }, async () => handler(count(name)));
  // Did the work, then the upstream API refused: a JSON-RPC error, not a 429.
  tool('send_message', false, () => {
    throw new ProtocolError(-32603, 'Upstream API rate limit exceeded');
  });
  tool('post_comment', false, () => text('Too many requests, please try again later.', true));
  // Limited twice, then fine.
  tool('list_items', true, (n) => (n <= 2 ? text('Too many requests, please try again later.', true) : text('[]')));
  tool('get_order', true, () => text('Order 429 not found', true));
  tool('set_quota', true, () => text('rateLimit must be a positive number', true));
  return server;
}
