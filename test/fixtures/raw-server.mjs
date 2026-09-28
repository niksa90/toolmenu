// A hand-rolled 2025-era stdio server, so tests control every byte of tools/list.
// FIXTURE picks the misbehaviour.
import { createInterface } from 'node:readline';

const fixture = process.env.FIXTURE ?? 'smells';
const str = { type: 'string' };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

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
    send({ id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: `raw-${fixture}`, version: '0.0.1' } } });
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
