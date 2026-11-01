// x-mcp-header cases (2026-07-28, SEP-2243), one tool each, with hand-written
// JSON Schemas so an annotation can sit anywhere. Two valid tools are the controls:
// spec/x-mcp-header must stay quiet on them.
// Serves 2026-07-28 via serveStdio, or only the 2025 protocol when LEGACY=1.
// HEADERS=valid serves only the valid tools.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

const str = (extra = {}) => ({ type: 'string', ...extra });
const obj = (properties, extra = {}) => ({ type: 'object', properties, ...extra });

export const VALID = {
  // The reference server's shape (server-everything's get-header-params).
  header_ok: obj({ region: str({ 'x-mcp-header': 'Region' }), repeat: { type: 'integer' } }, { required: ['region'] }),
  // A chain of properties keys is still statically reachable.
  header_nested_ok: obj({ filter: obj({ tenant: { type: 'integer', 'x-mcp-header': 'Tenant-Id' } }) }),
};

export const BROKEN = {
  header_in_items: obj({ ids: { type: 'array', items: str({ 'x-mcp-header': 'Id' }) } }),
  header_in_anyof: obj({ target: { anyOf: [str({ 'x-mcp-header': 'Target' }), { type: 'integer' }] } }),
  header_on_root: { ...obj({ q: str() }), 'x-mcp-header': 'Query' },
  header_bad_token: obj({ region: str({ 'x-mcp-header': 'Region Name' }) }),
  header_empty: obj({ region: str({ 'x-mcp-header': '' }) }),
  header_on_object: obj({ scope: obj({ team: str() }, { 'x-mcp-header': 'Scope' }) }),
  header_no_type: obj({ region: { 'x-mcp-header': 'Region' } }),
  header_type_list: obj({ region: { type: ['string', 'null'], 'x-mcp-header': 'Region' } }),
  header_duplicate: obj({ region: str({ 'x-mcp-header': 'Region' }), zone: str({ 'x-mcp-header': 'region' }) }),
  // The spec forbids number; the official SDK client accepts it for now.
  header_number: obj({ ratio: { type: 'number', 'x-mcp-header': 'Ratio' } }),
};

export function build() {
  const server = new McpServer({ name: 'header-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = process.env.HEADERS === 'valid' ? VALID : { ...VALID, ...BROKEN };
  for (const [name, schema] of Object.entries(tools)) {
    server.registerTool(
      name,
      { description: `Fixture tool ${name}.`, inputSchema: fromJsonSchema(schema), annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
  }
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
