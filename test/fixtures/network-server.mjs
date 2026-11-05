// A server whose menu depends on the network: it fetches REMOTE_URL at start and adds
// a tool if that works (inite-visibility, Netlify's server). With REQUIRE=1 it won't
// start without it.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

let reached = false;
try {
  reached = (await fetch(process.env.REMOTE_URL, { signal: AbortSignal.timeout(5000) })).ok;
} catch {
  reached = false;
}
if (!reached && process.env.REQUIRE) {
  console.error(`Cannot reach ${process.env.REMOTE_URL}`);
  process.exit(1);
}
function build() {
  const server = new McpServer({ name: 'network-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const reg = (name) => server.registerTool(name, { description: `${name}.`, inputSchema: fromJsonSchema({ type: 'object', properties: {} }), annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  reg('local_status');
  if (reached) reg('remote_rules');
  return server;
}
serveStdio(build);
