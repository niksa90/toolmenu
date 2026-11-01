// $ref cases (2026-07-28, SEP-2106), one tool each. The official SDK's McpServer
// refuses to register a schema whose $ref it can't resolve, so this serves a
// hand-written tools/list through the low-level Server, as servers in other
// languages can. The VALID tools are the controls: spec/ref must stay quiet.
// Serves 2026-07-28 via serveStdio, or only the 2025 protocol when LEGACY=1.
// REFS=valid serves only the valid tools.
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

const obj = (properties, extra = {}) => ({ type: 'object', properties, ...extra });

export const VALID = {
  ref_defs_ok: { inputSchema: obj({ a: { $ref: '#/$defs/A' } }, { $defs: { A: { type: 'integer' } } }) },
  ref_anchor_ok: { inputSchema: obj({ a: { $ref: '#amount' } }, { $defs: { A: { $anchor: 'amount', type: 'number' } } }) },
  ref_id_ok: { inputSchema: obj({ a: { $ref: 'https://example.com/schemas/a.json' } }, { $defs: { A: { $id: 'https://example.com/schemas/a.json', type: 'string' } } }) },
  ref_recursive_ok: { inputSchema: obj({ name: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } }) },
};

export const BROKEN = {
  ref_input_missing: { inputSchema: obj({ a: { $ref: '#/$defs/Missing' } }) },
  ref_input_network: { inputSchema: obj({ filter: obj({ region: { $ref: 'https://example.com/schemas/region.json' } }) }) },
  ref_output_missing: { inputSchema: obj({}), outputSchema: obj({ result: { $ref: '#/$defs/Result' } }) },
  ref_output_network: { inputSchema: obj({}), outputSchema: obj({ result: { $ref: 'https://example.com/schemas/result.json' } }) },
};

export function build() {
  const server = new Server({ name: 'ref-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = process.env.REFS === 'valid' ? VALID : { ...VALID, ...BROKEN };
  server.setRequestHandler('tools/list', async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({ name, description: `Fixture tool ${name}.`, annotations: { readOnlyHint: true }, ...t })),
    ttlMs: 3_600_000,
    cacheScope: 'public',
  }));
  server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: '{"result":1}' }], structuredContent: { result: 1 } }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
