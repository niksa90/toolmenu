/*
 * Multi round-trip requests (2026-07-28, SEP-2322). A tool that needs input
 * answers tools/call with `resultType: "input_required"`, its `inputRequests`, and
 * maybe a `requestState`; the client calls again with `inputResponses` and the
 * `requestState` echoed byte for byte. toolmenu drives the rounds itself
 * (allowInputRequired) so it can see them: every elicitation is declined (or
 * cancelled, --elicitation cancel), no LLM, the same answer every run.
 */
import type { Connection, Elicitation } from './connect.js';

/** Rounds answered before toolmenu stops: a tool still asking after this is stuck. */
export const MAX_ROUNDS = 3;

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
   * undeclared: it asked for something the request didn't declare (roots, sampling).
   * decline-failed: the retry carrying the decline failed with a protocol error.
   */
  outcome: 'none' | 'completed' | 'loop' | 'gave-up' | 'undeclared' | 'decline-failed';
  /** Kinds asked for that the request didn't declare. */
  undeclared?: InputKind[];
  /** The protocol error a retry failed with (decline-failed). */
  error?: unknown;
  /** A raw result on the wire without resultType, which 2026-07-28 servers MUST send. */
  missingResultType?: boolean;
}

type CallResult = Awaited<ReturnType<Connection['client']['callTool']>>;
interface InputRequired {
  resultType: 'input_required';
  inputRequests?: Record<string, { method?: string; params?: { mode?: string } }>;
  requestState?: string;
}

const DECLARED = new Set<InputKind>(['form', 'url']);

function kindOf(request: { method?: string; params?: { mode?: string } }): InputKind {
  if (request.method === 'elicitation/create') return request.params?.mode === 'url' ? 'url' : 'form';
  if (request.method === 'roots/list') return 'roots';
  if (request.method === 'sampling/createMessage') return 'sampling';
  return 'other';
}

/** Keys sorted at every level: the same request asked twice reads the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

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
  let call: Record<string, unknown> = { ...params };
  const trace = (outcome: InputTrace['outcome'], more: Partial<InputTrace> = {}): InputTrace => ({
    rounds,
    kinds,
    outcome,
    ...(missingResultType ? { missingResultType } : {}),
    ...more,
  });
  for (;;) {
    const mark = conn.wire.responses.length;
    let result: CallResult | InputRequired;
    try {
      result = (await conn.client.callTool(call as typeof params, { timeout: options.timeoutMs, allowInputRequired: true })) as CallResult | InputRequired;
    } catch (error) {
      // A result without resultType: the SDK client rejects it ("missing required
      // resultType"). The server did answer, so the step did too; the finding says why
      // clients won't take it.
      const answered = conn.wire.since(mark, 'tools/call').at(-1)?.result;
      if (answered && !('resultType' in answered)) {
        missingResultType = true;
        return { result: answered as CallResult, input: trace(rounds ? 'completed' : 'none') };
      }
      // The first call failing is an ordinary failed step; a retry that carried a
      // decline failing is the server's answer to the decline.
      if (rounds === 0) throw error;
      return { input: trace('decline-failed', { error }) };
    }
    const raw = conn.wire.since(mark, 'tools/call').at(-1)?.result;
    if (raw && !('resultType' in raw)) missingResultType = true;
    if ((result as InputRequired).resultType !== 'input_required') {
      return { result: result as CallResult, input: trace(rounds ? 'completed' : 'none') };
    }
    const asked = (result as InputRequired).inputRequests ?? {};
    for (const request of Object.values(asked)) {
      const k = kindOf(request);
      if (!kinds.includes(k)) kinds.push(k);
    }
    const undeclared = [...new Set(Object.values(asked).map(kindOf).filter((k) => !DECLARED.has(k)))];
    if (undeclared.length) return { input: trace('undeclared', { undeclared }) };
    // The same requests again after a decline: the tool didn't take the answer.
    const signature = canonical(asked);
    if (previous !== undefined && signature === previous && Object.keys(asked).length) repeated = true;
    if (rounds >= MAX_ROUNDS) return { input: trace(repeated ? 'loop' : 'gave-up') };
    previous = signature;
    rounds++;
    const state = (result as InputRequired).requestState;
    call = {
      ...params,
      inputResponses: Object.fromEntries(Object.keys(asked).map((key) => [key, { action }])),
      ...(state !== undefined ? { requestState: state } : {}),
    };
  }
}
