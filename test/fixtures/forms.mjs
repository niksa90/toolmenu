// The well-behaved forms server, shared by the stdio and HTTP fixtures.
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export function build() {
  const server = new McpServer({ name: 'forms-fixture', version: '1.2.3' }, { capabilities: { tools: { listChanged: true } } });
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  server.registerTool(
    'search_forms',
    { description: 'Search forms by title. Returns form_id for each match.', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async () => text('[]'),
  );
  server.registerTool(
    'get_form',
    { description: 'Get one form by form_id.', inputSchema: { form_id: z.string() }, annotations: { readOnlyHint: true } },
    async () => text('{}'),
  );
  server.registerTool(
    'delete_form',
    {
      description: 'Delete a form. Use dry_run first to see what would be deleted.',
      inputSchema: { form_id: z.string(), dry_run: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async () => text('ok'),
  );
  return server;
}
