// prompts/list, resources/list and resources/templates/list, for snapshot --lists.
// Low-level Server, so each result goes out as written. Serves 2026-07-28, or
// only 2025 with LEGACY=1.
//   VARY=1        resources/list in a new order on every call (lists/variance, one connection)
//   PER_PROCESS=1 prompts/list in an order that depends on the process (PYTHONHASHSEED, which
//                 toolmenu sets per process): lists/variance across processes
//   NO_HINTS=1    resources/templates/list without ttlMs and cacheScope (lists/schema): the SDK
//                 fills them in, so REWRITE takes them out on the wire
//   BROKEN=1      prompts/list fails (lists/schema, as a warning)
//   NO_RESOURCES=1 declares no resources capability (a note, not a finding)
//   NO_TEMPLATES=1 declares resources but has no resources/templates/list: Method not found
//   PAGED=1       resources/list never stops paging (a cursor on every page): read up to the cap
//   NO_KEY=1      resources/list fails for want of credentials: a setup problem, not the server's
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

const hints = { ttlMs: 60_000, cacheScope: 'public' };
let calls = 0;

export function build() {
  const caps = { tools: {}, prompts: {}, ...(process.env.NO_RESOURCES ? {} : { resources: {} }) };
  const server = new Server({ name: 'lists-fixture', version: '1.0.0' }, { capabilities: caps });
  server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'ping', description: 'Pings.', inputSchema: { type: 'object', properties: {} } }], ...hints }));
  server.setRequestHandler('prompts/list', async () => {
    if (process.env.BROKEN) throw new Error('prompts are not configured');
    const prompts = [{ name: 'summarize', description: 'Summarize a document.' }, { name: 'review', description: 'Review a change.' }];
    if (process.env.PER_PROCESS && process.env.PYTHONHASHSEED !== '0') prompts.reverse();
    return { prompts, ...hints };
  });
  if (!process.env.NO_RESOURCES) {
    server.setRequestHandler('resources/list', async (request) => {
      if (process.env.NO_KEY) throw new Error('Not authenticated: set LISTS_API_KEY.');
      if (process.env.PAGED) {
        const at = Number(request.params?.cursor ?? 0);
        return { resources: [{ uri: `file:///${at}.txt`, name: String(at) }], nextCursor: String(at + 1), ...hints };
      }
      const resources = [{ uri: 'file:///a.txt', name: 'a' }, { uri: 'file:///b.txt', name: 'b' }];
      if (process.env.VARY && calls++ % 2) resources.reverse();
      return { resources, ...hints };
    });
    if (!process.env.NO_TEMPLATES) {
      server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }], ...hints }));
    }
  }
  return server;
}

// What a server that skips the SDK would send: a result without its cache hints.
function rewrite(line) {
  if (!process.env.NO_HINTS || !line.includes('resourceTemplates')) return line;
  const message = JSON.parse(line);
  if (message.result) {
    delete message.result.ttlMs;
    delete message.result.cacheScope;
  }
  return JSON.stringify(message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(String(chunk).split('\n').map((l) => (l.trim() ? rewrite(l) : l)).join('\n'), ...rest);
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
