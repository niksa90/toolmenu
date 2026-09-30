// A hand-rolled 2025-era Streamable HTTP server with sessions, shaped like a large
// server that unlocks tools per domain, for this connection only:
// - search_capabilities { domains } says it unlocks a domain's tools, and does
//   (appended at the end of the list);
// - list_recipes { domain } is a lookup: its description says recipes found by
//   a *query* enable tools, the domain is only a filter, and it changes nothing;
// - summarize_domain { domain } has a domain enum but never says it unlocks, and
//   changes nothing;
// - audits_findTypes and audits_getSummary take no parameters and both fail with
//   the same "isn't set up on this deployment" error.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const DOMAINS = { billing: ['billing_findTypes', 'billing_getSummary', 'billing_listInvoices'], reports: ['reports_list', 'reports_get'], alerts: ['alerts_list'] };

export async function start() {
  const sessions = new Map();
  const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
  const ro = { readOnlyHint: true };
  const menu = (session) => [
    { name: 'get_profile', description: 'Get my profile.', inputSchema: obj({}), annotations: ro },
    { name: 'audits_findTypes', description: 'Find audit types.', inputSchema: obj({}), annotations: ro },
    { name: 'audits_getSummary', description: 'Get the audit score summary.', inputSchema: obj({}), annotations: ro },
    {
      name: 'search_capabilities',
      description: 'Finds workflows for a keyword and loads the tools of each chosen domain.',
      inputSchema: obj({ query: { type: 'string' }, domains: { type: 'array', items: { type: 'string', enum: Object.keys(DOMAINS) } } }, []),
      annotations: ro,
    },
    {
      name: 'list_recipes',
      description: 'Lists saved recipes, optionally for one domain. Recipes found by a query enable the tools they use.',
      inputSchema: obj({ query: { type: 'string' }, domain: { type: 'string', enum: ['billing', 'reports', 'alerts', 'approvals'] } }, []),
      annotations: ro,
    },
    { name: 'summarize_domain', description: 'Summarize recent activity in a domain.', inputSchema: obj({ domain: { type: 'string', enum: ['billing', 'reports', 'alerts'] } }), annotations: ro },
    ...[...session.unlocked].flatMap((d) => DOMAINS[d].map((name) => ({ name, description: `${name} for the ${d} domain.`, inputSchema: obj({ id: { type: 'string' } }), annotations: ro }))),
  ];
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
  const server = createServer(async (req, res) => {
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
      session = { unlocked: new Set() };
      sessions.set(id, session);
      headers['mcp-session-id'] = id;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let body;
    if (msg.method === 'initialize') {
      body = { result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'domains-fixture', version: '0.0.1' } } };
    } else if (!session) {
      body = { error: { code: -32601, message: 'Method not found' } };
    } else if (msg.method === 'tools/list') {
      body = { result: { tools: menu(session) } };
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (name === 'search_capabilities') for (const d of args.domains ?? []) session.unlocked.add(d);
      body = {
        result: name.startsWith('audits_')
          ? text("Error: Audits isn't set up on this deployment (the audits module is off).", true)
          : text('ok'),
      };
    } else {
      body = { error: { code: -32601, message: 'Method not found' } };
    }
    res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
