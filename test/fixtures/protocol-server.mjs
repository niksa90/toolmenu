// A hand-rolled 2025-era stdio server that answers initialize with PROTOCOL (any
// version before 2026-07-28), for the protocol support table (test/protocols.test.mjs).
// unlock adds a tool in the middle of the list, announced with list_changed, the way
// an unlock pattern does; nothing else changes. Every tool is read-only.
import { createInterface } from 'node:readline';

const version = process.env.PROTOCOL ?? '2025-11-25';
const obj = (properties = {}) => ({ type: 'object', properties, required: Object.keys(properties) });
let unlocked = false;
const tools = () => [
  { name: 'search_notes', description: 'Search notes by text. Returns note_id for each match.', inputSchema: obj({ query: { type: 'string' } }), annotations: { readOnlyHint: true } },
  ...(unlocked ? [{ name: 'list_archived_notes', description: 'List archived notes. Returns note_id for each.', inputSchema: obj(), annotations: { readOnlyHint: true } }] : []),
  { name: 'unlock', description: 'Unlock the archive tools.', inputSchema: obj(), annotations: { readOnlyHint: true } },
];

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'protocol-fixture', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: tools() } });
  } else if (msg.method === 'tools/call') {
    if (msg.params?.name === 'unlock' && !unlocked) {
      unlocked = true;
      send({ method: 'notifications/tools/list_changed' });
    }
    send({ id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  } else if (msg.method === 'ping') {
    send({ id: msg.id, result: {} });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
