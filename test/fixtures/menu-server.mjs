// A 2025-era stdio server that serves the tools in the MENU environment variable (JSON).
// For tests that need several servers with tool lists of their own (scan across servers).
import { createInterface } from 'node:readline';

const tools = JSON.parse(process.env.MENU ?? '[]');
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: process.env.NAME ?? 'menu', version: '0.0.1' } } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools } });
  else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
