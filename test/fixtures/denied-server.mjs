// A server that passes its API's 401 on as an ordinary result, not isError (Notion's
// does), and a tool whose data merely contains 401.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
function build() {
  const server = new McpServer({ name: 'denied-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const reg = (name, handler) => server.registerTool(name, { description: `${name}.`, inputSchema: fromJsonSchema({ type: 'object', properties: {} }), annotations: { readOnlyHint: true } }, handler);
  reg('get_self', async () => text(JSON.stringify({ status: 401, object: 'error', code: 'unauthorized', message: 'API token is invalid.' })));
  reg('list_users', async () => text(JSON.stringify({ status: 401, object: 'error', code: 'unauthorized', message: 'API token is invalid.' })));
  reg('list_codes', async () => text(process.env.ALL_DENIED ? '{"error":{"code":"forbidden"}}' : JSON.stringify({ codes: [{ code: 401, meaning: 'Unauthorized' }], status: 'ok' })));
  return server;
}
serveStdio(build);
