// A hand-rolled 2025-11-25 stdio server for session/output-schema and --call-everything.
// good_shape answers as its outputSchema says; bad_shape doesn't; no_structured
// declares one and returns only text. delete_all is a destructive write, and
// get_record needs an ID nothing in its schema gives: --auto calls neither,
// --call-everything both. Every call is logged to CALL_LOG, when set.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const obj = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const shape = obj({ n: { type: 'number' } });
const tools = [
  { name: 'good_shape', description: 'Count things.', inputSchema: obj(), outputSchema: shape, annotations: { readOnlyHint: true } },
  { name: 'bad_shape', description: 'Count other things.', inputSchema: obj(), outputSchema: shape, annotations: { readOnlyHint: true } },
  { name: 'no_structured', description: 'Count more things.', inputSchema: obj(), outputSchema: shape, annotations: { readOnlyHint: true } },
  { name: 'get_record', description: 'Get one record by record_id.', inputSchema: obj({ record_id: { type: 'string', pattern: '^rec_[0-9]+$' } }), annotations: { readOnlyHint: true } },
  { name: 'delete_all', description: 'Delete every record.', inputSchema: obj({ confirm: { type: 'boolean' } }), annotations: { destructiveHint: true } },
];
const answers = {
  good_shape: { content: [{ type: 'text', text: '{"n":1}' }], structuredContent: { n: 1 } },
  bad_shape: { content: [{ type: 'text', text: '{"n":"one"}' }], structuredContent: { n: 'one' } },
  no_structured: { content: [{ type: 'text', text: 'one' }] },
  get_record: { content: [{ type: 'text', text: '{}' }] },
  delete_all: { content: [{ type: 'text', text: 'deleted' }] },
};

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'output-fixture', version: '1.0.0' } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    if (process.env.CALL_LOG) appendFileSync(process.env.CALL_LOG, JSON.stringify(m.params) + '\n');
    // A record_id that isn't one: a readable tool error, as the spec asks.
    if (m.params?.name === 'get_record' && !/^rec_[0-9]+$/.test(m.params?.arguments?.record_id ?? '')) {
      send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: `Record not found: ${m.params?.arguments?.record_id}` }] } });
      return;
    }
    send({ id: m.id, result: answers[m.params?.name] ?? { isError: true, content: [{ type: 'text', text: 'no such tool' }] } });
  } else send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
});
