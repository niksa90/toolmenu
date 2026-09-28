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
};

let calls = 0;
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
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
