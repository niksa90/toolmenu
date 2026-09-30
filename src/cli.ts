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
import { CLI_OPTIONS } from './options.js';
import { commandHelp, isCommand, overview, unknownCommand } from './help.js';

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--');
  const before = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? undefined : argv.slice(dash + 1);

  const { values, positionals } = parseArgs({
    args: before,
    allowPositionals: true,
    options: CLI_OPTIONS,
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [sub, ...rest] = positionals;
  // toolmenu help [command] reads like toolmenu [command] --help.
  if (sub === 'help' && rest.length <= 1) {
    if (rest[0] && !isCommand(rest[0])) throw new UsageError(unknownCommand(rest[0]));
    process.stdout.write(rest[0] && isCommand(rest[0]) ? commandHelp(rest[0]) : overview());
    return 0;
  }
  if (sub && !isCommand(sub)) throw new UsageError(unknownCommand(sub));
  if (values.help || !sub) {
    process.stdout.write(sub && isCommand(sub) ? commandHelp(sub) : overview());
    return sub || values.help ? 0 : 2;
  }

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
    process.stdout.write(formatHistory(result, format, outDir, values.csv) + '\n');
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
    const width = Math.max(0, ...logins.map((l) => l.serverUrl.length));
    process.stdout.write(
      logins.length
        ? [`${logins.length} login${logins.length === 1 ? '' : 's'}, stored in ${authDir()}:`, ...logins.map((l) => `  ${l.serverUrl.padEnd(width)}  issuer ${l.issuer ?? 'not recorded'} · saved ${l.savedAt?.slice(0, 10) ?? '?'}`)].join('\n') + '\n'
        : `No logins stored in ${authDir()}.\n→ Next: toolmenu auth login <url> for a server that asks for OAuth.\n`,
    );
    return 0;
  }
  if (action !== 'login' && action !== 'logout') throw new UsageError(`${action ? `auth has no action "${action}"` : 'auth needs an action'}: login <url>, logout <url> or list. See toolmenu auth --help.`);
  if (!url || extra.length) throw new UsageError(`auth ${action} needs one server URL: toolmenu auth ${action} https://example.com/mcp`);
  if (!/^https?:\/\//.test(url)) throw new UsageError(`"${url}" isn't an http(s) URL.`);
  if (action === 'logout') {
    process.stdout.write((await logout(url)) ? `Logged out of ${url}: its tokens and client registration are removed from ${authDir()}.\n` : `No login stored for ${url} (in ${authDir()}), so nothing to remove. toolmenu auth list shows the stored ones.\n`);
    return 0;
  }
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError('--port must be a port number');
  if (values['client-secret'] && !values['client-id']) throw new UsageError('--client-secret goes with --client-id');
  const result = await login(url, { port, scope: values.scope, clientId: values['client-id'], clientSecret: values['client-secret'] });
  process.stdout.write(`Logged in to ${result.name ?? url} (${url}): it lists ${result.tools} tool${result.tools === 1 ? '' : 's'} with this login.\nsnapshot and session use it from now on (--no-auth to skip it); stored in ${authDir()}.\n`);
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`toolmenu: ${message}\n`);
  exitWhenFlushed(2);
});

function parseRelease(value: string): { before: string; after: string } {
  const m = /^(.+?)\.\.(.+)$/.exec(value);
  if (!m) throw new UsageError(`--release expects <old>..<new>, e.g. 1.4.0..1.5.0 (got "${value}")`);
  return { before: m[1], after: m[2] };
}
