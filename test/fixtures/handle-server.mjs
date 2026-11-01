// Server-minted handles (2026-07-28, SEP-2567). Serves 2026-07-28 via serveStdio,
// or only the 2025 protocol when LEGACY=1.
//
// ids/handle-lifetime:
//   start_session   creates a session session_status takes back; says nothing about how long it lasts.
//   create_cart     creates a cart; its description says carts expire.
//   open_basket     creates a basket; its output schema says how long it's valid.
//   create_draft    an email draft: a record that stays, not a handle.
//   acquire_lock    a lock no tool takes back: not a handle the model keeps.
// session/handle-error (session --auto calls each read-only tool below once with a made-up handle):
//   session_status  a protocol error (-32602) for an unknown session: the finding.
//   cart_contents   a tool error that says the cart is unknown or expired: right.
//   basket_total    answers as if any basket existed: no finding (it may be right).
//   send_draft      not read-only: never called.
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const str = { type: 'string' };
const text = (t) => ({ content: [{ type: 'text', text: t }] });

export function build() {
  const server = new McpServer({ name: 'handle-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const reg = (name, description, schema, handler, annotations = { readOnlyHint: true }, outputSchema) =>
    server.registerTool(name, { description, inputSchema: fromJsonSchema(schema), annotations, ...(outputSchema ? { outputSchema: fromJsonSchema(outputSchema) } : {}) }, handler);

  reg('start_session', 'Starts a work session and returns its session_id.', obj({}), async () => text('session_id: s-1'), { readOnlyHint: false });
  reg('session_status', 'Shows the status of a session.', obj({ session_id: str }), async ({ session_id }) => {
    // REWRITE (below) turns this result into the JSON-RPC error a server that throws would send.
    return session_id === 's-1' ? text('active') : text(`PROTOCOL-ERROR Unknown session: ${session_id}`);
  });

  reg('create_cart', 'Creates a shopping cart. Carts expire after 24 hours of inactivity.', obj({}), async () => text('cart_id: c-1'), { readOnlyHint: false });
  reg('cart_contents', 'Lists what is in a cart.', obj({ cart_id: str }), async ({ cart_id }) =>
    cart_id === 'c-1' ? text('empty') : { isError: true, content: [{ type: 'text', text: `Cart ${cart_id} not found or expired: call create_cart for a new one.` }] },
  );

  reg(
    'open_basket',
    'Opens a basket.',
    obj({}),
    async () => ({ content: [{ type: 'text', text: '{"basket_id":"b-1"}' }], structuredContent: { basket_id: 'b-1' } }),
    { readOnlyHint: false },
    obj({ basket_id: { type: 'string', description: 'The basket, valid for 30 minutes after the last change.' } }),
  );
  reg('basket_total', 'Totals a basket.', obj({ basket_id: str }), async () => text('total: 0'));

  reg('create_draft', 'Creates an email draft in the Drafts folder.', obj({ subject: str }), async () => text('draft_id: d-1'), { readOnlyHint: false });
  reg('send_draft', 'Sends a draft.', obj({ draft_id: str }), async () => text('sent'), { readOnlyHint: false, destructiveHint: true });

  reg('acquire_lock', 'Takes the deploy lock.', obj({}), async () => text('locked'), { readOnlyHint: false });
  return server;
}

// The official server SDK turns a throw inside a tool into a tool error; a server
// that answers with a protocol error instead puts this on the wire.
function rewrite(line) {
  if (!line.includes('PROTOCOL-ERROR')) return line;
  const message = JSON.parse(line);
  const said = message.result?.content?.[0]?.text ?? '';
  return JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: said.replace('PROTOCOL-ERROR ', '') } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(String(chunk).split('\n').map((l) => (l.trim() ? rewrite(l) : l)).join('\n'), ...rest);
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
