// A hand-rolled 2025-era Streamable HTTP server with real sessions (Mcp-Session-Id),
// so a menu can change for one connection only.
// SCOPE=local: unlock_toolset changes this session's menu only.
// SCOPE=global: it changes every session's menu.
// VARY=1: every new session gets a slightly different menu.
// onePerClient: one session per mcp-client-id header, like toolception: a new
// session for the same client expires the old one.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function start({ scope = 'local', vary = false, onePerClient = false } = {}) {
  const sessions = new Map();
  const byClient = new Map();
  const global = { unlocked: false };
  let sessionCount = 0;
  const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
  const ro = { readOnlyHint: true };
  const menu = (session) => {
    const unlocked = scope === 'global' ? global.unlocked : session.unlocked;
    return [
      { name: 'search_forms', description: 'Search forms.', inputSchema: obj({ query: { type: 'string' } }), annotations: ro },
      ...(unlocked ? [{ name: 'list_team_audits', description: 'List the audits a team has done.', inputSchema: obj({ team: { type: 'string' } }), annotations: ro }] : []),
      { name: 'get_form', description: vary ? `Get one form. (session ${session.n})` : 'Get one form.', inputSchema: obj({ form_id: { type: 'string' } }), annotations: ro },
      { name: 'unlock_toolset', description: 'Unlock the audit tools.', inputSchema: obj({}), annotations: ro },
    ];
  };
  const server = createServer(async (req, res) => {
    // DELETE ends a session (what a client sends when it's done with one).
    if (req.method === 'DELETE') {
      res.writeHead(sessions.delete(req.headers['mcp-session-id']) ? 200 : 404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    const headers = { 'content-type': 'application/json' };
    let session = sessions.get(req.headers['mcp-session-id']);
    if (msg.method === 'initialize') {
      const id = randomUUID();
      session = { unlocked: false, n: ++sessionCount };
      sessions.set(id, session);
      headers['mcp-session-id'] = id;
      const client = req.headers['mcp-client-id'];
      if (onePerClient && client) {
        sessions.delete(byClient.get(client));
        byClient.set(client, id);
      }
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let body;
    if (msg.method === 'initialize') {
      body = { result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: `raw-http-${scope}`, version: '0.0.1' } } };
    } else if (!session && onePerClient) {
      res.writeHead(404, headers).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Session not found or expired' } }));
      return;
    } else if (!session) {
      body = { error: { code: -32601, message: 'Method not found' } };
    } else if (msg.method === 'tools/list') {
      body = { result: { tools: menu(session) } };
    } else if (msg.method === 'tools/call' && msg.params?.name === 'unlock_toolset') {
      if (scope === 'global') global.unlocked = true;
      else session.unlocked = true;
      body = { result: { content: [{ type: 'text', text: 'unlocked' }] } };
    } else {
      body = { error: { code: -32601, message: 'Method not found' } };
    }
    res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    /** Sessions opened and not ended. */
    open: () => sessions.size,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
