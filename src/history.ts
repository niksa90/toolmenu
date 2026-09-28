import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { diffMenus, type Bump } from './diff.js';
import { snapshot } from './snapshot.js';
import type { Finding, Menu, Severity } from './types.js';

const run = promisify(execFile);

export interface PublishedVersion {
  version: string;
  /** ISO publish time, when the registry says. */
  published?: string;
}

/** Where versions come from and how they get installed. Swappable for tests. */
export interface PackageSource {
  versions(pkg: string): Promise<PublishedVersion[]>;
  install(pkg: string, version: string, dir: string, options: { allowScripts: boolean; timeoutMs: number }): Promise<void>;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The npm registry, through the user's own npm (their config, proxy and registry). */
export const npmSource: PackageSource = {
  async versions(pkg) {
    const { stdout } = await run(npm, ['view', pkg, 'versions', 'time', '--json'], { maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
    const data = JSON.parse(stdout) as { versions?: string | string[]; time?: Record<string, string> };
    const versions = typeof data.versions === 'string' ? [data.versions] : data.versions ?? [];
    return versions.map((version) => ({ version, published: data.time?.[version] }));
  },
  async install(pkg, version, dir, { allowScripts, timeoutMs }) {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'toolmenu-history-install', private: true }));
    const args = ['install', `${pkg}@${version}`, '--no-audit', '--no-fund', '--loglevel=error'];
    if (!allowScripts) args.push('--ignore-scripts');
    await run(npm, args, { cwd: dir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  },
};

export type FailureReason = 'install-failed' | 'no-bin' | 'needs-env' | 'needs-args' | 'timeout' | 'crashed';

/** Dependencies worth recording: they decide the protocol and how schemas get built (FINDINGS F4). */
export const WATCHED_DEPENDENCIES = [
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/core',
  'zod',
  'zod-to-json-schema',
];

export interface HistoryRow {
  version: string;
  published?: string;
  status: 'ok' | 'failed';
  reason?: FailureReason;
  error?: string;
  /** What the package asks for (its package.json). */
  declared?: Record<string, string>;
  /** What npm actually installed today, every copy in the tree. */
  resolved?: Record<string, string[]>;
  protocolVersion?: string;
  /** What the server says about itself. Often not the npm version (FINDINGS F5). */
  serverInfo?: { name?: string; version?: string };
  tools?: number;
  tokens?: number;
  counts?: Record<Severity, number>;
  rules?: Record<string, number>;
  /** Compared with the previous version that worked. */
  diff?: {
    from: string;
    tokenDelta: number;
    breaking: number;
    minor: number;
    notice: number;
    suggestedBump: Bump;
    actualBump?: Bump;
    /** The release's version bump is smaller than its changes call for (diff/version-bump). */
    bumpTooSmall: boolean;
    breakingChanges: string[];
  };
  menuFile?: string;
}

export interface HistoryResult {
  package: string;
  installedAt: string;
  totalVersions: number;
  rows: HistoryRow[];
}

export interface HistoryOptions {
  /** How many of the most recent versions to inspect. Default 10; Infinity for all. */
  versions?: number;
  includePrereleases?: boolean;
  /** Extra arguments passed to the server's bin. */
  args?: string[];
  env?: Record<string, string>;
  /** Which bin to run when the package has several. */
  bin?: string;
  /** Command template instead of the bin: {bin} and {dir} are filled in. */
  cmd?: string;
  allowScripts?: boolean;
  installTimeoutMs?: number;
  timeoutMs?: number;
  /** Where menus and history.json go. */
  outDir: string;
  keepInstalls?: boolean;
  source?: PackageSource;
  onProgress?: (message: string) => void;
}

export async function history(pkg: string, options: HistoryOptions): Promise<HistoryResult> {
  const source = options.source ?? npmSource;
  const all = await source.versions(pkg);
  const candidates = all
    .filter((v) => options.includePrereleases || !v.version.includes('-'))
    .sort((a, b) => (a.published && b.published ? a.published.localeCompare(b.published) : 0));
  const count = options.versions ?? 10;
  const picked = Number.isFinite(count) ? candidates.slice(-count) : candidates;
  await mkdir(options.outDir, { recursive: true });

  const rows: HistoryRow[] = [];
  let previous: { row: HistoryRow; menu: Menu } | undefined;
  for (const [i, v] of picked.entries()) {
    options.onProgress?.(`[${i + 1}/${picked.length}] ${pkg}@${v.version}`);
    const { row, menu } = await inspectVersion(pkg, v, options, source);
    if (menu && previous) row.diff = compareRows(previous, { row, menu });
    if (menu) previous = { row, menu };
    rows.push(row);
  }

  const result: HistoryResult = { package: pkg, installedAt: new Date().toISOString(), totalVersions: all.length, rows };
  await writeFile(join(options.outDir, 'history.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function inspectVersion(
  pkg: string,
  v: PublishedVersion,
  options: HistoryOptions,
  source: PackageSource,
): Promise<{ row: HistoryRow; menu?: Menu }> {
  const row: HistoryRow = { version: v.version, ...(v.published ? { published: v.published } : {}), status: 'failed' };
  const dir = await mkdtemp(join(tmpdir(), 'toolmenu-history-'));
  try {
    try {
      await source.install(pkg, v.version, dir, { allowScripts: options.allowScripts ?? false, timeoutMs: options.installTimeoutMs ?? 180_000 });
    } catch (error) {
      return { row: fail(row, 'install-failed', error) };
    }

    const pkgDir = join(dir, 'node_modules', ...pkg.split('/'));
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
      dependencies?: Record<string, string>;
    };
    row.declared = pick(manifest.dependencies ?? {}, WATCHED_DEPENDENCIES);
    row.resolved = await resolvedDependencies(dir);

    const command = commandFor(pkg, pkgDir, dir, manifest.bin, options);
    if (!command) return { row: fail(row, 'no-bin', new Error('The package has no bin to start, and no --cmd was given.')) };

    let result;
    try {
      result = await snapshot(
        { kind: 'stdio', command: command[0], args: [...command.slice(1), ...(options.args ?? [])], env: options.env, cwd: dir },
        { timeoutMs: options.timeoutMs ?? 30_000 },
      );
    } catch (error) {
      return { row: fail(row, classifyFailure(error), error) };
    }

    const { menu, findings } = result;
    const menuFile = `${v.version}.json`;
    await writeFile(join(options.outDir, menuFile), JSON.stringify(menu, null, 2) + '\n');
    Object.assign(row, {
      status: 'ok',
      protocolVersion: menu.server.protocolVersion,
      serverInfo: { name: menu.server.name, version: menu.server.version },
      tools: menu.tools.length,
      tokens: menu.totalTokens,
      counts: countBySeverity(findings),
      rules: countByRule(findings),
      menuFile,
    });
    return { row, menu };
  } finally {
    if (!options.keepInstalls) await rm(dir, { recursive: true, force: true });
    else options.onProgress?.(`  kept install: ${dir}`);
  }
}

function commandFor(
  pkg: string,
  pkgDir: string,
  installDir: string,
  bin: string | Record<string, string> | undefined,
  options: HistoryOptions,
): string[] | undefined {
  let binPath: string | undefined;
  if (typeof bin === 'string') binPath = bin;
  else if (bin && Object.keys(bin).length) {
    const names = Object.keys(bin);
    const base = pkg.split('/').pop()!;
    const name = options.bin ?? (names.length === 1 ? names[0] : names.find((n) => n === base || n.endsWith(base)) ?? names[0]);
    binPath = bin[name];
  }
  const binFile = binPath ? join(pkgDir, binPath) : undefined;
  if (options.cmd) {
    return splitCommand(options.cmd.replaceAll('{bin}', binFile ?? '').replaceAll('{dir}', installDir));
  }
  if (!binFile || !existsSync(binFile)) return undefined;
  return [process.execPath, binFile];
}

function splitCommand(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^["']|["']$/g, ''));
}

const ENV_HINT = /api[_\s-]?key|access[_\s-]?token|\btoken\b|environment variable|env var|credential|must be set|is not set|not configured|missing required/i;
const ARGS_HINT = /usage:|at least one (directory|argument)|missing argument|expected .*argument|no (directory|path) (was )?(given|provided)/i;

export function classifyFailure(error: unknown): FailureReason {
  const text = error instanceof Error ? error.message : String(error);
  if (ARGS_HINT.test(text)) return 'needs-args';
  if (ENV_HINT.test(text)) return 'needs-env';
  if (/timed out|timeout/i.test(text)) return 'timeout';
  return 'crashed';
}

function fail(row: HistoryRow, reason: FailureReason, error: unknown): HistoryRow {
  return Object.assign(row, { status: 'failed' as const, reason, error: summarizeError(error) });
}

/** The lines that say what went wrong, not the stack trace. */
export function summarizeError(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error)).split('\n').map((l) => l.trim()).filter(Boolean);
  const telling = lines.filter((l) => !/^at\s|^node:|^Node\.js v|^[{}]$|^\^+$/.test(l));
  const causes = telling.filter((l) => /error|cannot|not found|missing|usage|required|denied|refused/i.test(l));
  return [...new Set([...(causes.length ? causes : telling).slice(0, 4), ...lines.filter((l) => /^code:/.test(l))])].join('\n').slice(0, 800);
}

/** Every installed copy of the watched dependencies, from the lockfile npm wrote. */
async function resolvedDependencies(dir: string): Promise<Record<string, string[]>> {
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) return {};
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { packages?: Record<string, { version?: string }> };
  const found: Record<string, Set<string>> = {};
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    for (const name of WATCHED_DEPENDENCIES) {
      if (info.version && path.endsWith(`node_modules/${name}`)) (found[name] ??= new Set()).add(info.version);
    }
  }
  return Object.fromEntries(Object.entries(found).map(([name, versions]) => [name, [...versions].sort()]));
}

function compareRows(before: { row: HistoryRow; menu: Menu }, after: { row: HistoryRow; menu: Menu }): HistoryRow['diff'] {
  // The release is the npm version: servers often report a version that never changes (F5).
  const d = diffMenus(before.menu, after.menu, { release: { before: before.row.version, after: after.row.version } });
  const count = (c: string) => d.findings.filter((f) => f.class === c).length;
  return {
    from: before.row.version,
    tokenDelta: d.tokens.delta,
    breaking: count('breaking'),
    minor: count('minor'),
    notice: count('notice'),
    suggestedBump: d.suggestedBump,
    ...(d.actualBump ? { actualBump: d.actualBump } : {}),
    bumpTooSmall: d.findings.some((f) => f.rule === 'diff/version-bump'),
    breakingChanges: d.findings.filter((f) => f.class === 'breaking').map((f) => f.message),
  };
}

function pick(deps: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter((n) => deps[n]).map((n) => [n, deps[n]]));
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c = { error: 0, warn: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function countByRule(findings: Finding[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const f of findings) c[f.rule] = (c[f.rule] ?? 0) + 1;
  return c;
}

const CSV_COLUMNS = [
  'version', 'published', 'status', 'reason', 'protocol', 'server_version', 'tools', 'tokens',
  'sdk', 'zod', 'errors', 'warnings', 'info', 'token_delta', 'breaking', 'minor', 'notice', 'suggested_bump',
] as const;

export function historyCsv(result: HistoryResult): string {
  const cell = (v: unknown) => {
    const s = v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of result.rows) {
    const sdk = r.resolved?.['@modelcontextprotocol/sdk'] ?? r.resolved?.['@modelcontextprotocol/server'];
    lines.push(
      [
        r.version, r.published?.slice(0, 10), r.status, r.reason, r.protocolVersion, r.serverInfo?.version, r.tools, r.tokens,
        sdk?.join(' '), r.resolved?.zod?.join(' '), r.counts?.error, r.counts?.warn, r.counts?.info,
        r.diff?.tokenDelta, r.diff?.breaking, r.diff?.minor, r.diff?.notice, r.diff?.suggestedBump,
      ].map(cell).join(','),
    );
  }
  return lines.join('\n') + '\n';
}
