/*
 * Multi round-trip requests (2026-07-28, SEP-2322). A tool that needs input
 * answers tools/call with `resultType: "input_required"`, its `inputRequests`, and
 * maybe a `requestState`; the client calls again with `inputResponses` and the
 * `requestState` echoed byte for byte. toolmenu drives the rounds itself
 * (allowInputRequired) so it can see them: every elicitation is declined (or
 * cancelled, --elicitation cancel), no LLM, the same answer every run.
 */
import { canonical } from './compare.js';
import { quietExclusions, type Connection, type Elicitation } from './connect.js';
import { httpStatus, tooMany } from './failures.js';

/** Rounds answered before toolmenu stops: a tool still asking after this is stuck. */
export const MAX_ROUNDS = 3;
/** Rounds that carry only requestState (the tool keeps working, asks nothing) before toolmenu stops. */
export const MAX_CONTINUATIONS = 10;

export type InputKind = 'form' | 'url' | 'roots' | 'sampling' | 'other';

export interface InputTrace {
  /** input_required results answered. */
  rounds: number;
  /** What the tool asked for, in the order first asked. */
  kinds: InputKind[];
  /**
   * none: it asked for nothing. completed: it answered after the decline(s).
   * loop: it asked the same again after a decline, until the round limit.
   * gave-up: still asking (different things) at the round limit.
   * unfinished: still returning requestState-only rounds (working, asking nothing)
   * at MAX_CONTINUATIONS or after 3 × the request timeout in all.
   * undeclared: it asked for something the request didn't declare (roots, sampling).
   * decline-failed: the retry carrying the decline failed with a protocol error.
   */
  outcome: 'none' | 'completed' | 'loop' | 'gave-up' | 'unfinished' | 'undeclared' | 'decline-failed';
  /** Kinds asked for that the request didn't declare. */
  undeclared?: InputKind[];
  /** The protocol error a retry failed with (decline-failed): the server's words, and its JSON-RPC code. */
  error?: { message: string; code?: number };
  /** Rounds that carried only requestState, the tool asking for nothing. */
  continuations?: number;
  /** A raw result on the wire without resultType, which 2026-07-28 servers MUST send. */
  missingResultType?: boolean;
}

type CallResult = Awaited<ReturnType<Connection['client']['callTool']>>;
interface InputRequired {
  resultType: 'input_required';
  inputRequests?: Record<string, { method?: string; params?: Record<string, unknown> }>;
  requestState?: string;
}

const DECLARED = new Set<InputKind>(['form', 'url']);

function kindOf(request: { method?: string; params?: Record<string, unknown> }): InputKind {
  if (request.method === 'elicitation/create') return request.params?.mode === 'url' ? 'url' : 'form';
  if (request.method === 'roots/list') return 'roots';
  if (request.method === 'sampling/createMessage') return 'sampling';
  return 'other';
}

/** What a request asks, without its key or wording: asking the same again reads the same even under a new key or a reworded message. */
function question(request: { method?: string; params?: Record<string, unknown> }): string {
  const p = request.params ?? {};
  // A URL-mode request has no schema: the page it sends the user to is the question.
  return canonical({ method: request.method, mode: p.mode, requestedSchema: p.requestedSchema, url: p.mode === 'url' ? p.url : undefined });
}

/** The words of an error, first line only. */
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].trim();

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Call a tool, answering any input it asks for. On a 2025-era connection it's a
 * plain call (the SDK client's elicitation handler answers there). `result` is
 * undefined when the tool never completed (loop, gave-up, undeclared, decline-failed).
 */
export async function callWithInput(
  conn: Connection,
  params: { name: string; arguments: Record<string, unknown> },
  options: { timeoutMs?: number; elicitation?: Elicitation },
): Promise<{ result?: CallResult; input: InputTrace }> {
  if (conn.era !== 'modern') return { result: await conn.client.callTool(params, { timeout: options.timeoutMs }), input: { rounds: 0, kinds: [], outcome: 'none' } };
  const action = options.elicitation ?? 'decline';
  const kinds: InputKind[] = [];
  let missingResultType = false;
  let previous: string | undefined;
  let repeated = false;
  let rounds = 0;
  let continuations = 0;
  let call: Record<string, unknown> = { ...params };
  const trace = (outcome: InputTrace['outcome'], more: Partial<InputTrace> = {}): InputTrace => ({
    rounds,
    kinds,
    outcome,
    ...(continuations ? { continuations } : {}),
    ...(missingResultType ? { missingResultType } : {}),
    ...more,
  });
  const finished = () => (rounds ? 'completed' : 'none');
  // However many rounds, one call step gets 3 × the request timeout in all.
  const deadline = options.timeoutMs !== undefined ? Date.now() + 3 * options.timeoutMs : undefined;
  for (;;) {
    const mark = conn.wire.responses.length;
    let result: CallResult | InputRequired | undefined;
    try {
      result = (await quietExclusions(() => conn.client.callTool(call as typeof params, { timeout: options.timeoutMs, allowInputRequired: true }))) as CallResult | InputRequired;
    } catch (error) {
      // What the server sent decides what failed, not the error the SDK raised.
      const wire = conn.wire.since(mark, 'tools/call').at(-1);
      const answered = wire?.result as unknown;
      if (isObject(answered) && !('resultType' in answered)) {
        // No resultType: the SDK client rejects it ("missing required resultType").
        // The server did answer; session/result-type says why clients won't take it.
        missingResultType = true;
        return { result: answered as CallResult, input: trace(finished()) };
      }
      if (isObject(answered) && answered.resultType === 'input_required') {
        // The SDK can throw after the fact (output-schema checks on a cached
        // definition): the server asked for input, so carry on with what it sent.
        result = answered as unknown as InputRequired;
      } else {
        // The server's own JSON-RPC error to a retry that carried a decline is its
        // answer to the decline. Anything else goes back to session's handling as a
        // failed call: an SDK check on a result the server did send, a timeout, a lost
        // connection, a rate limit (429 or its words), or a failure before any decline.
        const refused = !!wire?.error && rounds > 0 && httpStatus(error) !== 429 && !tooMany(error);
        if (!refused) throw error;
        const code = wire!.error!.code;
        return { input: trace('decline-failed', { error: { message: firstLine(wire!.error!.message ?? error), ...(typeof code === 'number' ? { code } : {}) } }) };
      }
    }
    if ((result as InputRequired).resultType !== 'input_required') return { result: result as CallResult, input: trace(finished()) };
    const required = result as InputRequired;
    const state = required.requestState;
    const asked = Object.entries(isObject(required.inputRequests) ? required.inputRequests : {});
    if (!asked.length) {
      // Only requestState: the tool keeps working and asks nothing. Send it back.
      if (continuations >= MAX_CONTINUATIONS || (deadline !== undefined && Date.now() >= deadline)) return { input: trace('unfinished') };
      continuations++;
      call = { ...params, ...(state !== undefined ? { requestState: state } : {}) };
      continue;
    }
    const askedKinds = asked.map(([, request]) => kindOf(request));
    for (const k of askedKinds) if (!kinds.includes(k)) kinds.push(k);
    const undeclared = [...new Set(askedKinds.filter((k) => !DECLARED.has(k)))];
    if (undeclared.length) return { input: trace('undeclared', { undeclared }) };
    // The same question again after a decline, whatever its key or wording: the tool didn't take the answer.
    const signature = canonical(asked.map(([, request]) => question(request)).sort());
    if (previous !== undefined && signature === previous) repeated = true;
    if (rounds >= MAX_ROUNDS) return { input: trace(repeated ? 'loop' : 'gave-up') };
    previous = signature;
    rounds++;
    call = {
      ...params,
      inputResponses: Object.fromEntries(asked.map(([key]) => [key, { action }])),
      ...(state !== undefined ? { requestState: state } : {}),
    };
  }
}
