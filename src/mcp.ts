/*
 * `toolmenu mcp`: toolmenu as an MCP server (stdio), so an agent building an MCP
 * server can check its menu while it works. Each tool runs the CLI in a child process
 * (no shell) and returns its report: the same checks, options, config and exit codes
 * as on the command line, and a crash or hang in one check can't take the server down.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { CLIENT_NAMES } from './clients.js';
import { VERSION } from './version.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the toolmenu CLI with these arguments, from this folder. */
export function runCli(args: string[], cwd: string): Promise<CliRun> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      // NO_COLOR: the report goes to an agent, not a terminal.
      { cwd, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 2) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === 2 ? error.message : '') });
      },
    );
  });
}

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** A CLI run as a tool result. Findings are a report, not a failure: only exit 2 (couldn't run) is an error. */
export function toResult(run: CliRun, failOnNote = true): Text {
  const out = run.stdout.trim();
  if (run.code === 2) {
    const why = run.stderr.trim() || out || 'toolmenu exited with code 2.';
    return { content: [{ type: 'text', text: why }], isError: true };
  }
  const notes = run.stderr.trim();
  const tail = run.code === 1 && failOnNote ? '\n\nExit 1: findings at or above --fail-on (error by default).' : '';
  return { content: [{ type: 'text', text: `${out || 'No output.'}${tail}${notes ? `\n\nNotes:\n${notes}` : ''}` }] };
}

const serverShape = {
  command: z
    .array(z.string())
    .min(1)
    .optional()
    .describe('The command that starts a stdio server, one word per item: ["node", "dist/server.js"]. Give this or url.'),
  url: z.string().optional().describe('A Streamable HTTP endpoint: https://example.com/mcp. Give this or command.'),
  headers: z.record(z.string(), z.string()).optional().describe('HTTP headers for a url server: {"Authorization": "Bearer ..."}.'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables for a command server. It gets a minimal environment plus these.'),
  cwd: z.string().optional().describe('Folder to run from: where the server starts, toolmenu.config.json is read and relative paths resolve. Default: where toolmenu mcp runs.'),
};

type ServerArgs = { command?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string>; cwd?: string };

/** The CLI arguments that name the server, or why they can't. Server options come before "--". */
export function serverArgs(a: ServerArgs): { before: string[]; after: string[] } | { error: string } {
  if (!a.command === !a.url) return { error: 'Give the server as command (a stdio server, e.g. ["node", "dist/server.js"]) or url (an HTTP server), one of the two.' };
  if (a.url) {
    if (a.env && Object.keys(a.env).length) return { error: 'env goes with command: an HTTP server is already running. Use headers for credentials.' };
    return { before: [a.url, ...Object.entries(a.headers ?? {}).flatMap(([k, v]) => ['--header', `${k}: ${v}`])], after: [] };
  }
  if (a.headers && Object.keys(a.headers).length) return { error: 'headers go with url. Pass a stdio server its credentials with env.' };
  return { before: Object.entries(a.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]), after: ['--', ...a.command!] };
}

const failed = (text: string): Text => ({ content: [{ type: 'text', text }], isError: true });

export function build(baseCwd = process.cwd()): McpServer {
  const server = new McpServer(
    { name: 'toolmenu', version: VERSION },
    {
      capabilities: { tools: {} },
      // The same four tools for everyone, always: an hour, and shared caches may keep it.
      cacheHints: { 'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' }, 'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' } },
      instructions:
        "toolmenu checks an MCP server's tool list (its menu) the way clients and agents meet it. " +
        'After changing a server\'s tools: snapshot_menu for findings and token cost, diff_menus against the committed menu.json for breaking changes, check_session to see whether the menu changes mid-session. ' +
        'Each finding ends with a → Next: step; explain_rule says what a rule checks.',
    },
  );
  const where = (cwd?: string) => (cwd ? resolve(baseCwd, cwd) : baseCwd);

  server.registerTool(
    'snapshot_menu',
    {
      description:
        "Check an MCP server's tool list: start or connect to it, list its tools, and report findings (what agents misread, what breaks clients or prompt caches) and the token cost. " +
        'Writes the menu file only when save_as is given (the baseline for diff_menus).',
      inputSchema: {
        ...serverShape,
        save_as: z.string().optional().describe('Write the menu here (menu.json for a baseline), relative to cwd. Default: not written.'),
        client: z.enum(CLIENT_NAMES as [string, ...string[]]).optional().describe('Also check the menu as this client loads it: what it cuts, finds and refuses.'),
        catalog: z.boolean().optional().describe('Also read the operations behind a search tool or command routers.'),
      },
      annotations: { title: 'Snapshot a server menu', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      const s = serverArgs(a);
      if ('error' in s) return failed(s.error);
      const args = ['snapshot', ...s.before, ...(a.save_as ? ['--out', a.save_as] : ['--no-write'])];
      if (a.client) args.push('--client', a.client);
      if (a.catalog) args.push('--catalog');
      return toResult(await runCli([...args, ...s.after], where(a.cwd)));
    },
  );

  server.registerTool(
    'diff_menus',
    {
      description:
        'Compare two menu files (from snapshot_menu save_as, or toolmenu snapshot): breaking changes for clients, the token change per conversation, and the version bump it needs. Reads files only.',
      inputSchema: {
        before: z.string().describe('The older menu file, e.g. the committed menu.json.'),
        after: z.string().describe('The newer menu file.'),
        release: z.string().optional().describe('The release versions to check the bump against: "1.4.0..1.5.0".'),
        cwd: serverShape.cwd,
      },
      annotations: { title: 'Diff two menus', readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const args = ['diff', a.before, a.after];
      if (a.release) args.push('--release', a.release);
      return toResult(await runCli(args, where(a.cwd)));
    },
  );

  server.registerTool(
    'check_session',
    {
      description:
        "Check whether an MCP server's menu changes while an agent works: call its tools marked readOnlyHint whose arguments the schema can fill, list the menu after each call, and report each change with the call that caused it. " +
        'Calls only read-only tools; never one marked openWorldHint unless open_world is set.',
      inputSchema: {
        ...serverShape,
        max_calls: z.number().int().min(1).optional().describe('At most this many calls (default 20).'),
        open_world: z.boolean().optional().describe('Also call read-only tools marked openWorldHint (web search, fetch): they may cost API credits.'),
      },
      annotations: { title: 'Run a session against a server', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      const s = serverArgs(a);
      if ('error' in s) return failed(s.error);
      const args = ['session', '--auto', ...s.before];
      if (a.max_calls) args.push('--max-calls', String(a.max_calls));
      if (a.open_world) args.push('--open-world');
      return toResult(await runCli([...args, ...s.after], where(a.cwd)));
    },
  );

  server.registerTool(
    'explain_rule',
    {
      description: "Explain a toolmenu rule by the name a finding gives (naming/vague-id): what it checks, its default level and how to change it. Without rule, lists every rule.",
      inputSchema: { rule: z.string().optional().describe('The rule, as a finding names it: naming/vague-id, or just vague-id.') },
      annotations: { title: 'Explain a rule', readOnlyHint: true, openWorldHint: false },
    },
    async (a) => toResult(await runCli(['explain', ...(a.rule ? [a.rule] : [])], baseCwd), false),
  );

  return server;
}

/** Serve over stdio until the client closes stdin. */
export async function serveMcp(): Promise<void> {
  const handle = serveStdio(() => build());
  await new Promise<void>((done) => {
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
  await handle.close().catch(() => {});
}
