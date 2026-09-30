// A hand-rolled 2025-era stdio server for session --auto: tools that need values
// the schema doesn't give (like mcp-server-git's repo_path), tools that don't say
// whether they only read (like DeepWiki), a tool that refuses every call the same
// way (like Exa), and, with CLOCK=1, a default built from the current time on every
// tools/list (like @paypal/mcp 1.8.1). Every call is logged to CALLS, if set.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const str = { type: 'string' };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const ro = { readOnlyHint: true };

const menu = () => [
  { name: 'git_status', description: 'Show the working tree status.', inputSchema: obj({ repo_path: str }), annotations: ro },
  { name: 'git_log', description: 'Show the commit log.', inputSchema: obj({ repo_path: str, max_count: { type: 'integer', default: 10 } }, ['repo_path']), annotations: ro },
  { name: 'get_current_time', description: 'The time in a timezone.', inputSchema: obj({ timezone: str }), annotations: ro },
  { name: 'fetch_urls', description: 'Fetch pages.', inputSchema: obj({ urls: { type: 'array', items: str } }), annotations: ro },
  { name: 'broken_search', description: 'Search that always fails.', inputSchema: obj({ query: str }, []), annotations: ro },
  { name: 'ask_question', description: 'Ask a question about a repository.', inputSchema: obj({ question: str }) },
  { name: 'read_wiki', description: 'Read the wiki.', inputSchema: obj({}), annotations: { title: 'Read wiki' } },
  { name: 'delete_wiki', description: 'Delete the wiki.', inputSchema: obj({}), annotations: { destructiveHint: true } },
  {
    name: 'list_transactions',
    description: 'List transactions.',
    inputSchema: obj({ end_date: { type: 'string', default: process.env.CLOCK ? new Date().toISOString() : '2026-01-01T00:00:00.000Z' } }, []),
    annotations: ro,
  },
];

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'auto-fixture', version: '0.0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: menu() } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {};
    if (process.env.CALLS) appendFileSync(process.env.CALLS, JSON.stringify({ name, args }) + '\n');
    if (name === 'broken_search') send({ id: msg.id, result: text('Search engine rejected the request: bad query', true) });
    else if (name === 'fetch_urls' && !(args.urls ?? []).length) send({ id: msg.id, result: text('urls must not be empty', true) });
    else send({ id: msg.id, result: text('ok') });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
