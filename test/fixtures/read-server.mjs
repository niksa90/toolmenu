// resources/list and resources/read, for snapshot --read-resources. Low-level Server,
// so each result goes out as written. Serves 2026-07-28, or only 2025 with LEGACY=1.
//   LIST=a,b,…     the URIs resources/list names (default: two that read fine). What a
//                  read of each answers is decided by its scheme, below.
//   GONE=uri       listed the first time only
//   NAMED=uri      a tool names this ui:// resource (the Apps pass reads it)
//   NO_HINTS=1     resources/read results without ttlMs and cacheScope, on the wire
//   RESULT_TYPE=w  resources/read results with this resultType, on the wire: the schema takes any
//                  string, the official client doesn't
//   FAIL_LIST=1    resources/list fails
//   SIZE=uri       the listing declares 20 MB for this one
//   COUNT_FILE=p   every resources/read appends its URI to this file
import { appendFileSync } from 'node:fs';
import { ProtocolError, Server, inputRequired } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

const hints = { ttlMs: 60_000, cacheScope: 'public' };
const modern = !process.env.LEGACY;
const uris = (process.env.LIST ?? 'ok://a,ok://b').split(',').filter(Boolean);
// Never in any output: the body of secret://.
export const MARKER = 'TOOLMENU-BODY-MARKER-7f3a';
let lists = 0;

const text = (uri, t, mimeType = 'text/plain') => ({ contents: [{ uri, mimeType, text: t }], ...hints });

async function read(uri) {
  const scheme = uri.split(':')[0];
  switch (scheme) {
    case 'ok':
      return text(uri, `contents of ${uri}`);
    case 'secret':
      return text(uri, `${MARKER} ${uri}`);
    case 'empty': // an empty file is a resource
      return text(uri, '');
    case 'missing': // the SDK's answer for a URI it has no handler for (-32002 before 2026-07-28: set on the wire)
      throw new ProtocolError(-32602, `Resource ${uri} not found`);
    case 'enoent':
      throw new Error(`ENOENT: no such file or directory, open '/data/${uri.split('/').pop()}.json'`);
    case 'broken':
      throw new Error('the index is corrupt');
    case 'soft': // @dpantani/tdmcp 0.13.2: a read that succeeds with an error for a body
      return text(uri, JSON.stringify({ error: `Python class "${MARKER}" not found.` }, null, 2), 'application/json');
    case 'softkey': // the same shape, for want of credentials
      return text(uri, JSON.stringify({ error: 'API key not configured' }), 'application/json');
    case 'errorfield': // a resource that has an error field among its data
      return text(uri, JSON.stringify({ error: 'last run failed', runs: 4 }), 'application/json');
    case 'none':
      return { contents: [], ...hints };
    case 'dir': // a directory: several contents, none with the URI asked for
      return { contents: [{ uri: `${uri}/a.txt`, text: 'a' }, { uri: `${uri}/b.txt`, mimeType: 'text/markdown', text: 'b' }], ...hints };
    case 'enc': // the URI comes back percent-encoded, as URL.href gives it
      return text(encodeURI(uri), 'encoded');
    // The bench's words for a run that couldn't get out, or had a dummy credential.
    case 'tls':
      throw new Error('self-signed certificate in certificate chain');
    case 'dns':
      throw new Error('[Errno -3] Temporary failure in name resolution');
    case 'jwt':
      throw new Error('Access token is not in valid JWT format');
    case 'project':
      throw new Error('No currently active project.');
    case 'noendpoint': // Amazon Neptune with no endpoint: the same words for every resource
      throw new Error(`Error reading resource ${uri}: You must provide an endpoint to create a NeptuneServer`);
    case 'nokube': // kubectl-mcp-server with no cluster, as a body
      return text(uri, JSON.stringify({ error: 'Invalid kube-config file. No configuration found.' }), 'application/json');
    case 'allbroken': // a read handler that fails for everything, in words that name no cause
      throw new Error(`Internal server error reading ${uri}`);
    case 'softbroken':
      return text(uri, JSON.stringify({ error: 'Something went wrong' }), 'application/json');
    case 'scheme': // glif 0.9.9: each fails in its own words
      throw new Error(`Unsupported protocol: ${uri.split('/').pop()}:`);
    case 'auth':
      throw new Error('401 Unauthorized');
    case 'rate':
      throw new Error('Too many requests, please try again later.');
    case 'slow':
      await new Promise((r) => setTimeout(r, 3000));
      return text(uri, 'late');
    case 'input':
      return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: 'Read it?', requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }) } });
    case 'bare': // an item with neither text nor blob
      return { contents: [{ uri, mimeType: 'text/plain', text: 'REMOVE-ME' }], ...hints };
    case 'ui':
      if (uri.startsWith('ui://missing/')) throw new ProtocolError(-32602, `Resource ${uri} not found`);
      return text(uri, '<!doctype html><html><body>app</body></html>', 'text/html;profile=mcp-app');
    default:
      return text(uri, 'web');
  }
}

export function build() {
  const server = new Server({ name: 'read-fixture', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      { name: 'ping', description: 'Pings.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      ...(process.env.NAMED ? [{ name: 'show_app', description: 'Shows the app.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: process.env.NAMED } } }] : []),
    ],
    ...hints,
  }));
  server.setRequestHandler('resources/list', async () => {
    if (process.env.FAIL_LIST) throw new Error('the index is corrupt');
    const first = lists++ === 0;
    return {
      resources: uris.filter((u) => first || u !== process.env.GONE).map((uri) => ({ uri, name: uri.split('/').pop() || uri, ...(uri === process.env.SIZE ? { size: 20 * 1024 * 1024 } : {}) })),
      ...hints,
    };
  });
  server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{ uriTemplate: 'ok://{name}', name: 'any' }], ...hints }));
  server.setRequestHandler('resources/read', async (request) => {
    if (process.env.COUNT_FILE) appendFileSync(process.env.COUNT_FILE, `${request.params.uri}\n`);
    return read(request.params.uri);
  });
  return server;
}

// What a server that skips the SDK would send.
function rewrite(line) {
  // Servers on the 2025 protocol answer a missing resource with -32002; this SDK only sends -32602.
  if (!modern && line.includes('-32602')) return line.replace('-32602', '-32002');
  if (!line.includes('"contents"')) return line;
  const message = JSON.parse(line);
  if (!message.result?.contents) return line;
  if (process.env.NO_HINTS) {
    delete message.result.ttlMs;
    delete message.result.cacheScope;
  }
  for (const c of message.result.contents) if (c.text === 'REMOVE-ME') delete c.text;
  if (process.env.RESULT_TYPE) message.result.resultType = process.env.RESULT_TYPE;
  return JSON.stringify(message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(String(chunk).split('\n').map((l) => (l.trim() ? rewrite(l) : l)).join('\n'), ...rest);
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
