// A 2026-07-28 menu for --client: names an API refuses, a tool its server marks to
// load up front in Claude Code, and a tool whose words sit past what Claude Code's
// search reads. Low-level Server, so names and _meta go out as written.
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const filler = 'Lists the records of the account with their fields and owners. ';
const tools = [
  { name: 'files.read', description: 'Reads a file.' },
  { name: 'get user', description: 'Gets a user.' },
  { name: 'search_records', description: 'Searches records by text.', _meta: { 'anthropic/alwaysLoad': true } },
  // Its own words ("invoice") only past character 4,096: Claude Code's search never reads them.
  { name: 'list_entries', description: `${filler.repeat(70)}Use it for invoice ledgers.` },
  ...['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map((w) => ({ name: `get_${w}_invoice`, description: `Gets the ${w} invoice, one invoice by its invoice number.` })),
].map((t) => ({ ...t, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }));

export function build() {
  const server = new Server({ name: 'client-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools, ttlMs: 60_000, cacheScope: 'private' }));
  server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) serveStdio(build);
