// A hand-rolled 2025-era stdio server, so tests control every byte of tools/list.
// FIXTURE picks the misbehaviour.
import { createInterface } from 'node:readline';

const fixture = process.env.FIXTURE ?? 'smells';
const str = { type: 'string' };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

// Whether the client declared elicitation in initialize (the confirm fixture).
let elicits = false;
// Whether it declared the MCP Apps extension (the apps fixtures).
let apps = false;
const APP_MIME = 'text/html;profile=mcp-app';
const ui = (resourceUri, extra = {}) => ({ _meta: { ui: { resourceUri, ...extra } } });
// The UI resources the apps fixtures serve: chart as an app, table with the wrong type.
const UI_RESOURCES = {
  'ui://fx/chart': { mimeType: APP_MIME, text: '<!doctype html><html><body>chart</body></html>' },
  'ui://fx/table': { mimeType: 'text/html', text: '<!doctype html><html><body>table</body></html>' },
};

const MENUS = {
  smells: () => [
    { name: 'list_team_audits', description: 'List the audits a team has done.', inputSchema: obj({ team_id: str }), annotations: { readOnlyHint: true } },
    { name: 'get_audit_trail', description: 'Get the audit trail: who changed what.', inputSchema: obj({}), annotations: { readOnlyHint: true } },
    { name: 'list_teams', description: 'List teams. Returns team_id for each.', inputSchema: obj({}), annotations: { readOnlyHint: true } },
    { name: 'update_form', description: 'Update a form.', inputSchema: obj({ form_id: str, title: str }) },
    { name: 'delete_record', description: 'Delete a record.', inputSchema: obj({ id: str }), annotations: { destructiveHint: true } },
  ],
  shuffle: (call) => {
    const tools = [
      { name: 'a_tool', description: 'A.', inputSchema: obj({}) },
      { name: 'b_tool', description: 'B.', inputSchema: obj({}) },
      { name: 'c_tool', description: 'C.', inputSchema: obj({}) },
    ];
    return call % 2 ? tools : [tools[1], tools[0], tools[2]];
  },
  drift: (call) => [
    { name: 'get_time', description: `Get the time. Generated at call ${call}.`, inputSchema: obj({}), annotations: { readOnlyHint: true } },
  ],
  badschema: () => [{ name: 'no_schema', description: 'Missing inputSchema.' }],
  // Like github-mcp-server 1.14's delete_repository: listed only to a client that declared elicitation.
  confirm: () => [
    { name: 'get_thing', description: 'Get a thing.', inputSchema: obj({}), annotations: { readOnlyHint: true } },
    ...(elicits ? [{ name: 'delete_thing', description: 'Delete a thing, after the user confirms.', inputSchema: obj({ thing: str }), annotations: { destructiveHint: true } }] : []),
  ],
  // MCP Apps, each way the apps/* rules fire. APPS_LEAK=1 lists the app-only tool to
  // every client, not only to one that declared the extension.
  apps: () => [
    // A text variant to a client without Apps, the UI one to an Apps host.
    apps
      ? { name: 'show_chart', description: 'Show the chart as an interactive view.', inputSchema: obj({}), annotations: { readOnlyHint: true }, ...ui('ui://fx/chart') }
      : { name: 'show_chart', description: 'Show the chart as text.', inputSchema: obj({}), annotations: { readOnlyHint: true } },
    // Named like a write, no annotations: the agent never sees it, but the host still
    // confirms the app's calls by annotations, so write/unannotated names it.
    ...(apps || process.env.APPS_LEAK ? [{ name: 'update_chart_data', description: 'Called by the chart view.', inputSchema: obj({ series: str }), ...ui('ui://fx/chart', { visibility: ['app'] }) }] : []),
    ...(apps ? [{ name: 'open_dashboard', description: 'Open the dashboard.', inputSchema: obj({}), annotations: { readOnlyHint: true }, ...ui('ui://fx/chart') }] : []),
    { name: 'show_map', description: 'Show a map.', inputSchema: obj({}), annotations: { readOnlyHint: true }, ...ui('ui://fx/missing') },
    { name: 'show_table', description: 'Show a table.', inputSchema: obj({}), annotations: { readOnlyHint: true }, ...ui('ui://fx/table') },
    { name: 'show_web', description: 'Show a page.', inputSchema: obj({}), annotations: { readOnlyHint: true }, ...ui('https://example.com/view') },
    { name: 'show_legacy', description: 'Show the old view.', inputSchema: obj({}), annotations: { readOnlyHint: true }, _meta: { 'ui/resourceUri': 'ui://fx/chart' } },
    { name: 'hidden_tool', description: 'Nobody can call this.', inputSchema: obj({}), annotations: { readOnlyHint: true }, ...ui('ui://fx/chart', { visibility: [] }) },
  ],
  // MCP Apps done right: quiet. The app-only tool is listed only to an Apps host.
  'apps-clean': () => [
    { name: 'show_chart', description: 'Show the chart.', inputSchema: obj({}), annotations: { readOnlyHint: true }, ...ui('ui://fx/chart', { visibility: ['model', 'app'] }), ...{ _meta: { ui: { resourceUri: 'ui://fx/chart', visibility: ['model', 'app'] }, 'ui/resourceUri': 'ui://fx/chart' } } },
    ...(apps ? [{ name: 'update_chart_data', description: 'Called by the chart view.', inputSchema: obj({ series: str }), ...ui('ui://fx/chart', { visibility: ['app'] }) }] : []),
  ],
  clean: () => [{ name: 'ping_service', description: 'Check the service is up.', inputSchema: obj({}), annotations: { readOnlyHint: true } }],
  // Search and execute, like Sentry (catalog: standard tool definitions) and
  // Atlassian (catalog-inputs: an `inputs` list). CATALOG_VERSION=2 makes a
  // breaking change to one operation and drops another.
  catalog: () => SEARCH_MENU,
  'catalog-inputs': () => SEARCH_MENU,
    // Like mcp-atlassian 0.23.1: a default built from a set, in the process's hash
  // order. Stable within a process, different per PYTHONHASHSEED (and per process
  // when it's unset).
  seedorder: () => {
    const fields = ['summary', 'status', 'assignee', 'labels', 'priority'];
    const seed = process.env.PYTHONHASHSEED ?? String(process.pid);
    const shift = [...seed].reduce((n, c) => n + c.charCodeAt(0), 0) % fields.length;
    const order = [...fields.slice(shift), ...fields.slice(0, shift)];
    return [{ name: 'get_issue', description: 'Get an issue.', inputSchema: obj({ issue_key: str, fields: { type: 'string', default: order.join(',') } }, ['issue_key']), annotations: { readOnlyHint: true } }];
  },
};

const SEARCH_MENU = [
  { name: 'search_ops_tools', description: 'Find operations not in your tool list.', inputSchema: obj({ query: str, limit: { anyOf: [{ type: 'integer', maximum: 20 }, { type: 'null' }] } }, ['query']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'execute_op', description: 'Run an operation by name.', inputSchema: obj({ name: str, params: { type: 'object' } }, ['name']) },
];
const v2 = process.env.CATALOG_VERSION === '2';
const OPERATIONS = [
  { name: 'list_releases', description: 'List releases.', inputSchema: obj({ project: str, limit: { type: 'integer' } }, ['project']) },
  { name: 'get_release', description: 'Get one release.', inputSchema: obj(v2 ? { project: str, version: str, region: str } : { project: str, version: str }) },
  ...(v2 ? [] : [{ name: 'delete_release', description: 'Delete a release.', inputSchema: obj({ version: str }) }]),
];
/** What the search tool answers: operations whose name shares a word with the query. */
function search(query) {
  const words = query.toLowerCase().split(/\W+/);
  const match = (w, q) => q && (w.startsWith(q) || q.startsWith(w));
  // Ranked like a real search: the operation whose name matches most query words first.
  const score = (op) => op.name.split('_').filter((w) => words.some((q) => match(w, q))).length;
  const hits = OPERATIONS.filter((op) => score(op) > 0).sort((a, b) => score(b) - score(a));
  if (fixture === 'catalog-inputs') {
    // Like Atlassian's discover: the best match as JSON, then a prose list of other
    // operations (which makes the text invalid JSON as a whole).
    const others = OPERATIONS.filter((op) => !hits.slice(0, 1).includes(op)).map((op) => `  ${op.name} — ${op.description}`).join('\n');
    const results = hits.slice(0, 1).map((op) => ({ name: op.name, description: op.description, executeTool: 'execute_op', inputs: Object.entries(op.inputSchema.properties).map(([name, p]) => ({ name, type: p.type === 'integer' ? 'number' : p.type, ...(p.type === 'integer' ? { integer: true } : {}), required: op.inputSchema.required.includes(name) })) }));
    return { content: [{ type: 'text', text: `${JSON.stringify({ results })}\n\nRelated operations:\n${others}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ query, results: hits }) }], structuredContent: { query, results: hits } };
}

let calls = 0;
let searches = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') {
    elicits = !!msg.params?.capabilities?.elicitation;
    apps = (msg.params?.capabilities?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes ?? []).includes(APP_MIME);
    const caps = process.env.NO_TOOLS_CAPABILITY ? {} : { tools: {}, ...(fixture.startsWith('apps') ? { resources: {} } : {}) };
    send({ id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: caps, serverInfo: { name: `raw-${fixture}`, version: '0.0.1' } } });
  } else if (msg.method === 'resources/read' && fixture.startsWith('apps')) {
    const r = UI_RESOURCES[msg.params?.uri];
    send(r ? { id: msg.id, result: { contents: [{ uri: msg.params.uri, ...r }] } } : { id: msg.id, error: { code: -32002, message: `Resource not found: ${msg.params?.uri}` } });
  } else if (msg.method === 'resources/list' && fixture.startsWith('apps')) {
    send({ id: msg.id, result: { resources: [] } });
  } else if (msg.method === 'tools/list') {
    calls++;
    send({ id: msg.id, result: { tools: MENUS[fixture](calls) } });
  } else if (msg.method === 'tools/call' && msg.params?.name === 'search_ops_tools') {
    searches++;
    // RATE_LIMIT=first: the first search is rate-limited, as Sentry did. =always: every one is.
    const limited = process.env.RATE_LIMIT === 'always' || (process.env.RATE_LIMIT === 'first' && searches === 1);
    send({ id: msg.id, result: limited ? { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded. Please wait before trying again.' }] } : search(String(msg.params.arguments?.query ?? '')) });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
