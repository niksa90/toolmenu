// A tool that changes the menu and then takes longer than the client waits:
// the call fails with a timeout, but the server has already applied the change.
//
// The call answers only once the client has given up on it (a timeout makes the
// client cancel the request), not after a fixed delay: a delay has to sit between
// the client's timeout and the time the server takes to start, and on a busy
// machine starting can take longer than any delay short enough for a test.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const ro = { readOnlyHint: true };
const state = {};

export function build() {
  const server = new McpServer({ name: 'slow-unlock-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  server.registerTool('list_forms', { description: 'List forms.', annotations: ro }, async () => text('[]'));
  const extra = server.registerTool('export_report', { description: 'Export a report.', annotations: ro }, async () => text(''));
  if (!state.unlocked) extra.disable();
  server.registerTool('slow_unlock', { description: 'Unlock reports, slowly.', annotations: ro }, async (ctx) => {
    state.unlocked = true;
    extra.enable();
    const signal = ctx?.mcpReq?.signal ?? ctx?.signal;
    await new Promise((resolve) => {
      signal?.addEventListener('abort', resolve, { once: true });
      // A backstop that doesn't keep the process alive once stdin closes.
      setTimeout(resolve, 600_000).unref();
    });
    return text('unlocked');
  });
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) serveStdio(build);
