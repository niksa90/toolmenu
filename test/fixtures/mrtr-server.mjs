// Multi round-trip requests (2026-07-28, SEP-2322): tools that ask the client for
// input by returning `input_required`, one tool per behaviour. All read-only, so
// session --auto calls them. plain_tool asks for nothing: the control.
// Serves 2026-07-28 via serveStdio, or only the 2025 protocol when LEGACY=1.
import { McpServer, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const ro = { readOnlyHint: true };
const confirm = (message) =>
  inputRequired.elicit({ message, requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } });

export function build() {
  const server = new McpServer(
    { name: 'mrtr-fixture', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // A state check that refuses the retry: the SDK answers it with a -32602 protocol error.
      requestState: {
        verify: (state) => {
          if (state === 'refuse-retry') throw new Error('state check failed');
          return state;
        },
      },
    },
  );
  const reg = (name, description, handler) => server.registerTool(name, { description, inputSchema: {}, annotations: ro }, handler);

  reg('plain_tool', 'Asks for nothing.', async () => text('done'));

  // Asks once; a decline completes with a result the model can read.
  reg('ask_confirm', 'Asks the user to confirm, then answers.', async (_args, ctx) => {
    const r = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
    if (r.kind === 'missing') return inputRequired({ inputRequests: { confirm: confirm('Go ahead?') } });
    return text(r.kind === 'elicit' && r.action === 'accept' ? 'went ahead' : `stopped: the user chose ${r.kind === 'elicit' ? r.action : r.kind}`);
  });

  // URL mode: the interaction happens out of band; a decline completes too.
  reg('ask_url', 'Sends the user to a page to authorize, then answers.', async (_args, ctx) => {
    const r = inputResponse(ctx.mcpReq.inputResponses, 'connect');
    if (r.kind === 'missing') return inputRequired({ inputRequests: { connect: inputRequired.elicitUrl({ message: 'Connect your account', url: 'https://example.test/connect' }) }, requestState: 'url-1' });
    return text(`not connected: ${r.kind === 'elicit' ? r.action : r.kind}`);
  });

  // Two different questions in turn, then an answer: not a loop.
  reg('ask_twice', 'Asks two different things in turn.', async (_args, ctx) => {
    const state = ctx.mcpReq.requestState();
    if (!state) return inputRequired({ inputRequests: { first: confirm('First question?') }, requestState: 'asked-first' });
    if (state === 'asked-first') return inputRequired({ inputRequests: { second: confirm('Second question?') }, requestState: 'asked-second' });
    return text('answered both');
  });

  // Needs its requestState back, byte for byte, or it can't go on.
  reg('ask_with_state', 'Keeps its place in requestState.', async (_args, ctx) => {
    const state = ctx.mcpReq.requestState();
    if (!state) return inputRequired({ inputRequests: { ok: confirm('Continue?') }, requestState: 'opaque:Zm9v/≈' });
    return state === 'opaque:Zm9v/≈' ? text('state came back intact') : { isError: true, content: [{ type: 'text', text: `requestState came back as ${state}` }] };
  });

  // Ignores the decline and asks the same thing again, every time.
  reg('ask_forever', 'Asks again whatever the answer.', async () => inputRequired({ inputRequests: { confirm: confirm('Go ahead?') } }));

  // A decline gets a tool error back: a result the model can read, which is fine.
  reg('ask_then_error', 'Answers a decline with a tool error.', async (_args, ctx) => {
    const r = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
    if (r.kind === 'missing') return inputRequired({ inputRequests: { confirm: confirm('Go ahead?') } });
    return { isError: true, content: [{ type: 'text', text: 'Not done: the user declined.' }] };
  });

  // The retry carrying the decline fails with a protocol error (its state check refuses it).
  reg('ask_then_refuse', 'Fails the retry with a protocol error.', async () =>
    inputRequired({ inputRequests: { confirm: confirm('Go ahead?') }, requestState: 'refuse-retry' }),
  );

  // Asks for roots without checking the client declared them. The SDK won't send
  // that, so the request goes out as a form and REWRITE (below) turns it into
  // roots/list on the wire, the way a server that skips the check would send it.
  reg('ask_roots_anyway', 'Asks for roots without checking.', async () => inputRequired({ inputRequests: { REWRITE_TO_ROOTS: confirm('placeholder') } }));

  // Its result goes out without resultType (REWRITE removes it), as a hand-written server might send it.
  reg('no_result_type', 'Answers without resultType.', async () => text('NO-RESULT-TYPE'));

  // Asks for roots, which the client didn't declare (and 2026-07-28 deprecates).
  reg('ask_roots', 'Asks the client for its roots.', async () => inputRequired({ inputRequests: { roots: inputRequired.listRoots() } }));

  return server;
}

// What a server that skips the SDK's checks would put on the wire: a roots request
// the client didn't declare, a result without resultType. Rewrites this process's
// own stdout, one JSON-RPC line at a time.
function rewrite(line) {
  if (!line.includes('REWRITE_TO_ROOTS') && !line.includes('NO-RESULT-TYPE')) return line;
  const message = JSON.parse(line);
  const result = message.result ?? {};
  if (result.inputRequests?.REWRITE_TO_ROOTS) result.inputRequests = { roots: { method: 'roots/list' } };
  if (result.content?.[0]?.text === 'NO-RESULT-TYPE') delete result.resultType;
  return JSON.stringify(message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(String(chunk).split('\n').map((l) => (l.trim() ? rewrite(l) : l)).join('\n'), ...rest);
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
