/*
 * Why toolmenu couldn't talk to a server, said the way SPEC §25 asks: what
 * failed, at which stage, what was seen, and what to try next. connect() keeps a
 * Trace of what happened (the requests sent, the process's exit, its stdout and
 * stderr), and explain() turns a transport's terse error ("Request timed out",
 * "fetch failed", an HTML page) into a ConnectError that says it in full.
 */
import type { ChildProcess } from 'node:child_process';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { LoginNeededError } from './auth.js';

/** What connect() saw on the way to an error. */
export class Trace {
  readonly startedAt = Date.now();
  /** stdio: when the process toolmenu keeps was started (after the server/discover probe, which runs on its own process). */
  sessionStartedAt?: number;
  /** Requests sent, in order, with when (ms since epoch). */
  readonly sent: { method: string; at: number }[] = [];
  /** Methods that got an answer (a result or a JSON-RPC error). */
  readonly answered = new Set<string>();
  /** HTTP: the last response to each method (status, content type, final URL). */
  readonly http = new Map<string, { status: number; statusText: string; contentType: string; url: string }>();
  process?: ChildProcess;
  /** How the process ended. `afterStop`: it ended after toolmenu sent it SIGTERM, so the exit may be toolmenu's doing. */
  exit?: { code: number | null; signal: string | null; afterStop?: boolean };
  /** When connecting failed, before toolmenu stopped the server and read the rest of its stderr. */
  failedAt?: number;
  /** toolmenu sent the process SIGTERM (connecting had already failed). */
  stopped = false;
  /** stdout lines that aren't JSON-RPC: the first few, and how many in all. */
  readonly stray: string[] = [];
  strayCount = 0;
  private stdoutPartial = '';
  /** The last stderr lines, and how many there were in all. */
  readonly stderrTail: string[] = [];
  stderrLines = 0;
  private stderrPartial = '';

  send(method: string): void {
    this.sent.push({ method, at: Date.now() });
  }

  /** A chunk of the server's stdout: remembers lines that aren't JSON-RPC messages. */
  stdout(chunk: string): void {
    if (this.strayCount >= 1000) return;
    const lines = (this.stdoutPartial + chunk).split('\n');
    const last = lines.pop() ?? '';
    // A JSON-RPC line can be megabytes (a big tools/list): only its start matters here.
    this.stdoutPartial = last.length > 4096 ? last.slice(0, 4096) : last;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // JSON-RPC over stdio is one JSON object per line. A JSON log line (pino) is
      // an object too, but without "jsonrpc".
      if (line.startsWith('{') && line.slice(0, 4096).includes('"jsonrpc"')) continue;
      this.strayCount++;
      if (this.stray.length < 2) this.stray.push(clean(line, 160));
    }
  }

  stderr(chunk: string): void {
    const lines = (this.stderrPartial + chunk).split('\n');
    this.stderrPartial = (lines.pop() ?? '').slice(-2000);
    for (const line of lines) this.pushStderr(line);
  }

  private pushStderr(line: string): void {
    const text = clean(line, 240);
    if (!text) return;
    this.stderrLines++;
    this.stderrTail.push(text);
    if (this.stderrTail.length > STDERR_LINES) this.stderrTail.shift();
  }

  /** The stderr tail, the unfinished last line included. */
  stderrExcerpt(): { lines: string[]; total: number } {
    const partial = clean(this.stderrPartial, 240);
    const lines = partial ? [...this.stderrTail, partial].slice(-STDERR_LINES) : this.stderrTail;
    return { lines, total: this.stderrLines + (partial ? 1 : 0) };
  }

  /** The last request sent that got no answer. */
  pending(): { method: string; at: number } | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) if (!this.answered.has(this.sent[i].method)) return this.sent[i];
    return undefined;
  }
}

/** How many of the server's last stderr lines an error shows: errors are at the end. */
export const STDERR_LINES = 12;

/** An error that already says what happened, where, and what to do. */
export class ConnectError extends Error {
  /** The HTTP status, when the server answered with one (read by tooMany and the action). */
  status?: number;
  constructor(
    readonly headline: string,
    readonly facts: [string, string][],
    readonly next: string | undefined,
    readonly stage: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(formatBlock(headline, facts, next), { cause: options.cause });
    this.name = 'ConnectError';
    if (options.status !== undefined) this.status = options.status;
  }
}

/** A headline, then aligned facts, then the next step. Multi-line facts are indented under their label. */
export function formatBlock(headline: string, facts: [string, string][], next?: string): string {
  const width = Math.max(0, ...facts.map(([label]) => label.length));
  const lines = [headline];
  for (const [label, value] of facts) {
    const [first, ...more] = value.split('\n');
    lines.push(`  ${label.padEnd(width)}  ${first}`);
    for (const line of more) lines.push(`  ${' '.repeat(width)}  ${line}`);
  }
  if (next) lines.push(`  → Next: ${next}`);
  return lines.join('\n');
}

/** Printable text: no ANSI colours or control characters, at most `max` characters. */
export function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** "5.0 s", "0.3 s", "62 s". */
export function seconds(ms: number): string {
  return `${ms < 10_000 ? (Math.round(ms / 100) / 10).toFixed(1) : Math.round(ms / 1000)} s`;
}

/** The command line, for a message: arguments with spaces quoted, cut at 120 characters. Never the --env values. */
export function commandLine(command: string, args: string[]): string {
  const quoted = [command, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  return quoted.length > 120 ? `${quoted.slice(0, 119)}…` : quoted;
}

/** The stderr fact: the last lines, and a note of how many came before. */
export function stderrFact(trace: Trace): [string, string] {
  const { lines, total } = trace.stderrExcerpt();
  if (!lines.length) return ['stderr', '(nothing)'];
  const cut = total - lines.length;
  const header = cut > 0 ? `last ${lines.length} of ${total} lines (${cut} earlier lines not shown)` : `${total} line${total === 1 ? '' : 's'}`;
  return ['stderr', [header, ...lines.map((l) => `│ ${l}`)].join('\n')];
}

function strayFact(trace: Trace): [string, string] {
  const quoted = trace.stray.map((l) => `“${l}”`).join('\n');
  const more = trace.strayCount > trace.stray.length ? `\n(${trace.strayCount} such lines in all)` : '';
  return ['stdout', `${quoted}${more}`];
}

const LOG_TO_STDERR = 'Log to stderr; stdout carries the protocol (in Node, console.error rather than console.log; in Python, logging or print(..., file=sys.stderr)).';

/** The error codes along an error's cause chain, innermost last. */
function causes(error: unknown): (Error & { code?: string; syscall?: string })[] {
  const out: (Error & { code?: string })[] = [];
  let e: unknown = error;
  for (let i = 0; i < 6 && e instanceof Error; i++) {
    out.push(e);
    const next: unknown = e.cause ?? (e as { data?: { cause?: unknown } }).data?.cause;
    if (next === e) break;
    e = next;
  }
  return out;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  408: 'Request Timeout', 410: 'Gone', 415: 'Unsupported Media Type', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** A request header that carries credentials: Authorization, a cookie, or a name with key, token, secret or auth in it (x-mcp-api-key). */
export function isCredentialHeader(name: string): boolean {
  return /^(authorization|cookie)$/i.test(name) || /(key|token|secret|auth)/i.test(name);
}

/**
 * The header a refusal names ("missing or invalid x-mcp-api-key header",
 * "header 'X-Api-Key' required"), lower-cased. Only a name with a hyphen, or
 * Authorization: plain words before "header" ("the header") aren't names.
 */
export function namedHeader(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const name = /\b([A-Za-z][\w-]*)["'`]?\s+header\b/i.exec(body)?.[1] ?? /\bheader\s*[:(]?\s*["'`]?([A-Za-z][\w-]*)/i.exec(body)?.[1];
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return lower === 'authorization' || /-/.test(lower) ? lower : undefined;
}

/** A short, readable excerpt of a response body: an HTML page's title or first words, JSON's message. Never the whole body. */
export function bodyExcerpt(body: string | undefined, max = 100): string | undefined {
  if (!body?.trim()) return undefined;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1];
  let text = title ?? body;
  if (!title && /<[a-z!][^>]*>/i.test(body)) {
    text = body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
  const message = /"(?:message|error_description|error|detail)"\s*:\s*"((?:[^"\\]|\\.){1,300})"/.exec(text)?.[1];
  if (message) text = message.replace(/\\(.)/g, '$1');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return text ? clean(text, max) : undefined;
}

export interface ExplainContext {
  target: { kind: 'stdio'; command: string; args: string[] } | { kind: 'http'; url: string; headers?: Record<string, string> };
  timeoutMs?: number;
  /** A stored OAuth login was used. */
  oauth?: boolean;
  /** The stage when it isn't the connect handshake (tools/list). */
  stage?: string;
}

/**
 * The error as a ConnectError that says what happened, or the error unchanged
 * when there's nothing to add (a refusal for too many requests keeps its own path).
 */
export function explain(error: unknown, trace: Trace, context: ExplainContext): unknown {
  if (error instanceof ConnectError || !(error instanceof Error)) return error;
  // A stored OAuth login that can't be used already says why, and what to run.
  const login = causes(error).find((e) => e instanceof LoginNeededError);
  if (login) return login;
  return context.target.kind === 'stdio' ? explainStdio(error, trace, context, context.target) : explainHttp(error, trace, context, context.target);
}

/**
 * What kind of failure this is. The SDK's own types come first: a JSON-RPC error
 * response is the server's answer, whatever its words say ("upstream request
 * timed out"). The words are read only for errors that aren't typed.
 */
function failureKind(error: Error): 'server' | 'timeout' | 'closed' | undefined {
  for (const e of causes(error)) {
    if (e instanceof ProtocolError) return 'server';
    if (e instanceof SdkError) {
      if (e.code === SdkErrorCode.RequestTimeout) return 'timeout';
      if (e.code === SdkErrorCode.ConnectionClosed) return 'closed';
      return undefined;
    }
  }
  if (/connection closed/i.test(error.message)) return 'closed';
  if (/timed out|timeout/i.test(error.message)) return 'timeout';
  return undefined;
}

/** The server's JSON-RPC error answer, said as such: its words and its code. */
function serverAnswered(error: Error, stage: string, facts: [string, string][], next: string): ConnectError {
  const protocol = causes(error).find((e) => e instanceof ProtocolError) as (Error & { code?: unknown }) | undefined;
  const words = firstLine((protocol ?? error).message.replace(/^MCP error -?\d+:\s*/, ''));
  const code = typeof protocol?.code === 'number' ? ` (${protocol.code})` : '';
  return new ConnectError(`The server answered ${stage} with an error: “${words}”${code}.`, facts, next, stage, { cause: error });
}

function explainStdio(error: Error, trace: Trace, context: ExplainContext, target: { command: string; args: string[] }): unknown {
  const command = commandLine(target.command, target.args);
  const spawnError = causes(error).find((e) => typeof e.syscall === 'string' && e.syscall.startsWith('spawn'));
  if (spawnError) {
    const code = spawnError.code;
    if (code === 'ENOENT') {
      return new ConnectError(
        `Couldn't start the server: “${target.command}” wasn't found (spawn ENOENT).`,
        [['command', command]],
        `Check it's installed and on PATH (which ${target.command}), or give its full path. The server gets a minimal environment: PATH comes from toolmenu's, or from --env PATH=….`,
        'starting the server',
        { cause: error },
      );
    }
    if (code === 'EACCES') {
      return new ConnectError(
        `Couldn't start the server: “${target.command}” isn't executable (spawn EACCES).`,
        [['command', command]],
        `Make it executable (chmod +x ${target.command}), or run it through its interpreter (node, python3, uv run).`,
        'starting the server',
        { cause: error },
      );
    }
    return new ConnectError(`Couldn't start the server: ${error.message}.`, [['command', command]], `Run the command yourself to check it starts: ${command}`, 'starting the server', { cause: error });
  }

  const kind = failureKind(error);
  const pending = trace.pending();
  const facts: [string, string][] = [['server', command]];

  if (kind === 'server') {
    // Its answer is the last request sent, so not pending any more.
    const stage = context.stage ?? trace.sent.at(-1)?.method ?? (trace.sessionStartedAt ? 'initialize' : 'server/discover');
    if (trace.strayCount) facts.push(strayFact(trace));
    facts.push(stderrFact(trace));
    return serverAnswered(error, stage, facts, `That's the server's own error, not the connection: fix what it says (its stderr may say more), or retry if the cause upstream has passed. To see it yourself, run: ${command}`);
  }

  const stage = context.stage ?? pending?.method ?? (trace.sessionStartedAt ? 'initialize' : 'server/discover');
  // An exit after toolmenu's own SIGTERM is toolmenu's doing, not the server's, when
  // the request had already timed out or the process died of that very signal.
  const ours = trace.exit?.afterStop && (kind === 'timeout' || trace.exit.signal === 'SIGTERM' || trace.exit.code === 143);
  const exit = ours ? undefined : trace.exit;
  const closed = kind === 'closed';

  if (exit || closed) {
    const how = !exit
      ? 'closed its stdout'
      : exit.signal
        ? `was killed by ${exit.signal}${exit.signal === 'SIGKILL' ? ' (out of memory, or killed from outside)' : ''}`
        : `exited with code ${exit.code}`;
    if (trace.strayCount) facts.push(strayFact(trace));
    facts.push(stderrFact(trace));
    const stderrText = trace.stderrExcerpt().lines.join('\n');
    const rejected = rejectedCredentials(stderrText);
    let next: string;
    if (/cannot find (module|package)|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named/i.test(stderrText)) {
      next = "The server is missing one of its own dependencies (see stderr): reinstall it, or try another version. It's a packaging problem, not your setup.";
    } else if (rejected) {
      next = REJECTED_NEXT;
    } else if (trace.strayCount) {
      next = `${LOG_TO_STDERR} Then fix what stderr says.`;
    } else if (trace.stderrLines) {
      next = `Fix what the server's stderr says above, then rerun. To see all of it, run the command yourself: ${command}`;
    } else {
      next = `Run the command yourself to see why it stops: ${command}`;
    }
    const when = stage === 'tools/list' || stage === 'initialize' || stage === 'server/discover' ? `before it answered ${stage}` : `during ${stage}`;
    const why = next === REJECTED_NEXT ? `; its stderr looks like rejected credentials (“${rejected}”)` : '';
    return new ConnectError(`The server ${how} ${when}${why}.`, facts, next, stage, { cause: error });
  }

  if (kind === 'timeout') {
    const now = trace.failedAt ?? Date.now();
    const waitedHere = pending ? now - pending.at : context.timeoutMs ?? 0;
    const probeMs = trace.sessionStartedAt !== undefined ? trace.sessionStartedAt - trace.startedAt : undefined;
    const limit = context.timeoutMs;
    const probeTimedOut = probeMs !== undefined && limit !== undefined && probeMs >= limit * 0.95;
    const waited = [
      ...(stage === 'initialize' && probeMs !== undefined ? [`${seconds(probeMs)} on server/discover${probeTimedOut ? ' (no answer)' : ''}, then `] : []),
      `${seconds(waitedHere)} on ${stage}`,
      limit !== undefined ? ` (--timeout ${limit} applies to each request)` : '',
    ].join('');
    facts.push(['waited', waited]);
    if (stage === 'initialize' && probeTimedOut) {
      facts.push(['why twice', 'server/discover (the 2026 handshake) goes first, to a throwaway copy of the server.\nNo answer may just mean a 2025 server, so toolmenu starts it again and tries initialize.']);
    }
    if (trace.strayCount) facts.push(strayFact(trace));
    facts.push(stderrFact(trace));
    const rejected = trace.strayCount ? undefined : rejectedCredentials(trace.stderrExcerpt().lines.join('\n'));
    const headline = trace.strayCount
      ? `${stage} timed out after ${seconds(waitedHere)}: the server wrote lines that aren't JSON-RPC to stdout, and never answered.`
      : rejected
        ? `${stage} timed out after ${seconds(waitedHere)}: the server is running but never answered; its stderr looks like rejected credentials (“${rejected}”).`
        : `${stage} timed out after ${seconds(waitedHere)}: the server is running but never answered.`;
    const next = trace.strayCount
      ? LOG_TO_STDERR
      : rejected
        ? REJECTED_NEXT
        : stage === 'tools/list'
        ? 'The server answered initialize, then hung on tools/list: check its logs (stderr above). If building the list is just slow, raise --timeout.'
        : 'Check the command starts an MCP server on stdio (some need an argument such as "stdio" or "--stdio"). If it is only slow to start (npx downloading, a first build), raise --timeout.';
    return new ConnectError(headline, facts, next, stage, { cause: error });
  }

  // Anything else: the transport's words, with what the server said.
  if (trace.strayCount) facts.push(strayFact(trace));
  facts.push(['stage', stage], stderrFact(trace));
  return new ConnectError(`${firstLine(error.message)}`, facts, trace.strayCount ? LOG_TO_STDERR : undefined, stage, { cause: error });
}

/** Words in a server's stderr that usually mean its API key or token was refused upstream. */
const REJECTED = /\b401\b(?:\s+Unauthori[sz]ed)?|\bUnauthori[sz]ed\b|invalid[_ -]api[_ -]key|invalid[_ -](?:access[_ -])?token|authentication failed|do not pass authentication/i;

/** The phrase in stderr that looks like rejected credentials, if any: a guess, so it's said as one. */
function rejectedCredentials(stderrText: string): string | undefined {
  return REJECTED.exec(stderrText)?.[0];
}

const REJECTED_NEXT = "Check the API key or token the server was given (--env, or its config): it's likely wrong, expired or for another account. This is a reading of the server's log, not certain: read its stderr above.";

function firstLine(text: string): string {
  return clean(text.split('\n')[0], 300);
}

const TLS = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|EPROTO$)/;

function explainHttp(error: Error, trace: Trace, context: ExplainContext, target: { url: string; headers?: Record<string, string> }): unknown {
  const url = new URL(target.url);
  const host = url.hostname;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  // Requests go one at a time while connecting: the last one sent is the one that failed.
  const stage = context.stage ?? trace.sent.at(-1)?.method ?? 'server/discover';
  const first = trace.sent.length <= 1 ? `${stage}, the first request` : stage;
  const chain = causes(error);
  const coded = [...chain].reverse().find((e) => typeof e.code === 'string' && !/^[A-Z_]+_FAILED$|^CLIENT_HTTP|^REQUEST_TIMEOUT$|^ERA_/.test(e.code));
  const code = coded?.code;
  const innermost = chain.at(-1);

  // The network, before any HTTP answer.
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ConnectError(
      code === 'ENOTFOUND' ? `Couldn't find ${host}: the name doesn't resolve (DNS: ENOTFOUND).` : `Couldn't look up ${host}: DNS failed for now (EAI_AGAIN).`,
      [['url', target.url], ['stage', first]],
      code === 'ENOTFOUND'
        ? "Check the host name for typos. If it's right, the server may have moved or shut down: look up its current URL in its docs or registry entry."
        : 'Check this machine\'s network and DNS, then retry.',
      stage,
      { cause: error },
    );
  }
  if (code === 'ECONNREFUSED') {
    return new ConnectError(
      `Nothing is listening at ${host}:${port}: the connection was refused (ECONNREFUSED).`,
      [['url', target.url], ['stage', first]],
      `Start the server, or check the host and port${url.port ? '' : ` (no port in the URL means ${port})`}.`,
      stage,
      { cause: error },
    );
  }
  if (innermost && /^bad port$/i.test(innermost.message)) {
    return new ConnectError(
      `fetch won't connect to port ${port}: it's one of the ports Node blocks, because other protocols own them.`,
      [['url', target.url], ['stage', first]],
      'Serve the MCP endpoint on another port (3000 and 8080 are common).',
      stage,
      { cause: error },
    );
  }
  if (code && TLS.test(code)) {
    const expired = code === 'CERT_HAS_EXPIRED';
    const selfSigned = /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code);
    const plain = code === 'ERR_SSL_WRONG_VERSION_NUMBER' || /wrong version number/i.test(coded?.message ?? '');
    return new ConnectError(
      `The TLS handshake with ${host} failed: ${coded?.message} (${code}).`,
      [['url', target.url], ['stage', first]],
      plain
        ? `That port speaks plain HTTP: use http://${url.host}${url.pathname}.`
        : expired
          ? "The server's certificate has expired: its operator needs to renew it."
          : selfSigned
            ? 'For a local or internal server with its own certificate authority, trust it with NODE_EXTRA_CA_CERTS=/path/to/ca.pem, or use http:// on a local port.'
            : `Check the certificate: curl -v ${target.url}`,
      stage,
      { cause: error },
    );
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new ConnectError(
      `Couldn't connect to ${host}:${port} in time (${code}).`,
      [['url', target.url], ['stage', first]],
      'Check the host is reachable from here: a firewall, VPN or proxy may be dropping the connection.',
      stage,
      { cause: error },
    );
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new ConnectError(`No route to ${host} (${code}).`, [['url', target.url], ['stage', first]], "Check this machine's network, VPN or proxy.", stage, { cause: error });
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || /other side closed|socket hang up/i.test(innermost?.message ?? '')) {
    return new ConnectError(
      `${host} closed the connection in the middle of ${stage} (${code ?? innermost?.message}).`,
      [['url', target.url]],
      "Retry. If it keeps happening, check for a proxy between here and the server, or the server's logs.",
      stage,
      { cause: error },
    );
  }

  // An HTTP answer that isn't MCP.
  const data = (error as { data?: { status?: unknown; statusText?: unknown; text?: unknown } }).data;
  const response = trace.http.get(stage);
  const status = typeof data?.status === 'number' ? data.status : typeof (error as { status?: unknown }).status === 'number' ? (error as unknown as { status: number }).status : response?.status;
  const unexpected = /unexpected content type/i.test(error.message);
  if (status === 429) return error;
  if (status !== undefined && (status >= 400 || unexpected) || unexpected) {
    const statusText = (typeof data?.statusText === 'string' && data.statusText) || response?.statusText || STATUS_TEXT[status ?? 0] || '';
    const httpLine = status !== undefined ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : 'a response';
    const contentType = response?.contentType || (unexpected ? /content type:\s*(\S+)/i.exec(error.message)?.[1] ?? '' : '');
    const shortType = contentType.split(';')[0].trim();
    const body = typeof data?.text === 'string' ? data.text : undefined;
    const excerpt = bodyExcerpt(body);
    const finalUrl = response?.url && response.url !== target.url ? response.url : undefined;
    const facts: [string, string][] = [['url', target.url]];
    if (finalUrl) facts.push(['redirected', finalUrl]);
    facts.push(['answer', `${httpLine}${shortType ? `, ${shortType}` : ''}`]);
    if (excerpt) facts.push([/html/i.test(shortType) || /<html|<!doctype/i.test(body ?? '') ? 'page' : 'body', `“${excerpt}”`]);

    if (status === 401 || status === 403) {
      const named = namedHeader(body);
      const ownAuth = Object.keys(target.headers ?? {}).some((h) => isCredentialHeader(h) || h.toLowerCase() === named);
      const next = context.oauth
        ? `The stored login was refused: log in again with toolmenu auth login ${target.url} (or skip it with --no-auth).`
        : ownAuth
          ? status === 401
            ? 'The credentials you sent were refused: check the token is current and meant for this server.'
            : "The credentials were accepted but don't grant access: check the account's permissions or the token's scopes."
          : named && named !== 'authorization'
            ? `The server asks for ${/^[aeiox]/.test(named) ? 'an' : 'a'} ${named} header: pass it with --header "${named}: <key>".`
            : `If the server uses OAuth, log in once with: toolmenu auth login ${target.url} (if it takes an API key instead, pass it with --header "Authorization: Bearer …").`;
      return new ConnectError(
        status === 401 ? `${host} wants credentials: ${stage} got HTTP 401 Unauthorized.` : `${host} refused access: ${stage} got HTTP 403 Forbidden.`,
        facts.filter(([l]) => l !== 'answer'),
        next,
        stage,
        { cause: error, status },
      );
    }

    // The server's own JSON-RPC error: its words, not a page.
    const rpc = body && /"jsonrpc"/.test(body) ? bodyExcerpt(body, 200) : undefined;
    if (rpc) {
      return new ConnectError(
        `The server refused ${stage} (${httpLine}): “${rpc}”`,
        facts.filter(([l]) => l !== 'body'),
        "Check the server's docs for a required header or query parameter (pass headers with --header \"Key: value\").",
        stage,
        { cause: error, status },
      );
    }
    if (status !== undefined && status >= 500) {
      return new ConnectError(
        `${host} failed: ${stage} got ${httpLine}.`,
        facts,
        "That's on the server's side: retry later, or check its logs or status page.",
        stage,
        { cause: error, status },
      );
    }
    const sse = /\/sse\/?$/.test(url.pathname);
    const html = /html/i.test(shortType);
    const why = status === 404 ? 'nothing is served at that path' : status === 405 ? "it doesn't accept POST there" : html ? 'it answered with a web page' : shortType ? `it answered with ${shortType}` : 'the answer isn\'t MCP';
    return new ConnectError(
      `${target.url} isn't an MCP endpoint: ${stage} got ${httpLine}${shortType && status !== undefined ? ` (${shortType})` : ''}, so ${why}.`,
      facts.filter(([l]) => l !== 'answer'),
      sse
        ? `A URL ending in /sse is the older HTTP+SSE transport, which toolmenu doesn't speak. Most servers serve Streamable HTTP too: try ${url.origin}${url.pathname.replace(/\/sse\/?$/, '/mcp')}.`
        : `Check the endpoint's path in the server's docs: Streamable HTTP servers usually answer at /mcp (not /sse, the older transport, and not the site's home page).`,
      stage,
      { cause: error, ...(status !== undefined ? { status } : {}) },
    );
  }

  const kind = failureKind(error);
  if (kind === 'server') {
    return serverAnswered(
      error,
      stage,
      [['url', target.url]],
      "That's the server's own error, not the connection: fix what it says, or retry if the cause upstream has passed. If it persists, its operator's logs or status page may say more.",
    );
  }
  if (kind === 'timeout') {
    const got = response ? `${host} answered (HTTP ${response.status}) but sent no JSON-RPC reply` : `no response from ${host}`;
    return new ConnectError(
      `${stage} timed out after ${seconds(context.timeoutMs ?? 0)}: ${got}.`,
      [['url', target.url], ['stage', first]],
      `Check the URL answers from here (curl -i -X POST ${target.url}); a firewall or VPN may be in the way. If the server is only slow, raise --timeout.`,
      stage,
      { cause: error },
    );
  }
  return error;
}
