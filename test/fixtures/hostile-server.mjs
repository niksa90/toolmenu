// A 2025-era stdio server whose names, versions and descriptions carry what a
// terminal, GitHub's log parser or markdown would act on. toolmenu must show it, not
// act on it.
import { createInterface } from 'node:readline';

const NAMES = {
  escape: 'a\u001b]0;PWNED\u0007\u001b[2Jb',
  markdown: 'x` ![t](https://evil.example/t.png) @org/team [Approve](https://evil.example) #12 `',
  newline: 'c\n::error::forged\nd',
  bidi: 'safe‮exe.txt',
};
const tools = Object.values(NAMES).map((name) => ({ name, description: `Read things. <img src=x> **bold** www.evil.example`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }));
const serverName = process.env.HOSTILE_NAME ?? 'srv` ![t](https://evil.example/s.png) @org/team `';

const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: serverName, version: '1.0.0\u001b[31m' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
});
