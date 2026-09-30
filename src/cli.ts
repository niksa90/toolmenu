#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import type { Target } from './connect.js';
import { diffMenus } from './diff.js';
import { loadMenu } from './menu.js';
import { history, historyCsv } from './history.js';
import { counts, formatDiff, formatHistory, formatPlan, formatSession, formatSnapshot, type Format } from './report.js';
import { loadScenario, session, starterScenario, unlockListers, valuesFromListing } from './session.js';
import { listTools } from './connect.js';
import { patiently, tooMany } from './failures.js';
import { buildMenu } from './menu.js';
import { existsSync } from 'node:fs';
import { loadRoutes } from './routes.js';
import { snapshot } from './snapshot.js';
import { connectPatiently, MAIN_SEED, probeMenu, refusedForTooMany, seeded } from './probe.js';
import { autoScenario, scenarioYaml } from './auto.js';
import { authDir, listLogins, login, logout } from './auth.js';
import { detectProject, secretsNeeded, workflowYaml } from './init.js';
import { SEVERITY_RANK, type Severity } from './types.js';
import { VERSION } from './version.js';

const HELP = `toolmenu ${VERSION}
Lint your MCP server's tool menu for changes that confuse agents or break caches.

Usage:
  toolmenu init [options] -- <command> | <url>          set up CI: a baseline and a workflow
  toolmenu snapshot [options] -- <command> [args...]   stdio server
  toolmenu snapshot [options] <url>                    Streamable HTTP server
  toolmenu diff [options] <old.json> <new.json>        compare two snapshots
  toolmenu history [options] <npm-package>             snapshot and diff published versions
  toolmenu auth login <url> | logout <url> | list      OAuth logins for HTTP servers
  toolmenu session --scenario <file> [options] -- <command> | <url>
                                                       run a scripted session, watch the menu
  toolmenu session --auto [options] -- <command> | <url>
                                                       the same, with steps built from the menu

Commands:
  init       snapshot the server into menu.json and write .github/workflows/toolmenu.yml
  snapshot   establish the menu: list tools twice, write menu.json, run the menu rules
  diff       compare releases: breaking changes, token change, semver bump
  session    observe the menu changing while a scripted session runs
  history    research release history: install, snapshot and diff published npm versions
  auth       log in to an OAuth-protected server once; snapshot and session then use it

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
  --no-auth           don't use a stored OAuth login for this server
  --timeout <ms>      per-request timeout (default: 30000)
  --catalog           also read the operations behind a search tool (search and execute:
                      discover, search_*_tools) and keep them in the menu file for diff
  --processes <n>     server processes (stdio) or connections (HTTP) to compare,
                      the main one included (default: 2; 1 opens no second one, for
                      session's scope check either: for servers with one session per client)
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
  --auto                build the steps from the menu: every read-only tool whose
                        required arguments the schema can fill (const, default,
                        examples, enum, type), then the first call again
  --open-world          with --auto, also call read-only tools marked openWorldHint:
                        true (web search, fetch, scraping): they may cost API credits
  --max-calls <n>       with --auto, at most n calls (default: 20)
  --save-scenario <p>   with --auto, write the steps it ran as a scenario file
  --union-out <path>    write every tool the session saw as a menu file, to commit as
                        the baseline for diff (tools behind unlocks included)

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

init options:
  --with-session        the workflow also runs session --auto (calls read-only tools)

auth options:
  --port <n>            loopback port for the login redirect (default: 33418)
  --scope <scopes>      scopes to ask for (default: the server's)
  --client-id <id>      a pre-registered client, for servers without dynamic registration
  --client-secret <s>   its secret, if it has one

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
      'no-auth': { type: 'boolean' },
      port: { type: 'string' },
      scope: { type: 'string' },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      processes: { type: 'string' },
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
      'union-out': { type: 'string' },
      auto: { type: 'boolean' },
      'with-session': { type: 'boolean' },
      catalog: { type: 'boolean' },
      'open-world': { type: 'boolean' },
      'max-calls': { type: 'string' },
      'save-scenario': { type: 'string' },
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
  if (!['init', 'snapshot', 'diff', 'history', 'session', 'auth'].includes(sub)) throw new UsageError(`Unknown command "${sub}". Try --help.`);

  const format = (values.json ? 'json' : values.format ?? 'text') as Format;
  if (!['text', 'json', 'github', 'markdown'].includes(format)) throw new UsageError(`--format must be text, json, github or markdown`);
  const failOn = (values['fail-on'] ?? 'error') as Severity;
  if (!(failOn in SEVERITY_RANK)) throw new UsageError(`--fail-on must be error, warn or info`);
  const timeoutMs = values.timeout ? Number(values.timeout) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError(`--timeout must be a positive number of milliseconds`);

  if (sub === 'auth') return authCommand(rest, values);

  const config = await loadConfig(values.config);
  const processes = values.processes !== undefined ? Number(values.processes) : config.processes ?? 2;
  if (!Number.isInteger(processes) || processes < 1) throw new UsageError('--processes must be a whole number, 1 or more');

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
    const initTarget = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth']);
    const conn = await connectPatiently(seeded(initTarget, MAIN_SEED), { timeoutMs });
    try {
      const list = await patiently(() => listTools(conn, { timeoutMs }), { error: tooMany });
      const menu = buildMenu(list.tools, { name: conn.server.name, version: conn.server.version, protocolVersion: conn.protocolVersion });
      // An unlock without an enum: its values come from the server's own read-only
      // listing (list_toolsets), so the scenario can unlock every one.
      const unlockValues: Record<string, unknown[]> = {};
      const read: string[] = [];
      for (const { unlock, lister } of unlockListers(menu.tools)) {
        try {
          const result = await conn.client.callTool({ name: lister, arguments: {} }, { timeout: timeoutMs });
          const found = result.isError ? [] : valuesFromListing(result);
          if (found.length) {
            unlockValues[unlock] = found;
            read.push(`${found.length} values for ${unlock} from ${lister}`);
          }
        } catch {
          // Left as TODO in the scenario.
        }
      }
      await writeFile(path, starterScenario(menu, { values: unlockValues }));
      process.stdout.write(`wrote ${path}: a starter scenario for ${menu.tools.length} tools${read.length ? ` (read ${read.join('; ')})` : ''}. Fill in the TODOs, then run toolmenu session --scenario ${path}\n`);
    } finally {
      await conn.close().catch(() => {});
    }
    return 0;
  }

  if (sub === 'init') {
    const workflow = join('.github', 'workflows', 'toolmenu.yml');
    const baseline = values.out ?? 'menu.json';
    for (const f of [workflow, baseline]) if (existsSync(f)) throw new UsageError(`${f} already exists; init never overwrites. Remove it, or set things up by hand (README: "In CI").`);
    const target = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth']);
    const { menu, findings } = await snapshot(target, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, descriptionLimit: config.descriptionLimit, fullDescriptions: config.fullDescriptions });
    await writeFile(baseline, JSON.stringify(menu, null, 2) + '\n');
    await mkdir(dirname(workflow), { recursive: true });
    const project = detectProject('.');
    await writeFile(workflow, workflowYaml({ target, project, session: values['with-session'], baseline }));
    const c = counts(findings);
    const secrets = secretsNeeded(target);
    const lines = [
      `toolmenu init  ${menu.server.name ?? 'server'} · ${menu.tools.length} tools · ~${menu.totalTokens.toLocaleString('en-US')} tokens (estimate)`,
      `  wrote ${baseline}: the baseline every pull request is compared with`,
      `  wrote ${workflow}${project.kind === 'unknown' ? ' (fill in the TODO: how CI builds your server)' : ` (${project.kind} project)`}`,
      `  today's menu: ${c.error} errors, ${c.warn} warnings, ${c.info} info (run toolmenu snapshot to see them)`,
      ...(secrets.length ? ['', `Add these repository secrets (Settings → Secrets and variables → Actions): ${secrets.join(', ')}`] : []),
      '',
      'Next:',
      `  git add ${baseline} ${workflow} && git commit -m "Check the MCP tool menu on every PR"`,
      '  Then open a pull request: toolmenu comments on it. Refresh the baseline when a change is intended:',
      `  toolmenu snapshot --out ${baseline} ${target.kind === 'stdio' ? '-- ' + [target.command, ...target.args].join(' ') : target.url}`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  if (sub === 'session' && values.auto) {
    if (values.scenario) throw new UsageError('--auto builds the steps itself; drop --scenario (or drop --auto).');
    const maxCalls = values['max-calls'] ? Number(values['max-calls']) : 20;
    if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new UsageError('--max-calls must be a whole number, 1 or more');
    const savePath = values['save-scenario'];
    if (savePath && existsSync(savePath)) throw new UsageError(`${savePath} already exists. Pick another path for --save-scenario.`);
    const autoTarget = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth']);
    const waited = { ms: 0 };
    const menu = await probeMenu(seeded(autoTarget, MAIN_SEED), timeoutMs, undefined, waited).catch((error) => {
      throw refusedForTooMany(error, waited.ms);
    });
    const plan = autoScenario(menu, { openWorld: values['open-world'], maxCalls });
    if (savePath) await writeFile(savePath, scenarioYaml(plan, menu.server.name));
    if (values.plan) {
      process.stdout.write(formatPlan(plan.scenario, 'auto') + '\n');
      return 0;
    }
    const result = await session(autoTarget, plan.scenario, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, scenarioName: 'auto', unionOut: !!values['union-out'], auto: { called: plan.called, skipped: plan.skipped } });
    result.auto = { called: plan.called, skipped: plan.skipped };
    if (values['union-out']) await writeFile(values['union-out'], JSON.stringify(result.union, null, 2) + '\n');
    const output = formatSession(result, format);
    if (output) process.stdout.write(output + '\n');
    return result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
  }

  if (sub === 'session') {
    if (!values.scenario) throw new UsageError('session needs --scenario <file>. Run session --init for a starter, or see https://github.com/niksa90/toolmenu#session-the-menu-changing-while-the-agent-works for the format.');
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
    const sessionTarget = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth']);
    const result = await session(sessionTarget, scenario, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, scenarioName: values.scenario, unionOut: !!values['union-out'] });
    if (values['union-out']) await writeFile(values['union-out'], JSON.stringify(result.union, null, 2) + '\n');
    const output = formatSession(result, format);
    if (output) process.stdout.write(output + '\n');
    return result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
  }

  const target = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth']);
  const routesPath = values.routes ?? config.routes;
  const routes = routesPath ? await loadRoutes(routesPath) : undefined;

  const { menu, findings } = await snapshot(target, { routes, timeoutMs, processes, catalog: values.catalog ? (config.catalog ?? true) : undefined, rules: config.rules, ignore: config.ignore, descriptionLimit: config.descriptionLimit, fullDescriptions: config.fullDescriptions });

  const outPath = values['no-write'] ? undefined : values.out ?? 'menu.json';
  if (outPath) await writeFile(outPath, JSON.stringify(menu, null, 2) + '\n');

  const output = formatSnapshot(menu, findings, format, outPath);
  if (output) process.stdout.write(output + '\n');
  return findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
}

function parseTarget(positionals: string[], command: string[] | undefined, headers: string[], env: string[], noAuth = false): Target {
  if (command) {
    if (command.length === 0) throw new UsageError('Nothing after "--": give the command that starts the server.');
    if (positionals.length) throw new UsageError(`Unexpected "${positionals[0]}" before "--".`);
    return { kind: 'stdio', command: command[0], args: command.slice(1), env: parsePairs(env, '=', '--env') };
  }
  const [url, ...extra] = positionals;
  if (!url) throw new UsageError('Give a server URL, or "-- <command>" for a stdio server.');
  if (extra.length) throw new UsageError(`Unexpected "${extra[0]}". For a stdio server, put the command after "--".`);
  if (!/^https?:\/\//.test(url)) throw new UsageError(`"${url}" isn't an http(s) URL. For a stdio server, put the command after "--".`);
  return { kind: 'http', url, headers: parsePairs(headers, ':', '--header'), ...(noAuth ? { noAuth } : {}) };
}

async function authCommand(args: string[], values: { port?: string; scope?: string; 'client-id'?: string; 'client-secret'?: string; timeout?: string }): Promise<number> {
  const [action, url, ...extra] = args;
  if (action === 'list') {
    const logins = await listLogins();
    process.stdout.write(logins.length ? logins.map((l) => `${l.serverUrl}  (issuer ${l.issuer ?? '?'}, saved ${l.savedAt?.slice(0, 10) ?? '?'})`).join('\n') + '\n' : `No logins. Stored in ${authDir()}.\n`);
    return 0;
  }
  if (action !== 'login' && action !== 'logout') throw new UsageError('auth takes login <url>, logout <url> or list.');
  if (!url || extra.length) throw new UsageError(`auth ${action} needs one server URL: toolmenu auth ${action} https://example.com/mcp`);
  if (!/^https?:\/\//.test(url)) throw new UsageError(`"${url}" isn't an http(s) URL.`);
  if (action === 'logout') {
    process.stdout.write((await logout(url)) ? `Logged out of ${url}.\n` : `No login stored for ${url}.\n`);
    return 0;
  }
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError('--port must be a port number');
  if (values['client-secret'] && !values['client-id']) throw new UsageError('--client-secret goes with --client-id');
  const result = await login(url, { port, scope: values.scope, clientId: values['client-id'], clientSecret: values['client-secret'] });
  process.stdout.write(`Logged in to ${result.name ?? url}: ${result.tools} tools. snapshot and session use this login from now on (--no-auth to skip it).\n`);
  return 0;
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

// stdout carries the report alone (--format json is parsed by CI). Libraries log
// with console: the MCP SDK prints a console.debug line to stdout when a server
// has no tools capability. Their lines go to stderr.
for (const method of ['log', 'info', 'debug'] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

main(process.argv.slice(2)).then(exitWhenFlushed, (error: unknown) => {
  process.stderr.write(`toolmenu: ${failureMessage(error)}\n`);
  exitWhenFlushed(2);
});

/** What stopped the command. A mistyped option gets the nearest real one, from the help text. */
function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const option = /Unknown option '([^']+)'/.exec(message)?.[1] ?? '';
    const known = [...new Set(HELP.match(/--[a-z][a-z-]*/g) ?? [])];
    const guess = known.map((k) => [k, editDistance(option, k)] as const).sort((a, b) => a[1] - b[1])[0];
    const hint = guess && guess[1] <= 2 ? ` Did you mean ${guess[0]}?` : '';
    return `Unknown option ${option}.${hint}\n  → Next: toolmenu --help lists every option. (A server's own flags go after "--".)`;
  }
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) return `${message}\n  → Next: toolmenu --help lists every option.`;
  return message;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function parseRelease(value: string): { before: string; after: string } {
  const m = /^(.+?)\.\.(.+)$/.exec(value);
  if (!m) throw new UsageError(`--release expects <old>..<new>, e.g. 1.4.0..1.5.0 (got "${value}")`);
  return { before: m[1], after: m[2] };
}
