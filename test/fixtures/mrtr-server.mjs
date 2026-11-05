// Multi round-trip requests (2026-07-28, SEP-2322): tools that ask the client for
// input by returning `input_required`, one tool per behaviour. All read-only, so
// session --auto calls them. plain_tool asks for nothing: the control.
// Serves 2026-07-28 via serveStdio, or only the 2025 protocol when LEGACY=1.
import { McpServer, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

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

  // Keeps working through requestState-only rounds, asking nothing, then answers.
  reg('keep_working', 'Works in steps, then answers.', async (_args, ctx) => {
    const step = Number(ctx.mcpReq.requestState() ?? '0');
    return step < 2 ? inputRequired({ requestState: String(step + 1) }) : text('worked in 3 steps');
  });

  // Never finishes: requestState-only rounds forever.
  reg('work_forever', 'Never finishes.', async (_args, ctx) => inputRequired({ requestState: `${Number(ctx.mcpReq.requestState() ?? '0') + 1}` }));

  // BAD_STATE=1: asks with a requestState REWRITE turns into an object (the SDK seals the one it's given), which no client can echo as it came.
  if (process.env.BAD_STATE) {
    reg('object_state', 'Keeps its state as an object.', async (_args, ctx) =>
      ctx.mcpReq.inputResponses ? text('called again without its state') : inputRequired({ inputRequests: { OBJECT_STATE: confirm('Go?') }, requestState: 'x' }),
    );
  }

  // Asks the same question again after a decline, under a new key and with new wording each time.
  reg('ask_forever_reworded', 'Asks again, worded anew.', async (_args, ctx) => {
    const n = Number(ctx.mcpReq.requestState() ?? '0') + 1;
    return inputRequired({ inputRequests: { [`confirm-${n}`]: confirm(`Go ahead? (asked ${n} times)`) }, requestState: String(n) });
  });

  // Answers a decline with a tool error whose words sound like an auth problem: still its answer to the decline.
  reg('ask_then_auth_error', 'Needs a connected account.', async (_args, ctx) => {
    const r = inputResponse(ctx.mcpReq.inputResponses, 'connect');
    if (r.kind === 'missing') return inputRequired({ inputRequests: { connect: inputRequired.elicitUrl({ message: 'Connect GitHub', url: 'https://example.test/github' }) }, requestState: 'gh' });
    return { isError: true, content: [{ type: 'text', text: 'Not authenticated with GitHub: the user declined to connect their account.' }] };
  });

  // UNLOCK=1: an unlock that asks to confirm, forever, so it never unlocks anything.
  if (process.env.UNLOCK) {
    server.registerTool(
      'enable_toolset',
      { description: 'Unlock more tools: "billing" or "reports".', inputSchema: { toolset: z.enum(['billing', 'reports']) }, annotations: ro },
      async () => inputRequired({ inputRequests: { confirm: confirm('Unlock?') } }),
    );
  }

  // HANG=1: the retry after the decline never answers (a timeout, not the server refusing the decline).
  if (process.env.HANG) {
    reg('ask_then_hang', 'Hangs on the retry.', async (_args, ctx) => {
      if (inputResponse(ctx.mcpReq.inputResponses, 'confirm').kind === 'missing') return inputRequired({ inputRequests: { confirm: confirm('Go ahead?') } });
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return text('too late');
    });
  }

  // TASK=1: answers with a task to poll (ext-tasks) though the client declared no Tasks support.
  if (process.env.TASK) reg('start_job', 'Starts a long job.', async () => text('MAKE-TASK'));

  // Asks for roots, which the client didn't declare (and 2026-07-28 deprecates).
  reg('ask_roots', 'Asks the client for its roots.', async () => inputRequired({ inputRequests: { roots: inputRequired.listRoots() } }));

  return server;
}

// What a server that skips the SDK's checks would put on the wire: a roots request
// the client didn't declare, a result without resultType. Rewrites this process's
// own stdout, one JSON-RPC line at a time.
function rewrite(line) {
  if (!line.includes('REWRITE_TO_ROOTS') && !line.includes('NO-RESULT-TYPE') && !line.includes('OBJECT_STATE') && !line.includes('MAKE-TASK')) return line;
  const message = JSON.parse(line);
  const result = message.result ?? {};
  if (result.inputRequests?.REWRITE_TO_ROOTS) result.inputRequests = { roots: { method: 'roots/list' } };
  if (result.content?.[0]?.text === 'NO-RESULT-TYPE') delete result.resultType;
  if (result.inputRequests?.OBJECT_STATE) result.requestState = { step: 1 };
  if (result.content?.[0]?.text === 'MAKE-TASK') {
    message.result = { resultType: 'task', taskId: 'task-1', status: 'working', createdAt: '2026-11-05T10:00:00Z', lastUpdatedAt: '2026-11-05T10:00:00Z', ttlMs: 60000, pollIntervalMs: 1000 };
  }
  return JSON.stringify(message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(String(chunk).split('\n').map((l) => (l.trim() ? rewrite(l) : l)).join('\n'), ...rest);
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
