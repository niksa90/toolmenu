// A tool that changes the menu and then takes longer than the client waits:
// the call fails with a timeout, but the server has already applied the change.
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
  server.registerTool('slow_unlock', { description: 'Unlock reports, slowly.', annotations: ro }, async () => {
    state.unlocked = true;
    extra.enable();
    await new Promise((r) => setTimeout(r, 3000));
    return text('unlocked');
  });
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) serveStdio(build);
