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
import { autoScenario, loadValuesFile, parseAssumeReadOnly, parseValueFlag, scenarioYaml, type GivenValue } from './auto.js';
import { authDir, listLogins, login, logout } from './auth.js';
import { existingMessage, initReport, planInit, shellWord, writeInit } from './init.js';
import { SEVERITY_RANK, type MenuTool, type Severity } from './types.js';
import { VERSION } from './version.js';
import { CLI_OPTIONS } from './options.js';
import { commandHelp, commandOptions, isCommand, overview, unknownCommand, type Command } from './help.js';

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--');
  const before = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? undefined : argv.slice(dash + 1);

  let parsed;
  try {
    parsed = parseArgs({ args: before, allowPositionals: true, options: CLI_OPTIONS });
  } catch (error) {
    // Which command was meant, so the hint can name its help and its options.
    const meant = commandIn(before);
    if (meant && error && typeof error === 'object') (error as { command?: Command }).command = meant;
    throw error;
  }
  const { values, positionals } = parsed;

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

  // The invocation up to the server, for examples in messages: a session example
  // without --auto or --scenario wouldn't run.
  const scenarioFlag = values.scenario ? ` --scenario ${shellWord(values.scenario)}` : '';
  const mode = sub !== 'session' ? '' : values.init ? ` --init${scenarioFlag}` : values.auto ? ' --auto' : scenarioFlag;
  const prefix = `${sub}${mode}`;

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
    const initTarget = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix);
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
    const target = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix);
    const plan = planInit({ cwd: process.cwd(), target, out: values.out, session: values['with-session'] });
    if (plan.existing.length) throw new UsageError(existingMessage(plan));
    const { menu, findings } = await snapshot(target, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, descriptionLimit: config.descriptionLimit, fullDescriptions: config.fullDescriptions });
    await writeInit(plan, JSON.stringify(menu, null, 2) + '\n');
    process.stdout.write(initReport(plan, { server: menu.server.name, version: menu.server.version, tools: menu.tools.length, tokens: menu.totalTokens, counts: counts(findings) }, target));
    return 0;
  }

  if (sub === 'session' && values.auto) {
    if (values.scenario) throw new UsageError('--auto builds the steps itself; drop --scenario (or drop --auto).');
    const givenMax = values['max-calls'] ? Number(values['max-calls']) : undefined;
    if (givenMax !== undefined && !(Number.isInteger(givenMax) && givenMax >= 1)) throw new UsageError('--max-calls must be a whole number, 1 or more');
    const perUnlock = values['max-calls-per-unlock'] ? Number(values['max-calls-per-unlock']) : 5;
    if (!Number.isInteger(perUnlock) || perUnlock < 1) throw new UsageError('--max-calls-per-unlock must be a whole number, 1 or more');
    const savePath = values['save-scenario'];
    if (savePath && existsSync(savePath)) throw new UsageError(`${savePath} already exists. Pick another path for --save-scenario.`);
    // Values and vouched-for tools are checked before anything starts.
    let given: Record<string, GivenValue> = {};
    let assumeReadOnly: string[] = [];
    try {
      if (values['values-file']) given = await loadValuesFile(values['values-file']);
      for (const v of values.value ?? []) {
        const [key, value] = parseValueFlag(v);
        given[key] = value;
      }
      assumeReadOnly = parseAssumeReadOnly(values['assume-read-only'] ?? []);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const autoTarget = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix);
    const waited = { ms: 0 };
    const menu = await probeMenu(seeded(autoTarget, MAIN_SEED), timeoutMs, undefined, waited).catch((error) => {
      throw refusedForTooMany(error, waited.ms);
    });
    const options = { openWorld: values['open-world'], values: given, assumeReadOnly };
    let plan = autoScenario(menu, { ...options, maxCalls: givenMax ?? 20 });
    // Each unlock value gets its own budget for the tools it brings, so the first
    // toolsets can't use up the calls the last ones need. --max-calls, when given,
    // caps every call, and the starting menu leaves up to half of it for the unlocks.
    const reserve = givenMax === undefined ? 0 : Math.min(perUnlock * plan.unlockValues, Math.floor(givenMax / 2));
    if (reserve) plan = autoScenario(menu, { ...options, maxCalls: givenMax! - reserve });
    const maxCalls = givenMax ?? 20 + perUnlock * plan.unlockValues;
    if (savePath) await writeFile(savePath, scenarioYaml(plan, menu.server.name));
    if (values.plan) {
      process.stdout.write(formatPlan(plan.scenario, 'auto') + '\n');
      return 0;
    }
    const auto = { called: plan.called, skipped: plan.skipped, assumed: plan.assumed, withValues: plan.withValues, ignored: plan.ignored, maxCalls, maxCallsPerUnlock: perUnlock };
    // Tools that appear mid-session (behind an unlock) are planned when they appear,
    // under the same rules and what's left of --max-calls. Each tool once.
    const planned = new Set([...plan.called, ...plan.skipped.map((s) => s.tool)]);
    let spent = plan.spent;
    const replan = (added: MenuTool[]) => {
      const fresh = added.filter((t) => !planned.has(t.name));
      for (const t of fresh) planned.add(t.name);
      if (!fresh.length) return [];
      const left = maxCalls - spent;
      const more = autoScenario({ ...menu, tools: fresh }, { ...options, maxCalls: Math.min(perUnlock, left), callsOnly: true });
      // Left out by this unlock's own budget, not by the total: say which, for the right flag.
      if (perUnlock < left) for (const s of more.skipped) if (s.reason === 'over the call budget') s.reason = 'over the per-unlock budget';
      spent += more.spent;
      auto.called.push(...more.called);
      auto.skipped.push(...more.skipped);
      auto.assumed.push(...more.assumed);
      auto.withValues.push(...more.withValues);
      if (more.assumed.length) plan.scenario.assumeReadOnly = [...(plan.scenario.assumeReadOnly ?? []), ...more.assumed];
      return more.scenario.steps;
    };
    const result = await session(autoTarget, plan.scenario, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, scenarioName: 'auto', unionOut: !!values['union-out'], auto, replan });
    // A --value or --assume-read-only for a tool behind an unlock isn't unused: check
    // them against every tool the session saw, not just the starting menu.
    auto.ignored = autoScenario(result.union, { values: given, assumeReadOnly }).ignored;
    result.auto = { ...result.auto, ...auto };
    if (values['union-out']) await writeFile(values['union-out'], JSON.stringify(result.union, null, 2) + '\n');
    const output = formatSession(result, format);
    if (output) process.stdout.write(output + '\n');
    return result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
  }

  if (sub === 'session') {
    if (values.value || values['values-file'] || values['assume-read-only']) throw new UsageError('--value, --values-file and --assume-read-only go with --auto. In a scenario, write the values into the steps\' args, and list tools under assume_read_only.');
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
    const sessionTarget = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix);
    const result = await session(sessionTarget, scenario, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, scenarioName: values.scenario, unionOut: !!values['union-out'] });
    if (values['union-out']) await writeFile(values['union-out'], JSON.stringify(result.union, null, 2) + '\n');
    const output = formatSession(result, format);
    if (output) process.stdout.write(output + '\n');
    return result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
  }

  const target = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix);
  const routesPath = values.routes ?? config.routes;
  const routes = routesPath ? await loadRoutes(routesPath) : undefined;

  const { menu, findings } = await snapshot(target, { routes, timeoutMs, processes, catalog: values.catalog ? (config.catalog ?? true) : undefined, rules: config.rules, ignore: config.ignore, descriptionLimit: config.descriptionLimit, fullDescriptions: config.fullDescriptions });

  const outPath = values['no-write'] ? undefined : values.out ?? 'menu.json';
  if (outPath) await writeFile(outPath, JSON.stringify(menu, null, 2) + '\n');

  const output = formatSnapshot(menu, findings, format, outPath);
  if (output) process.stdout.write(output + '\n');
  return findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
}

function parseTarget(positionals: string[], command: string[] | undefined, headers: string[], env: string[], noAuth: boolean | undefined, prefix: string): Target {
  if (command) {
    if (command.length === 0) throw new UsageError('Nothing after "--": give the command that starts the server.');
    if (positionals.length) throw new UsageError(`Unexpected "${positionals[0]}" before "--".`);
    return { kind: 'stdio', command: command[0], args: command.slice(1), env: parsePairs(env, '=', '--env') };
  }
  const [url, ...extra] = positionals;
  if (!url) throw new UsageError(`Give a server: a URL, or the command that starts it after "--".\n  → Next: toolmenu ${prefix} -- node dist/server.js (stdio) or toolmenu ${prefix} https://example.com/mcp (HTTP)`);
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
  process.stderr.write(`toolmenu: ${failureMessage(error)}\n`);
  exitWhenFlushed(2);
});

/** What stopped the command. A mistyped option gets the nearest real one. */
function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const command = (error as { command?: Command } | null)?.command;
  const next = command
    ? `toolmenu ${command} --help lists its options. (A server's own flags go after "--".)`
    : 'toolmenu --help lists the commands; toolmenu <command> --help lists its options.';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const option = /Unknown option '([^']+)'/.exec(message)?.[1] ?? '';
    const known = (command ? [...commandOptions(command), 'help', 'version'] : Object.keys(CLI_OPTIONS)).map((name) => `--${name}`);
    const guess = known.map((k) => [k, editDistance(option, k)] as const).sort((a, b) => a[1] - b[1])[0];
    const hint = guess && guess[1] <= 2 ? ` Did you mean ${guess[0]}?` : '';
    return `Unknown option ${option}.${hint}\n  → Next: ${next}`;
  }
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) return `${message}\n  → Next: ${next}`;
  return message;
}

/** The command in arguments parseArgs refused: the first command name that isn't an option's value (--out diff). */
function commandIn(args: string[]): Command | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const option = CLI_OPTIONS[a.slice(2) as keyof typeof CLI_OPTIONS] as { type: string } | undefined;
      if (option?.type === 'string' && !a.includes('=')) i++;
      continue;
    }
    if (isCommand(a)) return a;
  }
  return undefined;
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
