// A tool that blocks the whole server (a sign-in polled synchronously inside the call,
// as fulcra-context-mcp's device-code login does): nothing is answered after it.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

function build() {
  const server = new McpServer({ name: 'blocking-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const reg = (name, handler) => server.registerTool(name, { description: `${name}.`, inputSchema: fromJsonSchema({ type: 'object', properties: {} }), annotations: { readOnlyHint: true } }, handler);
  reg('a_status', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  reg('b_sign_in', async () => {
    console.error('Visit https://example.com/device and enter code ABCD-1234');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600_000);
    return { content: [{ type: 'text', text: 'signed in' }] };
  });
  for (const n of ['c_one', 'd_two', 'e_three']) reg(n, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  return server;
}
serveStdio(build);
