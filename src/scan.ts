/*
 * `toolmenu scan <list>`: snapshot many servers in one run, a few at a time, and
 * report them side by side. The list is an MCP client config (Claude Desktop,
 * Claude Code's .mcp.json, Cursor, VS Code: `mcpServers` or `servers`) or a text
 * file with one server per line. A server that couldn't be read is a row that
 * says why, never a pass.
 */
import { readFile } from 'node:fs/promises';
import type { Target } from './connect.js';
import { ConnectError, clean, commandLine } from './explain.js';
import { counts, findingLines, githubLines, mdFindings, type Format } from './report.js';
import { mdCode, mdText, plain } from './sanitize.js';
import { snapshot, type SnapshotOptions } from './snapshot.js';
import { SEVERITY_RANK, type Finding, type Menu, type Severity } from './types.js';

export interface ScanEntry {
  name: string;
  /** Undefined when the entry can't be run: `problem` says why. */
  target?: Target;
  /** Why it can't be run: not checked, so the scan isn't a pass. */
  problem?: string;
  /** Turned off in the config: listed, not checked, and not a failure. */
  disabled?: true;
  /** The target as the config writes it, ${VAR} unfilled: what's printed, so a key passed in args stays out. */
  shown?: Target;
}

export class ListError extends Error {}

/**
 * Which environment variables a config's ${VAR} may be filled from: the names given
 * with --allow-env, or all of them ('*'). None by default: the config file picks
 * where each value goes (a URL, a header, a server's arguments), so a config from
 * someone else could send any of your environment to a server of theirs.
 */
export type AllowEnv = ReadonlySet<string> | '*';

/** `${VAR}`, `${VAR:-default}` (Claude Code) and `${env:VAR}` (VS Code), from the environment, where allowed. */
function expand(value: string, env: NodeJS.ProcessEnv, missing: Set<string>, allow: AllowEnv, blocked: Set<string>): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    const allowed = allow === '*' || allow.has(name);
    // Not allowed: the environment isn't read at all. With a default, the default, set
    // or not, so a server can't learn which variables exist from which URL it gets.
    if (!allowed && fallback !== undefined) return fallback;
    const v = env[name];
    if (v !== undefined && v !== '') {
      if (allowed) return v;
      blocked.add(name);
      return '';
    }
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return '';
  });
}

function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function record(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
}

/** One server from a client config: `{ command, args, env, cwd }` or `{ url, headers }`. */
function fromConfig(name: string, raw: unknown, env: NodeJS.ProcessEnv, allow: AllowEnv): ScanEntry {
  if (!raw || typeof raw !== 'object') return { name, problem: 'not an object' };
  const s = raw as Record<string, unknown>;
  if (s.disabled === true || s.enabled === false) return { name, disabled: true };
  const missing = new Set<string>();
  const blocked = new Set<string>();
  const x = (v: string) => expand(v, env, missing, allow, blocked);
  const map = (r: Record<string, string> | undefined) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, x(v)])) : undefined);
  const type = typeof s.type === 'string' ? s.type : typeof s.transport === 'string' ? s.transport : undefined;
  let target: Target;
  if (typeof s.url === 'string' || typeof s.serverUrl === 'string' || typeof s.httpUrl === 'string') {
    if (type === 'sse') return { name, problem: 'HTTP+SSE transport, which toolmenu doesn\'t speak (Streamable HTTP only)' };
    const raw = [s.url, s.serverUrl, s.httpUrl].find((u): u is string => typeof u === 'string')!;
    const url = x(raw);
    const headers = map(record(s.headers));
    target = { kind: 'http', url, ...(headers && Object.keys(headers).length ? { headers } : {}) };
  } else if (typeof s.command === 'string') {
    if (s.args !== undefined && !strings(s.args)) return { name, problem: 'args is not a list of strings' };
    const envs = map(record(s.env));
    target = {
      kind: 'stdio',
      command: x(s.command),
      args: ((s.args as string[] | undefined) ?? []).map(x),
      ...(envs && Object.keys(envs).length ? { env: envs } : {}),
      ...(typeof s.cwd === 'string' ? { cwd: x(s.cwd) } : {}),
    };
  } else return { name, problem: 'neither a command nor a url' };
  // Set but not allowed: not checked, rather than checked with the value left out.
  if (blocked.size) {
    const list = [...blocked].sort();
    return { name, problem: `${list.join(', ')} ${list.length === 1 ? 'is' : 'are'} set, but not passed in: scan fills \${VAR} only from the variables named with --allow-env (--allow-env ${list.join(',')}), so a config can't send the rest of your environment anywhere` };
  }
  // A missing variable would send an empty credential: say so instead of checking a server set up wrong.
  if (missing.size) return { name, problem: `${[...missing].join(', ')} ${missing.size === 1 ? 'is' : 'are'} not set (the config refers to ${missing.size === 1 ? 'it' : 'them'})` };
  // The URL as the config writes it: a filled-in ${VAR} may be a secret.
  if (target.kind === 'http' && !/^https?:\/\//.test(target.url)) return { name, problem: `"${clean([s.url, s.serverUrl, s.httpUrl].find((u): u is string => typeof u === 'string')!, 60)}" isn't an http(s) URL` };
  const shown: Target =
    target.kind === 'http'
      ? { kind: 'http', url: [s.url, s.serverUrl, s.httpUrl].find((u): u is string => typeof u === 'string')! }
      : { kind: 'stdio', command: s.command as string, args: (s.args as string[] | undefined) ?? [] };
  return { name, target, shown };
}

/** Words of a command line: whitespace-separated, with '…' and "…" kept together. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new ListError(`an unclosed ${quote} in: ${clean(line, 80)}`);
  if (started) out.push(word);
  return out;
}

/** The name a line gets when it gives none: the URL's host, or the package or command. */
function defaultName(target: Target): string {
  if (target.kind === 'http') return new URL(target.url).host;
  const pkg = target.args.find((a) => !a.startsWith('-') && /^(?:@[\w.-]+\/)?[\w.-]+(?:[@=]=?[\w.^~<>=*-]+)?$/.test(a) && !/^(?:-y|--yes|run|exec|x)$/.test(a));
  const launcher = /(?:^|\/)(?:npx|bunx|pnpx|uvx|pipx|dlx)$/.test(target.command) || /(?:^|\/)(?:pnpm|yarn|bun|npm)$/.test(target.command);
  if (launcher && pkg) return pkg;
  // node server.js, python -m x, deno run main.ts: the script, not the interpreter.
  const script = target.args.find((a) => !a.startsWith('-') && /\.(?:[cm]?[jt]s|py)$/.test(a));
  if (script) return script.split('/').pop()!.replace(/\.[^.]+$/, '');
  return target.command.split('/').pop() || target.command;
}

/**
 * A text list: one server per line, a URL or the command that starts it, optionally
 * named first ("github<TAB>npx -y @x/github-mcp", or "github = https://…").
 * Blank lines and # comments are skipped.
 */
function fromLines(text: string): ScanEntry[] {
  const entries: ScanEntry[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/^\s*#.*$/, '').trim();
    if (!line) continue;
    let name: string | undefined;
    let rest = line;
    const named = /^([\w.@/-]+)(?:\t+|\s+=\s+)(.+)$/.exec(line);
    if (named) [, name, rest] = named;
    let target: Target;
    if (/^https?:\/\//.test(rest)) {
      if (/\s/.test(rest.trim())) throw new ListError(`line ${i + 1}: a URL and something after it; one server per line`);
      target = { kind: 'http', url: rest.trim() };
      if (!URL.canParse(target.url)) {
        entries.push({ name: name ?? `line ${i + 1}`, problem: `"${clean(target.url, 60)}" isn't a valid URL` });
        continue;
      }
    } else {
      const words = splitCommand(rest);
      target = { kind: 'stdio', command: words[0], args: words.slice(1) };
    }
    entries.push({ name: name ?? defaultName(target), target });
  }
  return entries;
}

/** The servers in a list file, unique names (a repeat gets #2, #3). */
export function parseList(text: string, file: string, env: NodeJS.ProcessEnv = process.env, allow: AllowEnv = new Set()): ScanEntry[] {
  let entries: ScanEntry[];
  if (/\.jsonc?$/i.test(file) || /^\s*\{/.test(text)) {
    let json: unknown;
    try {
      // .jsonc and VS Code's settings allow comments; strip whole-line ones.
      json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    } catch (error) {
      throw new ListError(`${file} isn't valid JSON: ${(error as Error).message}`);
    }
    const j = json as Record<string, unknown>;
    const servers = j.mcpServers ?? j.servers ?? (j.mcp as Record<string, unknown> | undefined)?.servers ?? j['mcp.servers'];
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new ListError(`${file} has no mcpServers or servers object, the key MCP clients keep their servers under`);
    entries = Object.entries(servers as Record<string, unknown>).map(([name, raw]) => fromConfig(name, raw, env, allow));
  } else entries = fromLines(text);
  if (!entries.length) throw new ListError(`${file} lists no servers`);
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const n = (seen.get(e.name) ?? 0) + 1;
    seen.set(e.name, n);
    return n === 1 ? e : { ...e, name: `${e.name}#${n}` };
  });
}

export async function loadList(file: string, allow: AllowEnv = new Set()): Promise<ScanEntry[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ListError(`couldn't read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  return parseList(text, file, process.env, allow);
}

export interface ScanRow {
  name: string;
  /** Where the server is, printable: a URL without its query, or the command line. Never headers or env values. */
  where: string;
  menu?: Menu;
  findings: Finding[];
  /** Why the server wasn't checked: it couldn't be started or read, or its entry can't be run. */
  failed?: string;
  /** Turned off in the config. */
  disabled?: true;
  /** An HTTP server that answered 401 or 403. */
  wantsCredentials?: true;
}

/** Printable location. A URL's query and credentials can hold keys, so they're left out. */
export function where(target: Target | undefined): string {
  if (!target) return '';
  if (target.kind === 'stdio') return commandLine(target.command, target.args);
  try {
    const u = new URL(target.url);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return clean(target.url, 80);
  }
}

/** A one-line reason a server wasn't read: a ConnectError's headline, else the first line of the error. */
function reason(error: unknown, target: Target, shown: Target): string {
  const text = error instanceof ConnectError ? error.headline : clean((error instanceof Error ? error.message : String(error)).split('\n')[0], 200);
  // The URL can carry a key a ${VAR} filled in: print it as where() does.
  return target.kind === 'http' ? text.split(target.url).join(where(shown)) : text;
}

export interface ScanOptions extends SnapshotOptions {
  /** Servers checked at a time (default 4). */
  concurrency?: number;
  /** Called as each server finishes, for progress on stderr. */
  onDone?: (row: ScanRow, done: number, total: number) => void;
}

export async function scan(entries: ScanEntry[], options: ScanOptions = {}): Promise<ScanRow[]> {
  const rows: ScanRow[] = new Array(entries.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      let row: ScanRow;
      if (e.disabled) row = { name: e.name, where: '', findings: [], disabled: true };
      else if (!e.target) row = { name: e.name, where: '', findings: [], failed: e.problem };
      else {
        try {
          const { menu, findings } = await snapshot(e.target, options);
          row = { name: e.name, where: where(e.shown ?? e.target), menu, findings };
        } catch (error) {
          const status = error instanceof ConnectError ? error.status : undefined;
          row = { name: e.name, where: where(e.shown ?? e.target), findings: [], failed: reason(error, e.target, e.shown ?? e.target), ...(status === 401 || status === 403 ? { wantsCredentials: true as const } : {}) };
        }
      }
      rows[i] = row;
      options.onDone?.(row, ++done, entries.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, entries.length) }, worker));
  return rows;
}

/** 0 every server read and nothing at --fail-on; 1 findings at --fail-on; 2 a server wasn't read. */
export function scanExit(rows: ScanRow[], failOn: Severity): number {
  if (rows.some((r) => r.failed)) return 2;
  return rows.some((r) => r.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn])) ? 1 : 0;
}

function tokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function countText(findings: Finding[]): string {
  const c = counts(findings);
  const parts = [c.error ? `${c.error} error` : '', c.warn ? `${c.warn} warn` : '', c.info ? `${c.info} info` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no findings';
}

function status(r: ScanRow): string {
  if (r.disabled) return 'disabled in the config';
  if (r.failed) return `not checked: ${r.failed}`;
  return countText(r.findings);
}

function totals(rows: ScanRow[]): string {
  const read = rows.filter((r) => r.menu);
  const off = rows.filter((r) => r.disabled).length;
  const notRead = rows.length - read.length - off;
  const all = read.flatMap((r) => r.findings);
  const c = counts(all);
  return `${read.length} of ${rows.length} server${rows.length === 1 ? '' : 's'} checked${notRead ? `, ${notRead} not` : ''}${off ? `, ${off} disabled` : ''} · ${c.error} error · ${c.warn} warn · ${c.info} info`;
}

export function formatScan(rows: ScanRow[], format: Format, file: string): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        command: 'scan',
        list: file,
        servers: rows.map((r) => ({
          name: r.name,
          where: r.where,
          checked: !!r.menu,
          ...(r.menu ? { server: r.menu.server, tools: r.menu.tools.length, totalTokens: r.menu.totalTokens, counts: counts(r.findings) } : {}),
          ...(r.failed ? { failed: r.failed } : {}),
          ...(r.disabled ? { disabled: true } : {}),
          findings: r.findings,
        })),
      },
      null,
      2,
    );
  }
  if (format === 'github') {
    const lines: string[] = [];
    for (const r of rows) {
      // The title ends at the first comma or "::": the name goes in the message.
      if (r.failed) lines.push(`::error title=toolmenu scan::${plain(`${r.name}: ${status(r)}`).replace(/%/g, '%25')}`);
      lines.push(...githubLines(r.findings.map((f) => ({ ...f, message: `${r.name}: ${f.message}` }))));
    }
    return lines.join('\n');
  }
  if (format === 'markdown') {
    const cell = (t: string) => mdText(t, { cell: true });
    const lines = [`### toolmenu scan: ${mdText(file)}`, '', '| Server | Tools | Tokens | Findings |', '|---|--:|--:|---|'];
    for (const r of rows) lines.push(`| ${mdCode(r.name, { cell: true })} | ${r.menu ? r.menu.tools.length : '–'} | ${r.menu ? `~${tokens(r.menu.totalTokens)}` : '–'} | ${cell(status(r))} |`);
    lines.push('', totals(rows));
    for (const r of rows.filter((x) => x.findings.length)) lines.push('', `#### ${mdCode(r.name)}`, '', ...mdFindings(r.findings));
    return lines.join('\n');
  }
  const nameWidth = Math.min(32, Math.max(6, ...rows.map((r) => plain(r.name).length)));
  const lines = [`toolmenu scan  ${plain(file)}`, ''];
  lines.push(`  ${'server'.padEnd(nameWidth)}  ${'tools'.padStart(5)}  ${'tokens'.padStart(6)}  findings`);
  for (const r of rows) {
    const shown = plain(r.name);
    const name = shown.length > nameWidth ? `${shown.slice(0, nameWidth - 1)}…` : shown;
    lines.push(`  ${name.padEnd(nameWidth)}  ${(r.menu ? String(r.menu.tools.length) : '–').padStart(5)}  ${(r.menu ? `~${tokens(r.menu.totalTokens)}` : '–').padStart(6)}  ${plain(status(r))}`);
  }
  lines.push('', totals(rows));
  for (const r of rows.filter((x) => x.findings.length)) {
    const s = r.menu!.server;
    lines.push('', `── ${plain(r.name)}  ${plain(s.name ?? '')} ${plain(s.version ?? '')} · protocol ${plain(s.protocolVersion ?? 'unknown')}`.trimEnd(), '');
    lines.push(...findingLines(r.findings).filter((l, i, all) => !(i === all.length - 1 && l === '')));
  }
  if (rows.some((r) => r.wantsCredentials)) lines.push('', 'A server that wants credentials: toolmenu auth login <url> once (OAuth), or its headers in the config.');
  if (rows.some((r) => r.failed && !r.wantsCredentials)) lines.push('', 'toolmenu snapshot on one server says more about why it couldn\'t be read.');
  return lines.join('\n');
}
