/*
 * snapshot --read-resources: resources/read on the concrete resources resources/list
 * names, as a client does when a user or an agent picks one. A read, not a tool call.
 *
 * What a body holds is looked at here, in memory, and never kept: the records carry
 * counts, types and error text only, and each response's body is dropped from the wire
 * log once it's been looked at. The rules are in rules/lists.ts.
 */
import { createHash } from 'node:crypto';
import { quietExclusions, type Connection } from './connect.js';
import { classifyFailure, httpStatus, RATE_LIMITED, tooMany, type FailureClass } from './failures.js';
import { resultValidator } from './rules/spec.js';

/** The reads together take at most this long (TOOLMENU_READ_BUDGET_MS sets another, for the tests). */
export const READ_BUDGET_MS = budgetFrom(process.env.TOOLMENU_READ_BUDGET_MS) ?? 120_000;
/** Once this many characters of content have arrived, no further read starts. One response can pass it. */
export const READ_BYTES = 64 * 1024 * 1024;
/** A resource whose listing declares a size over this isn't read. */
export const MAX_DECLARED_SIZE = 16 * 1024 * 1024;
/** Below this much time left, a read isn't started: it could only time out. */
const MIN_READ_MS = 10;

/** Keys of a body that says an error and nothing else: {"error": "… not found"}. */
const ERROR_KEYS = new Set(['error', 'message', 'code', 'status', 'detail', 'details', 'uri']);

/** Why a resource wasn't checked: the run's doing, or by design. */
export type UnreadReason = 'auth' | 'payment' | 'network' | 'client' | 'environment' | 'rate-limit' | 'timeout' | 'input-required' | 'budget' | 'bytes' | 'max-reads' | 'declared-size' | 'web' | 'gone';

export interface ResourceRead {
  uri: string;
  /** The server answered with a result (`ok`), asked for input, answered with an error, or didn't answer. */
  outcome: 'ok' | 'input-required' | 'error' | 'no-answer';
  /** The JSON-RPC error, or the transport's, first line. */
  error?: string;
  code?: number;
  /** Set when the failure is the run's (credentials, the network, a rate limit, a timeout), not the server's. */
  unread?: UnreadReason;
  /** `ok`: how many content items came back. */
  items?: number;
  /** `ok`: every item is text holding a JSON object of these keys only, `error` among them. */
  errorBody?: string[];
  /** `ok`: schema errors against the negotiated version's ReadResourceResult, as lines. */
  schemaErrors?: string[];
  /** Required result properties the schema found missing. */
  missing?: string[];
  /** The SDK client refused a result the server did send. */
  clientError?: string;
  /** Every read failed, all in these words: the server's handler, or one thing this run lacks. */
  shared?: boolean;
  /** A failure's words without the URI, hashed: reads that failed for one cause share it. */
  cause?: string;
  /** The failure says the resource isn't there (its code, "not found", ENOENT). */
  saysMissing?: boolean;
  /** Characters of text and blob received. */
  size?: number;
  ms: number;
}

export interface ResourceReads {
  /** Distinct URIs resources/list named that are this pass's to read. */
  listed: number;
  /** Listed ui:// resources the MCP Apps check read instead (apps/resource). */
  byApps: number;
  reads: ResourceRead[];
  /** Resources no read was sent for, by reason. */
  skipped: { reason: UnreadReason; uris: string[] }[];
  /** resources/list was cut at the page cap: the reads cover what was listed. */
  truncated?: boolean;
  /** The negotiated version has a schema these results were checked against. */
  schemaChecked: boolean;
}

export interface ReadOptions {
  timeoutMs?: number;
  /** --max-reads: at most this many, spread over the sorted list. */
  maxReads?: number;
  /** URIs the Apps pass has a record for: apps/resource owns those. */
  appUris?: Iterable<string>;
  /** The second resources/list: a URI gone from it isn't read (lists/variance says the list changes). */
  second?: Record<string, unknown>[];
  protocolVersion?: string;
  truncated?: boolean;
}

/**
 * n of the sorted items, spread evenly: indices floor(j·(N−1)/(n−1)), so both ends are
 * in; the middle one for n = 1; all of them when n ≥ N.
 */
export function spread<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  if (n === 1) return [items[Math.floor((items.length - 1) / 2)]];
  return Array.from({ length: n }, (_, j) => items[Math.floor((j * (items.length - 1)) / (n - 1))]);
}

/** Read the listed resources, one at a time, in URI order. */
export async function readResources(connection: Connection, listed: Record<string, unknown>[], options: ReadOptions = {}): Promise<ResourceReads> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const declared = new Map<string, number>();
  for (const r of listed) {
    if (typeof r.uri !== 'string' || !r.uri) continue;
    if (!declared.has(r.uri)) declared.set(r.uri, typeof r.size === 'number' ? r.size : 0);
  }
  // By code unit, not by locale: the same order on every machine.
  const all = [...declared.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const skipped = new Map<UnreadReason, string[]>();
  const skip = (reason: UnreadReason, uri: string) => skipped.set(reason, [...(skipped.get(reason) ?? []), uri]);

  const owned = new Set(options.appUris ?? []);
  const still = options.second ? new Set(options.second.map((r) => r.uri)) : undefined;
  const candidates: string[] = [];
  let byApps = 0;
  for (const uri of all) {
    if (owned.has(uri)) {
      byApps++;
      continue;
    }
    // A web URL is one the client fetches itself; a server needn't serve it over resources/read.
    if (/^https?:\/\//i.test(uri)) skip('web', uri);
    else if (still && !still.has(uri)) skip('gone', uri);
    else if ((declared.get(uri) ?? 0) > MAX_DECLARED_SIZE) skip('declared-size', uri);
    else candidates.push(uri);
  }
  const queue = options.maxReads !== undefined ? spread(candidates, options.maxReads) : candidates;
  if (queue.length < candidates.length) {
    const chosen = new Set(queue);
    for (const uri of candidates) if (!chosen.has(uri)) skip('max-reads', uri);
  }

  const validate = options.protocolVersion ? resultValidator(options.protocolVersion, 'ReadResourceResult') : null;
  const validateInput = options.protocolVersion ? resultValidator(options.protocolVersion, 'InputRequiredResult') : null;
  const reads: ResourceRead[] = [];
  const mark = connection.wire.responses.length;
  const deadline = Date.now() + READ_BUDGET_MS;
  let received = 0;
  let stopped: UnreadReason | undefined;
  for (const uri of queue) {
    if (!stopped && deadline - Date.now() < MIN_READ_MS) stopped = 'budget';
    if (!stopped && received > READ_BYTES) stopped = 'bytes';
    if (stopped) {
      skip(stopped, uri);
      continue;
    }
    const read = await readOne(connection, uri, Math.min(timeoutMs, deadline - Date.now()), validate, validateInput);
    received += read.size ?? 0;
    reads.push(read);
    // A server that says "too many" isn't asked again: the rest go unread.
    if (read.unread === 'rate-limit') stopped = 'rate-limit';
  }
  // Every read failed, all for one cause, and none of them for a missing resource: a read
  // handler that fails for everything, or one thing this run lacks that the words don't
  // name. toolmenu can't tell which, so the finding says both (unsure), and stays a warning.
  const failures = reads.filter((r) => !r.unread && (r.outcome === 'error' || r.errorBody));
  const readable = reads.some((r) => r.outcome === 'ok' && !r.errorBody);
  if (!readable && failures.length >= 2 && failures.every((r) => !r.saysMissing && r.cause === failures[0].cause)) {
    for (const r of failures) r.shared = true;
  }
  // An answer that came after its read gave up was never looked at: its body goes too.
  for (const late of connection.wire.since(mark, 'resources/read')) if (late.result) late.result = {};
  return {
    listed: all.length - byApps,
    byApps,
    reads,
    skipped: [...skipped].map(([reason, uris]) => ({ reason, uris })),
    ...(options.truncated ? { truncated: true } : {}),
    schemaChecked: validate !== null,
  };
}

type Validator = ReturnType<typeof resultValidator>;

async function readOne(connection: Connection, uri: string, timeout: number, validate: Validator, validateInput: Validator): Promise<ResourceRead> {
  const mark = connection.wire.responses.length;
  const started = Date.now();
  let caught: unknown;
  await withoutFulfilment(connection, () => quietExclusions(() => connection.client.readResource({ uri }, { timeout }))).catch((e: unknown) => (caught = e));
  const ms = Date.now() - started;
  // What the server sent, not the SDK's reading of it: the SDK may refuse a result toolmenu still checks.
  // By URI: after a timeout, the answer to an earlier read can arrive during this one.
  const answers = connection.wire.since(mark, 'resources/read').filter((r) => r.uri === uri);
  const answer = answers.at(-1);
  try {
    if (answer?.result) {
      const result = answer.result;
      const clientError = caught === undefined ? undefined : firstLine(caught);
      if (result.resultType === 'input_required') {
        return { uri, outcome: 'input-required', unread: 'input-required', ...schemaOf(validateInput, result), ms };
      }
      const contents = Array.isArray(result.contents) ? (result.contents as unknown[]) : [];
      let size = 0;
      for (const c of contents) {
        const item = c as Record<string, unknown> | null;
        if (typeof item?.text === 'string') size += item.text.length;
        if (typeof item?.blob === 'string') size += item.blob.length;
      }
      const body = errorBody(contents);
      // An error-only body for want of credentials or the network is the run's, as an error would be.
      const bodyUnread = body ? runs(body.text, undefined) : undefined;
      return {
        uri,
        outcome: 'ok',
        items: contents.length,
        ...(body ? { errorBody: body.keys, cause: causeOf(body.text, uri), ...(MISSING.test(body.text) ? { saysMissing: true } : {}) } : {}),
        ...(bodyUnread ? { unread: bodyUnread } : {}),
        ...schemaOf(validate, result),
        ...(clientError ? { clientError } : {}),
        size,
        ms,
      };
    }
    if (answer?.error) {
      const message = String(answer.error.message ?? '').split('\n')[0].trim();
      const code = typeof answer.error.code === 'number' ? answer.error.code : undefined;
      const unread = runs(message, code);
      const saysMissing = code === -32002 || code === -32602 || MISSING.test(message);
      return { uri, outcome: 'error', error: message, ...(code !== undefined ? { code } : {}), ...(unread ? { unread } : {}), cause: causeOf(message, uri), ...(saysMissing ? { saysMissing } : {}), ms };
    }
    // No answer: the transport refused the request (HTTP 401, 429…), or it timed out.
    const said = firstLine(caught ?? 'no resources/read response');
    const status = httpStatus(caught);
    const unread: UnreadReason =
      status === 429 || tooMany(caught) ? 'rate-limit' : status === 401 || status === 403 ? 'auth' : status === 402 ? 'payment' : /timed out|timeout/i.test(said) ? 'timeout' : (runs(said, undefined) ?? 'network');
    return { uri, outcome: 'no-answer', error: said, unread, ms };
  } finally {
    // The body has been looked at: the wire log keeps every response until the
    // connection closes, and 200 resources shouldn't add up there.
    for (const a of answers) if (a.result) a.result = {};
  }
}

/**
 * One request per resource: the SDK client answers an InputRequiredResult itself and
 * sends the read again, up to eight times, and toolmenu has no answer worth sending.
 * With that off, the first InputRequiredResult ends the read. A client-wide setting the
 * SDK doesn't expose per request; a test counts the requests, should its name change.
 */
async function withoutFulfilment<T>(connection: Connection, read: () => Promise<T>): Promise<T> {
  const config = (connection.client as unknown as { _inputRequiredDriverConfig?: { autoFulfill?: boolean } })._inputRequiredDriverConfig;
  if (!config) return read();
  const before = config.autoFulfill;
  config.autoFulfill = false;
  try {
    return await read();
  } finally {
    config.autoFulfill = before;
  }
}

/** The reason a failure is the run's and not the server's, from its words and code; undefined when it's the server's. */
export function runs(text: string, code: number | undefined): UnreadReason | undefined {
  // The codes for "no such resource" (-32002 to 2025-11-25, -32602 from 2026-07-28): the
  // server's answer about a resource it listed, whatever else the words mention.
  if (code === -32002 || code === -32602) return undefined;
  if (RATE_LIMITED.test(text)) return 'rate-limit';
  if (NETWORK_WORDS.test(text)) return 'network';
  if (CREDENTIAL_WORDS.test(text)) return 'auth';
  if (SETUP_WORDS.test(text)) return 'environment';
  const failure: FailureClass = classifyFailure(text, { code });
  if (failure === 'auth' || failure === 'payment' || failure === 'network' || failure === 'client') return failure;
  // Something this machine lacks (a browser, an app). A missing file is not that: for a
  // listed resource, ENOENT is the server naming a file it doesn't have.
  if (failure === 'environment' && !/\bENOENT\b/.test(text)) return 'environment';
  return undefined;
}

/**
 * A read that couldn't get out, in the words servers use (the bench, 2026-11): "self-signed
 * certificate in certificate chain" (Lara, Shodan behind a proxy), "[SSL:
 * CERTIFICATE_VERIFY_FAILED]" and "[Errno -3] Temporary failure in name resolution"
 * (StackHawk), "API error: fetch failed" (Glif), "Transport error (GET https://…)"
 * (effect-mcp), `Get "https://…": dial tcp` (Terraform).
 */
const NETWORK_WORDS = /self-signed certificate|certificate verify failed|CERTIFICATE_VERIFY_FAILED|unable to (?:get|verify) [^.]{0,30}certificate|failure in name resolution|no such host|\bfetch failed\b|\btransport error\b|\bdial tcp\b|\bGet "https?:\/\/|connection (?:refused|reset|timed out)|network is unreachable/i;
/**
 * A credential in the wrong shape, which a dummy one is: "Access token is not in valid JWT
 * format" (Mapbox); or none sent: "missing authorization header" (a hosted server that lists
 * its tools without one, then wants one to read a resource).
 */
const CREDENTIAL_WORDS = /\bmissing (?:an? |the )?(?:authorization|auth|bearer) (?:header|token)\b|\b(?:access |api |auth )?(?:token|key)\b[^.]{0,30}\b(?:not in (?:a )?valid|malformed|invalid format)\b/i;
/**
 * Nothing to read from: "No currently active project." (Firebase), "Invalid kube-config file. No
 * configuration found." (kubectl-mcp-server), "HTTP protocol is not allowed when skipTLSVerify is
 * not set" (mcp-server-kubernetes with no cluster), "You must provide an endpoint" (Amazon Neptune).
 */
const SETUP_WORDS = /\bno (?:currently )?(?:active|selected|default|current) (?:project|account|workspace|organi[sz]ation|cluster|context|profile)\b|\binvalid kube-?config\b|\bskipTLSVerify\b|\bmust provide an? (?:endpoint|host|url|connection string)\b/i;
/** The failure says the resource isn't there. */
const MISSING = /\bnot found\b|\bENOENT\b|no such file|does(?:n't| not) exist/i;

/** A failure's words with the URI taken out, hashed: the same for every resource one cause stops. */
function causeOf(text: string, uri: string): string {
  let words = text;
  for (const form of new Set([uri, encodeURI(uri), uri.toLowerCase()])) words = words.split(form).join('<uri>');
  return createHash('sha1').update(words.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 12);
}

/** A body that is only an error: each item text, a JSON object of ERROR_KEYS with `error` among them. */
function errorBody(contents: unknown[]): { keys: string[]; text: string } | undefined {
  if (!contents.length) return undefined;
  const keys = new Set<string>();
  let text = '';
  for (const c of contents) {
    const item = c as Record<string, unknown> | null;
    if (typeof item?.text !== 'string' || item.text.length > 4096 || !/^\s*\{/.test(item.text)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const object = parsed as Record<string, unknown>;
    const own = Object.keys(object);
    if (!own.includes('error') || !object.error || own.some((k) => !ERROR_KEYS.has(k))) return undefined;
    for (const k of own) keys.add(k);
    const inner = typeof object.error === 'object' ? (object.error as Record<string, unknown>).message : object.error;
    text += ` ${typeof inner === 'string' ? inner : ''} ${typeof object.message === 'string' ? object.message : ''}`;
  }
  return { keys: [...keys].sort(), text: text.trim() };
}

/** The result against the schema: the errors as lines (paths and rules, never values). */
function schemaOf(validate: Validator, result: Record<string, unknown>): { schemaErrors?: string[]; missing?: string[] } {
  // Before the validator: it narrows a result it refuses to nothing.
  const contents: unknown = result.contents;
  if (!validate || validate(result)) return {};
  const errors = validate.errors ?? [];
  // Each item is tried as text and as blob: the union's own line says nothing the others don't.
  const has = (path: string, key: string) => {
    const index = /^\/contents\/(\d+)$/.exec(path)?.[1];
    const item = index !== undefined && Array.isArray(contents) ? (contents[Number(index)] as Record<string, unknown> | null) : undefined;
    return typeof item?.[key] === 'string';
  };
  const needs = (path: string, property: string) => errors.some((e) => e.instancePath === path && e.params && 'missingProperty' in e.params && e.params.missingProperty === property);
  const lines = [
    ...new Set(
      errors
        .filter((e) => e.keyword !== 'anyOf')
        // An item with text was tried as a blob too: "needs blob" there is the union's noise.
        .filter((e) => !(e.keyword === 'required' && e.instancePath && (has(e.instancePath, 'text') !== has(e.instancePath, 'blob'))))
        // An item is text or a blob: one line for an item with neither, not one per kind.
        .map((e) => (e.instancePath && needs(e.instancePath, 'text') && needs(e.instancePath, 'blob') && e.keyword === 'required' ? `${e.instancePath} must have text or blob` : `${e.instancePath || '(result)'} ${e.message}`)),
    ),
  ];
  const missing = [...new Set(errors.filter((e) => !e.instancePath && e.params && 'missingProperty' in e.params).map((e) => String(e.params.missingProperty)))];
  return { schemaErrors: lines.length ? lines : ['(result) does not match'], ...(missing.length ? { missing } : {}) };
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].trim();

function budgetFrom(text: string | undefined): number | undefined {
  const n = Number(text);
  return text && Number.isFinite(n) && n > 0 ? n : undefined;
}
