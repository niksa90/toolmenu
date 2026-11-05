/*
 * `toolmenu mcp`: toolmenu as an MCP server (stdio), so an agent building an MCP
 * server can check its menu while it works. Each tool runs the CLI in a child process
 * (no shell) and returns its report: the same checks, options, config and exit codes
 * as on the command line, and a crash or hang in one check can't take the server down.
 *
 * Each child runs in its own process group, so cancelling a call, its time running
 * out, or the client closing the connection stops the child and the server it started.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { CLIENT_NAMES } from './clients.js';
import { VERSION } from './version.js';
import { SECRET_ARGS_ENV } from './mcp-env.js';

export { SECRET_ARGS_ENV };

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

/** A whole run's ceiling. Each request inside it already has the CLI's own --timeout. */
export const RUN_LIMIT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64 * 1024 * 1024;

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Why the run was stopped, when toolmenu mcp stopped it. */
  stopped?: string;
}

const WINDOWS = process.platform === 'win32';

/**
 * Runs still going, by the CLI's pid. On Linux and macOS each run is a process group
 * (the CLI and the server it started), kept until nothing in it is alive, not until
 * the CLI exits: a server that ignores SIGTERM outlives the CLI that started it.
 * Windows has no process groups to signal: there a run is the CLI's process tree,
 * which taskkill /T ends while the CLI is still its root.
 */
const runs = new Map<number, ChildProcess>();

/** Whether anything in the run is still alive. */
function runAlive(pid: number): boolean {
  if (WINDOWS) {
    const child = runs.get(pid);
    return !!child && child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal the whole run. On Windows, any stop is taskkill /T /F: there's no polite one for a console process. */
function signalRun(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Stop a run: SIGTERM, then SIGKILL to whatever in it is still there 2 s later. */
async function stopRun(pid: number): Promise<void> {
  if (runAlive(pid)) {
    signalRun(pid, 'SIGTERM');
    const end = Date.now() + 2_000;
    while (runAlive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    if (runAlive(pid)) signalRun(pid, 'SIGKILL');
  }
  runs.delete(pid);
}

/** Kill every run still going, at once: toolmenu mcp itself is exiting. */
export function killAllNow(): void {
  for (const pid of runs.keys()) signalRun(pid, 'SIGKILL');
}

/** Stop every run still going, and wait for it: the client closed the connection. */
export async function stopAll(): Promise<void> {
  await Promise.all([...runs.keys()].map(stopRun));
}

export interface RunOptions {
  /** Arguments that carry credentials, passed through the environment (SECRET_ARGS_ENV). */
  secretArgs?: string[];
  signal?: AbortSignal;
  limitMs?: number;
}

/** Run the toolmenu CLI with these arguments, from this folder. */
export function runCli(args: string[], cwd: string, options: RunOptions = {}): Promise<CliRun> {
  const { secretArgs = [], signal, limitMs = RUN_LIMIT_MS } = options;
  return new Promise((done) => {
    if (signal?.aborted) return done({ code: 2, stdout: '', stderr: '', stopped: 'The call was cancelled before it started.' });
    // NO_COLOR: the report goes to an agent, not a terminal. NODE_NO_WARNINGS: Node's
    // own notices (experimental features) aren't findings, and would read as if they
    // were. Neither reaches the server under test: it gets a minimal environment.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' };
    delete env[SECRET_ARGS_ENV];
    if (secretArgs.length) env[SECRET_ARGS_ENV] = JSON.stringify(secretArgs);
    // detached: its own process group (Linux, macOS). On Windows it would open a console
    // window for every run instead, so there the run stays attached and hidden.
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, detached: !WINDOWS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) runs.set(child.pid, child);
    let stdout = '';
    let stderr = '';
    let stopped: string | undefined;
    const halt = (why: string) => {
      stopped ??= why;
      if (child.pid) void stopRun(child.pid);
    };
    child.stdout!.on('data', (d) => {
      stdout += d;
      if (stdout.length > OUTPUT_LIMIT) halt(`The report passed ${OUTPUT_LIMIT / 1024 / 1024} MB, so the run was stopped.`);
    });
    child.stderr!.on('data', (d) => {
      stderr += d;
      if (stderr.length > OUTPUT_LIMIT) stderr = stderr.slice(-OUTPUT_LIMIT);
    });
    const timer = setTimeout(() => halt(`The run took longer than ${limitMs / 60_000} minutes, so it was stopped. A server that is slow to answer each request can be given a longer --timeout in toolmenu.config.json, or fewer calls (max_calls).`), limitMs);
    const onAbort = () => halt('The call was cancelled, so the run was stopped.');
    signal?.addEventListener('abort', onAbort, { once: true });
    let finished = false;
    // A child that fails to start can emit both error and close: answer once.
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Whatever the CLI left behind (a server it couldn't stop) goes with it.
      if (child.pid) void stopRun(child.pid);
      done({ code, stdout, stderr, ...(stopped ? { stopped } : {}) });
    };
    // Never Node's own error message: it repeats the command line.
    child.on('error', (error: NodeJS.ErrnoException) => {
      stderr += `toolmenu mcp couldn't start the toolmenu CLI (${error.code ?? 'error'}).`;
      finish(2);
    });
    child.on('close', (code) => finish(stopped ? 2 : code ?? 2));
  });
}

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** A CLI run as a tool result. Findings are a report, not a failure: only exit 2 (couldn't run) is an error. */
export function toResult(run: CliRun): Text {
  const out = run.stdout.trim();
  if (run.code === 2) {
    const why = [run.stopped, run.stderr.trim()].filter(Boolean).join('\n\n') || out || 'toolmenu exited with code 2.';
    return { content: [{ type: 'text', text: why }], isError: true };
  }
  const notes = run.stderr.trim();
  const tail = run.code === 1 ? '\n\nExit 1: there are error-level findings.' : '';
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

export interface ServerSpec {
  /** Before "--": the URL, if any. */
  before: string[];
  /** Header and env values, passed through the environment. */
  secret: string[];
  /** "--" and the command, if any. */
  after: string[];
}

/** The CLI arguments that name the server, or why they can't. */
export function serverArgs(a: ServerArgs): ServerSpec | { error: string } {
  if (!a.command === !a.url) return { error: 'Give the server as command (a stdio server, e.g. ["node", "dist/server.js"]) or url (an HTTP server), one of the two.' };
  if (a.url) {
    if (a.env && Object.keys(a.env).length) return { error: 'env goes with command: an HTTP server is already running. Use headers for credentials.' };
    if (!/^https?:\/\//.test(a.url)) return { error: `url must be an http(s) URL; got "${a.url}". For a stdio server, give command.` };
    return { before: [a.url], secret: Object.entries(a.headers ?? {}).flatMap(([k, v]) => ['--header', `${k}: ${v}`]), after: [] };
  }
  if (a.headers && Object.keys(a.headers).length) return { error: 'headers go with url. Pass a stdio server its credentials with env.' };
  return { before: [], secret: Object.entries(a.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]), after: ['--', ...a.command!] };
}

/** The folder a call runs in, or why it can't. */
export function folder(baseCwd: string, cwd?: string): { dir: string } | { error: string } {
  const dir = cwd ? resolve(baseCwd, cwd) : baseCwd;
  try {
    if (statSync(dir).isDirectory()) return { dir };
    return { error: `cwd "${cwd ?? dir}" is a file, not a folder.` };
  } catch {
    return { error: `cwd "${cwd ?? dir}" doesn't exist (resolved to ${dir}). Give the server's project folder.` };
  }
}

/** A path as an absolute one, so a value starting with "-" can't be read as an option. */
const absolute = (dir: string, path: string) => (isAbsolute(path) ? path : resolve(dir, path));

const failed = (text: string): Text => ({ content: [{ type: 'text', text }], isError: true });

type Ctx = { mcpReq: { signal: AbortSignal } };

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

  /** Run a command for a server: the folder checked, credentials kept out of argv. */
  const forServer = async (a: ServerArgs, ctx: Ctx, args: (dir: string, s: ServerSpec) => string[]) => {
    const s = serverArgs(a);
    if ('error' in s) return failed(s.error);
    const f = folder(baseCwd, a.cwd);
    if ('error' in f) return failed(f.error);
    return toResult(await runCli([...args(f.dir, s), ...s.after], f.dir, { secretArgs: s.secret, signal: ctx.mcpReq.signal }));
  };

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
    (a, ctx) =>
      forServer(a, ctx, (dir, s) => [
        'snapshot',
        ...s.before,
        a.save_as ? `--out=${absolute(dir, a.save_as)}` : '--no-write',
        ...(a.client ? [`--client=${a.client}`] : []),
        ...(a.catalog ? ['--catalog'] : []),
      ]),
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
    async (a, ctx) => {
      const f = folder(baseCwd, a.cwd);
      if ('error' in f) return failed(f.error);
      const args = ['diff', absolute(f.dir, a.before), absolute(f.dir, a.after), ...(a.release ? [`--release=${a.release}`] : [])];
      return toResult(await runCli(args, f.dir, { signal: ctx.mcpReq.signal }));
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
    (a, ctx) =>
      forServer(a, ctx, (_dir, s) => [
        'session',
        '--auto',
        ...s.before,
        ...(a.max_calls ? [`--max-calls=${a.max_calls}`] : []),
        ...(a.open_world ? ['--open-world'] : []),
      ]),
  );

  server.registerTool(
    'explain_rule',
    {
      description: "Explain a toolmenu rule by the name a finding gives (naming/vague-id): what it checks, its default level and how to change it. Without rule, lists every rule.",
      inputSchema: { rule: z.string().optional().describe('The rule, as a finding names it: naming/vague-id, or just vague-id.') },
      annotations: { title: 'Explain a rule', readOnlyHint: true, openWorldHint: false },
    },
    async (a, ctx) => {
      if (a.rule !== undefined && !/^[a-z0-9][a-z0-9/_-]*$/i.test(a.rule)) return failed(`"${a.rule}" isn't a rule name. Rules look like naming/vague-id; call explain_rule without rule to list them.`);
      return toResult(await runCli(['explain', ...(a.rule ? [a.rule] : [])], baseCwd, { signal: ctx.mcpReq.signal }));
    },
  );

  return server;
}

/**
 * Serve over stdio until the client closes stdin, then stop every run still going.
 * A client that closes stdin may send SIGTERM before the runs are stopped: on that, or
 * on any exit, what's left is killed at once rather than left running.
 */
export async function serveMcp(): Promise<void> {
  process.once('exit', killAllNow);
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
    process.once(signal, () => {
      killAllNow();
      process.exit(code);
    });
  }
  const handle = serveStdio(() => build());
  await new Promise<void>((done) => {
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
  await stopAll();
  await handle.close().catch(() => {});
}
