import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';
import type { ChildProcess } from 'node:child_process';
import type { Stream } from 'node:stream';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { hasLogin, StoredOAuthProvider } from './auth.js';
import { explain, isCredentialHeader, Trace } from './explain.js';
import { endSession } from './close.js';
import { eraOf } from './menu.js';
import type { Era } from './types.js';
import { VERSION } from './version.js';

export type Target =
  | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers?: Record<string, string>; noAuth?: boolean };

export interface WireResponse {
  method: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Every response the server sent, matched to the request method, as it came off the wire. */
export class WireLog {
  readonly responses: WireResponse[] = [];
  /** Methods of notifications the server sent, in order. */
  readonly notifications: string[] = [];
  private pending = new Map<string | number, string>();

  tap(transport: Transport): void {
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if ('method' in message && 'id' in message && message.id !== undefined) {
        this.pending.set(message.id, message.method);
      }
      return send(message, options);
    };
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ('method' in message && !('id' in message && message.id !== undefined)) {
        this.notifications.push(message.method);
      }
      if (!('method' in message) && 'id' in message && message.id !== undefined) {
        const method = this.pending.get(message.id);
        if (method) {
          this.pending.delete(message.id);
          this.responses.push({
            method,
            ...('result' in message ? { result: message.result as Record<string, unknown> } : {}),
            ...('error' in message ? { error: message.error as WireResponse['error'] } : {}),
          });
        }
      }
      onmessage?.(message, extra);
    };
  }

  /** How many notifications of `method` arrived after the first `mark` notifications. */
  notificationsSince(mark: number, method: string): number {
    return this.notifications.slice(mark).filter((m) => m === method).length;
  }

  /** Responses to `method` received since `mark` (a previous `responses.length`). */
  since(mark: number, method: string): WireResponse[] {
    return this.responses.slice(mark).filter((r) => r.method === method);
  }
}

export interface Connection {
  client: Client;
  wire: WireLog;
  protocolVersion?: string;
  era?: Era;
  server: { name?: string; version?: string };
  capabilities: Record<string, unknown>;
  /** True when the request carried credentials (an Authorization-style header). */
  usedAuth: boolean;
  stderr: () => string;
  close: () => Promise<void>;
  /** An error from a request on this connection, said with what the connection saw (exit code, stderr, stray stdout). */
  explain?: (error: unknown, stage: string) => unknown;
  /** Resolves once a server that just failed a request has had its say on stderr (all of it, if it exited). */
  stderrSettled?: () => Promise<void>;
}

export interface ConnectOptions {
  timeoutMs?: number;
}

export async function connect(target: Target, options: ConnectOptions = {}): Promise<Connection> {
  const client = new Client({ name: 'toolmenu', version: VERSION }, { versionNegotiation: { mode: 'auto' } });
  let transport: Transport;
  let stderrText = '';
  let oauth = false;
  const trace = new Trace();
  let stdioStderr: Stream | null = null;

  if (target.kind === 'stdio') {
    const stdio = new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: { ...getDefaultEnvironment(), ...target.env },
      cwd: target.cwd,
      stderr: 'pipe',
    });
    stdio.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText = (stderrText + text).slice(-4000);
      trace.stderr(text);
    });
    stdioStderr = stdio.stderr;
    watchProcess(stdio, trace);
    transport = stdio;
  } else {
    // A stored OAuth login (toolmenu auth login) is used unless the request brings
    // its own Authorization header, or --no-auth.
    const ownAuth = Object.keys(target.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
    oauth = !target.noAuth && !ownAuth && hasLogin(target.url);
    transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: { headers: target.headers ?? {} },
      fetch: tracedFetch(trace),
      ...(oauth ? { authProvider: new StoredOAuthProvider(target.url) } : {}),
    });
  }
  const context = { target, timeoutMs: options.timeoutMs, oauth };

  try {
    await client.connect(transport, { timeout: options.timeoutMs });
  } catch (error) {
    // What failed is fixed now: the exit that follows toolmenu's own SIGTERM isn't the server's doing.
    trace.failedAt = Date.now();
    // A server that never answered is stopped now, not after close()'s grace period for a clean exit.
    if (trace.process && !trace.exit) {
      trace.stopped = true;
      trace.process.kill('SIGTERM');
    }
    // Read stderr to its end: the last lines usually say why the server exited. A
    // process that has exited closes its end of the pipe, so wait for all of it (a
    // loaded CI runner took over a second for 300 lines, and the reason is last);
    // one toolmenu just stopped gets a moment to exit first.
    if (target.kind === 'stdio') {
      if (!trace.exit) await exited(trace, 1000);
      await stderrEnded(stdioStderr, trace.exit ? STDERR_AFTER_EXIT_MS : 1000);
    }
    await endSession(client, transport);
    throw explain(error, trace, context);
  }
  const wire = new WireLog();
  wire.tap(transport);

  const protocolVersion = client.getNegotiatedProtocolVersion();
  const server: { name?: string; version?: string } = client.getServerVersion() ?? {};
  return {
    client,
    wire,
    protocolVersion,
    era: eraOf(protocolVersion),
    server: { name: server.name, version: server.version },
    capabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>,
    usedAuth:
      target.kind === 'http' &&
      (oauth || Object.keys(target.headers ?? {}).some(isCredentialHeader)),
    stderr: () => stderrText,
    close: () => endSession(client, transport),
    explain: (error, stage) => explain(error, trace, { ...context, stage }),
    stderrSettled: async () => {
      if (target.kind !== 'stdio') return;
      // A server still running gets a moment to exit; one that exited is read to the end of its stderr.
      if (!trace.exit) await exited(trace, 200);
      if (trace.exit) await stderrEnded(stdioStderr, STDERR_AFTER_EXIT_MS);
    },
  };
}

/** How long to wait for an exited server's stderr to end: its pipe is closing, so this is only a ceiling for a stuck one. */
const STDERR_AFTER_EXIT_MS = 10_000;

/** Resolves when the traced process has exited, or after `maxMs`. */
function exited(trace: Trace, maxMs: number): Promise<void> {
  const child = trace.process;
  if (!child || trace.exit) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    child.once('exit', () => {
      clearTimeout(timer);
      // The exit listener that records trace.exit runs first: it was added at spawn.
      resolve();
    });
  });
}

/** Resolves when `stream` has ended, or after `maxMs`. */
function stderrEnded(stream: Stream | null, maxMs: number): Promise<void> {
  if (!stream || maxMs <= 0 || (stream as { readableEnded?: boolean }).readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    stream.once('end', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Watch the stdio process toolmenu keeps (not the throwaway one the SDK starts
 * for the server/discover probe): when it started, what it was asked, what it
 * answered, its exit, and stdout lines that aren't JSON-RPC. The hooks go on this
 * instance only: the SDK clones the transport's class for the probe.
 */
function watchProcess(stdio: StdioClientTransport, trace: Trace): void {
  const start = stdio.start.bind(stdio);
  stdio.start = async () => {
    trace.sessionStartedAt = Date.now();
    const onmessage = (stdio as Transport).onmessage;
    const ids = new Map<string | number, string>();
    const t: Transport = stdio;
    t.onmessage = (message, extra) => {
      if (!('method' in message) && 'id' in message && message.id !== undefined) {
        const method = ids.get(message.id);
        if (method) trace.answered.add(method);
      }
      onmessage?.(message, extra);
    };
    const send = t.send.bind(stdio);
    t.send = (message, options) => {
      if ('method' in message && 'id' in message && message.id !== undefined) {
        ids.set(message.id, message.method);
        trace.send(message.method);
      }
      return send(message, options);
    };
    await start();
    const child = (stdio as unknown as { _process?: ChildProcess })._process;
    if (child) {
      trace.process = child;
      child.once('exit', (code, signal) => (trace.exit = { code, signal, afterStop: trace.stopped }));
      child.stdout?.on('data', (chunk: Buffer) => trace.stdout(chunk.toString()));
    }
  };
}

/** fetch, noting each JSON-RPC request's method and the answer's status, content type and final URL. */
function tracedFetch(trace: Trace): typeof fetch {
  return async (input, init) => {
    let method: string | undefined;
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as { method?: unknown; id?: unknown };
        if (typeof body.method === 'string' && body.id !== undefined) method = body.method;
      } catch {
        // Not JSON: not a request to trace.
      }
    }
    if (method) trace.send(method);
    const response = await fetch(input, init);
    if (method) {
      trace.http.set(method, { status: response.status, statusText: response.statusText, contentType: response.headers.get('content-type') ?? '', url: response.url });
    }
    return response;
  };
}

export interface ToolList {
  tools: Record<string, unknown>[];
  /** Every page's raw result, for schema validation. */
  pages: Record<string, unknown>[];
  listMeta: { ttlMs?: number; cacheScope?: string };
  /** Set when the SDK client rejected the result (toolmenu still reads it off the wire). */
  clientError?: string;
}

/** One full `tools/list`, bypassing the SDK's cache, read from the wire rather than the SDK's parsed copy. */
export async function listTools(connection: Connection, options: ConnectOptions = {}): Promise<ToolList> {
  const mark = connection.wire.responses.length;
  let clientError: string | undefined;
  let caught: unknown;
  try {
    await connection.client.listTools(undefined, { cacheMode: 'bypass', timeout: options.timeoutMs });
  } catch (error) {
    caught = error;
    clientError = error instanceof Error ? error.message : String(error);
  }
  const responses = connection.wire.since(mark, 'tools/list');
  const pages = responses.flatMap((r) => (r.result ? [r.result] : []));
  if (clientError && pages.length === 0) {
    // Let stderr arrive first, as for connect: the reason is usually its last lines.
    await connection.stderrSettled?.();
    throw connection.explain?.(caught, 'tools/list') ?? new Error(clientError);
  }
  const first = pages[0] ?? {};
  return {
    tools: pages.flatMap((p) => (Array.isArray(p.tools) ? (p.tools as Record<string, unknown>[]) : [])),
    pages,
    listMeta: {
      ...(typeof first.ttlMs === 'number' ? { ttlMs: first.ttlMs } : {}),
      ...(typeof first.cacheScope === 'string' ? { cacheScope: first.cacheScope } : {}),
    },
    ...(clientError ? { clientError } : {}),
  };
}
