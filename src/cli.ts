#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import type { Target } from './connect.js';
import { diffMenus } from './diff.js';
import { loadMenu } from './menu.js';
import { history, historyCsv } from './history.js';
import { formatDiff, formatHistory, formatPlan, formatSession, formatSnapshot, type Format } from './report.js';
import { loadScenario, session, starterScenario } from './session.js';
import { connect, listTools } from './connect.js';
import { buildMenu } from './menu.js';
import { existsSync } from 'node:fs';
import { loadRoutes } from './routes.js';
import { snapshot } from './snapshot.js';
import { SEVERITY_RANK, type Severity } from './types.js';

const VERSION = '0.7.0';

const HELP = `toolmenu ${VERSION}
Lint your MCP server's tool menu for changes that confuse agents or break caches.

Usage:
  toolmenu snapshot [options] -- <command> [args...]   stdio server
  toolmenu snapshot [options] <url>                    Streamable HTTP server
  toolmenu diff [options] <old.json> <new.json>        compare two snapshots
  toolmenu history [options] <npm-package>             snapshot and diff published versions
  toolmenu session --scenario <file> [options] -- <command> | <url>
                                                       run a scripted session, watch the menu

Commands:
  snapshot   establish the menu: list tools twice, write menu.json, run the menu rules
  diff       compare releases: breaking changes, token change, semver bump
  session    observe the menu changing while a scripted session runs
  history    research release history: install, snapshot and diff published npm versions

Options:
  --out <path>        where to write the menu (default: menu.json)
  --no-write          don't write the menu file
  --routes <path>     routes.yml: pin which words route to which tools
  --config <path>     config file (default: toolmenu.config.json, if present)
  --format <fmt>      text (default), json, github (annotations) or markdown (PR comments)
  --json              same as --format json
  --fail-on <level>   error (default), warn or info
  --header <k: v>     HTTP header, repeatable (e.g. "Authorization: Bearer ...")
  --env <K=V>         environment variable for a stdio server, repeatable. The server
                      only gets a minimal environment (PATH, HOME, ...) plus these
  --timeout <ms>      per-request timeout (default: 30000)
  -h, --help          show this help
  -v, --version       show the version

diff options:
  --release <old>..<new>        the release versions (npm, git tag) to check the bump
                                against, e.g. 1.4.0..1.5.0. Without it, the bump isn't
                                checked: serverInfo.version is often not the release
  --server-version-is-release   check the bump against serverInfo.version instead

session options:
  --scenario <path>     scenario.yml: the steps to run (list, call, wait_for)
  --plan                print the steps without connecting or running anything
  --init                write a starter scenario from the server's menu (to --scenario,
                        default scenario.yml; never overwrites)

history options (best effort; installs and runs third-party code, so use a container):
  --versions <n|all>    number of published versions to inspect (default: 10)
  --include-prereleases include versions like 1.2.0-beta.1
  --arg <value>         argument for the server's bin, repeatable (use --arg=--flag for flags)
  --bin <name>          which bin to run when the package has several
  --cmd <template>      command instead of the bin; {bin} and {dir} are filled in
  --allow-scripts       run install scripts (off by default)
  --install-timeout <ms> per-version install timeout (default: 180000)
  --csv <path>          also write the dataset as CSV
  --keep-installs       keep each version's install directory
  --out <dir>           where menus and history.json go (default: toolmenu-history/<package>)

Exit codes: 0 clean · 1 findings at or above --fail-on · 2 couldn't connect or bad usage
`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--');
  const before = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? undefined : argv.slice(dash + 1);

  const { values, positionals } = parseArgs({
    args: before,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'no-write': { type: 'boolean' },
      routes: { type: 'string' },
      config: { type: 'string' },
      format: { type: 'string' },
      json: { type: 'boolean' },
      'fail-on': { type: 'string' },
      header: { type: 'string', multiple: true },
      env: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      versions: { type: 'string' },
      release: { type: 'string' },
      'server-version-is-release': { type: 'boolean' },
      'include-prereleases': { type: 'boolean' },
      arg: { type: 'string', multiple: true },
      bin: { type: 'string' },
      cmd: { type: 'string' },
      'allow-scripts': { type: 'boolean' },
      'install-timeout': { type: 'string' },
      csv: { type: 'string' },
      'keep-installs': { type: 'boolean' },
      scenario: { type: 'string' },
      plan: { type: 'boolean' },
      init: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [sub, ...rest] = positionals;
  if (values.help || !sub) {
    process.stdout.write(HELP);
    return sub || values.help ? 0 : 2;
  }
  if (!['snapshot', 'diff', 'history', 'session'].includes(sub)) throw new UsageError(`Unknown command "${sub}". Try --help.`);

  const format = (values.json ? 'json' : values.format ?? 'text') as Format;
  if (!['text', 'json', 'github', 'markdown'].includes(format)) throw new UsageError(`--format must be text, json, github or markdown`);
  const failOn = (values['fail-on'] ?? 'error') as Severity;
  if (!(failOn in SEVERITY_RANK)) throw new UsageError(`--fail-on must be error, warn or info`);
  const timeoutMs = values.timeout ? Number(values.timeout) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError(`--timeout must be a positive number of milliseconds`);

  const config = await loadConfig(values.config);

  if (sub === 'diff') {
    if (command) throw new UsageError('diff compares two menu files; it doesn\'t start a server. Run snapshot first.');
    if (rest.length !== 2) throw new UsageError('diff needs two menu files: toolmenu diff <old.json> <new.json>');
    const [before, after] = await Promise.all(rest.map((path) => loadMenu(path)));
    const release = values.release ? parseRelease(values.release) : undefined;
    const result = diffMenus(before, after, {
      rules: config.rules,
      ignore: config.ignore,
      tokenBudget: config.tokenBudget,
      release,
      serverVersionIsRelease: values['server-version-is-release'] ?? config.serverVersionIsRelease,
    });
    process.stdout.write(formatDiff(result, before.tools.length, after.tools.length, format) + '\n');
    return result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
  }

  if (sub === 'history') {
    if (command) throw new UsageError('history takes an npm package name, not a command. Use --cmd for unusual entry points.');
    if (rest.length !== 1) throw new UsageError('history needs one npm package name: toolmenu history <package>');
    const versions = values.versions === 'all' ? Infinity : values.versions ? Number(values.versions) : 10;
    if (versions !== Infinity && (!Number.isInteger(versions) || versions < 1)) throw new UsageError('--versions must be a whole number of versions, 1 or more, or "all"');
    const installTimeoutMs = values['install-timeout'] ? Number(values['install-timeout']) : 180_000;
    if (!Number.isFinite(installTimeoutMs) || installTimeoutMs <= 0) throw new UsageError('--install-timeout must be a positive number of milliseconds');
    const pkg = rest[0];
    const outDir = values.out ?? join('toolmenu-history', pkg.replace(/^@/, '').replace(/\//g, '__'));
    process.stderr.write(`toolmenu history: installs and runs ${pkg} from npm, version by version. Run it in a container.\n`);
    const result = await history(pkg, {
      versions,
      includePrereleases: values['include-prereleases'],
      args: values.arg,
      env: parsePairs(values.env ?? [], '=', '--env'),
      bin: values.bin,
      cmd: values.cmd,
      allowScripts: values['allow-scripts'],
      installTimeoutMs,
      timeoutMs,
      outDir,
      keepInstalls: values['keep-installs'],
      onProgress: format === 'text' ? (m) => process.stderr.write(m + '\n') : undefined,
    });
    if (values.csv) await writeFile(values.csv, historyCsv(result));
    process.stdout.write(formatHistory(result, format, outDir) + '\n');
    return result.rows.length > 0 && result.rows.every((r) => r.status === 'failed') ? 1 : 0;
  }

  if (sub === 'session' && values.init) {
    const path = values.scenario ?? 'scenario.yml';
    if (existsSync(path)) throw new UsageError(`${path} already exists. Pick another path with --scenario.`);
    const initTarget = parseTarget(rest, command, values.header ?? [], values.env ?? []);
    const conn = await connect(initTarget, { timeoutMs });
    try {
      const list = await listTools(conn, { timeoutMs });
      const menu = buildMenu(list.tools, { name: conn.server.name, version: conn.server.version, protocolVersion: conn.protocolVersion });
      await writeFile(path, starterScenario(menu));
      process.stdout.write(`wrote ${path}: a starter scenario for ${menu.tools.length} tools. Fill in the TODOs, then run toolmenu session --scenario ${path}\n`);
    } finally {
      await conn.close().catch(() => {});
    }
    return 0;
  }

  if (sub === 'session') {
    if (!values.scenario) throw new UsageError('session needs --scenario <file>. See docs/SPEC.md §3.3 for the format.');
    let scenario;
    try {
      scenario = await loadScenario(values.scenario);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    if (values.plan) {
      process.stdout.write(formatPlan(scenario, values.scenario) + '\n');
      return 0;
    }
    const sessionTarget = parseTarget(rest, command, values.header ?? [], values.env ?? []);
    const result = await session(sessionTarget, scenario, { timeoutMs, rules: config.rules, ignore: config.ignore, scenarioName: values.scenario });
    const output = formatSession(result, format);
    if (output) process.stdout.write(output + '\n');
    return result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
  }

  const target = parseTarget(rest, command, values.header ?? [], values.env ?? []);
  const routesPath = values.routes ?? config.routes;
  const routes = routesPath ? await loadRoutes(routesPath) : undefined;

  const { menu, findings } = await snapshot(target, { routes, timeoutMs, rules: config.rules, ignore: config.ignore, descriptionLimit: config.descriptionLimit, fullDescriptions: config.fullDescriptions });

  const outPath = values['no-write'] ? undefined : values.out ?? 'menu.json';
  if (outPath) await writeFile(outPath, JSON.stringify(menu, null, 2) + '\n');

  const output = formatSnapshot(menu, findings, format, outPath);
  if (output) process.stdout.write(output + '\n');
  return findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
}

function parseTarget(positionals: string[], command: string[] | undefined, headers: string[], env: string[]): Target {
  if (command) {
    if (command.length === 0) throw new UsageError('Nothing after "--": give the command that starts the server.');
    if (positionals.length) throw new UsageError(`Unexpected "${positionals[0]}" before "--".`);
    return { kind: 'stdio', command: command[0], args: command.slice(1), env: parsePairs(env, '=', '--env') };
  }
  const [url, ...extra] = positionals;
  if (!url) throw new UsageError('Give a server URL, or "-- <command>" for a stdio server.');
  if (extra.length) throw new UsageError(`Unexpected "${extra[0]}". For a stdio server, put the command after "--".`);
  if (!/^https?:\/\//.test(url)) throw new UsageError(`"${url}" isn't an http(s) URL. For a stdio server, put the command after "--".`);
  return { kind: 'http', url, headers: parsePairs(headers, ':', '--header') };
}

function parsePairs(items: string[], separator: string, flag: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const item of items) {
    const i = item.indexOf(separator);
    if (i <= 0) throw new UsageError(`${flag} "${item}" should look like KEY${separator}VALUE`);
    pairs[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return pairs;
}

// Exit only once stdout and stderr have drained: on a pipe, writes can be
// asynchronous, and exiting early truncates a large --json report. (An explicit
// exit is still needed: a stdio server or HTTP socket can keep the loop alive.)
function exitWhenFlushed(code: number): void {
  process.exitCode = code;
  // A reader that closed the pipe early (| head) isn't an error: keep the exit code.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => process.exit(error.code === 'EPIPE' ? code : 2));
  }
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

main(process.argv.slice(2)).then(exitWhenFlushed, (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`toolmenu: ${message}\n`);
  exitWhenFlushed(2);
});

function parseRelease(value: string): { before: string; after: string } {
  const m = /^(.+?)\.\.(.+)$/.exec(value);
  if (!m) throw new UsageError(`--release expects <old>..<new>, e.g. 1.4.0..1.5.0 (got "${value}")`);
  return { before: m[1], after: m[2] };
}
