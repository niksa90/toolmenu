import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { eraOf } from './menu.js';
import type { Era } from './types.js';

export type Target =
  | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers?: Record<string, string> };

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
}

export interface ConnectOptions {
  timeoutMs?: number;
}

export async function connect(target: Target, options: ConnectOptions = {}): Promise<Connection> {
  const client = new Client({ name: 'toolmenu', version: '0.7.0' }, { versionNegotiation: { mode: 'auto' } });
  let transport: Transport;
  let stderrText = '';

  if (target.kind === 'stdio') {
    const stdio = new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: { ...getDefaultEnvironment(), ...target.env },
      cwd: target.cwd,
      stderr: 'pipe',
    });
    stdio.stderr?.on('data', (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString()).slice(-4000);
    });
    transport = stdio;
  } else {
    transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: { headers: target.headers ?? {} },
    });
  }

  try {
    await client.connect(transport, { timeout: options.timeoutMs });
  } catch (error) {
    // Give stderr a moment to arrive: it usually says why the server exited.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stderr = stderrText.trim();
    if (stderr && error instanceof Error) error.message += `\nserver stderr:\n${stderr}`;
    await client.close().catch(() => {});
    throw error;
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
      Object.keys(target.headers ?? {}).some((h) => /^(authorization|x-api-key|api-key|cookie)$/i.test(h)),
    stderr: () => stderrText,
    close: () => client.close(),
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
  try {
    await connection.client.listTools(undefined, { cacheMode: 'bypass', timeout: options.timeoutMs });
  } catch (error) {
    clientError = error instanceof Error ? error.message : String(error);
  }
  const responses = connection.wire.since(mark, 'tools/list');
  const pages = responses.flatMap((r) => (r.result ? [r.result] : []));
  if (clientError && pages.length === 0) throw new Error(clientError);
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
