#!/usr/bin/env node
import { colourFor, colourise, colouriseError } from './colour.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CLIENT_NAMES, CLIENTS } from './clients.js';
import { LIST_WORDS } from './lists.js';
import { loadConfig, type Config } from './config.js';
import { ELICITATIONS, PROTOCOLS, type Elicitation, type Protocol, type Target } from './connect.js';
import { comparedTools, diffMenus } from './diff.js';
import { loadMenu } from './menu.js';
import { history, historyCsv } from './history.js';
import { counts, formatDiff, formatHistory, formatPlan, formatSession, formatSnapshot, type Format } from './report.js';
import { loadScenario, session, starterScenario, unlockListers, valuesFromListing } from './session.js';
import { listTools, quietExclusions } from './connect.js';
import { patiently, tooMany } from './failures.js';
import { buildMenu } from './menu.js';
import { existsSync } from 'node:fs';
import { loadRoutes } from './routes.js';
import { snapshot } from './snapshot.js';
import { connectPatiently, MAIN_SEED, probeMenu, refusedForTooMany, seeded, type Identity } from './probe.js';
import { autoScenario, loadValuesFile, parseAssumeReadOnly, parseValueFlag, scenarioYaml, type GivenValue } from './auto.js';
import { authDir, listLogins, login, logout } from './auth.js';
import { existingMessage, initReport, planInit, shellWord, writeInit } from './init.js';
import { SEVERITY_RANK, type Finding, type MenuTool, type Severity } from './types.js';
import { toSarif } from './sarif.js';
import { toJunit } from './junit.js';
import { diffHtml, sessionHtml, snapshotHtml } from './html.js';
import type { StepTool } from './session.js';
import { badge, badgeMarkdown } from './badge.js';
import { VERSION } from './version.js';
import { ARGS_ENV, SECRET_ARGS_ENV } from './mcp-env.js';
import { guardStream, plain, terminalSafe, writeUnguarded } from './sanitize.js';
import { CLI_OPTIONS } from './options.js';
import { editDistance } from './words.js';
import { formatScan, ListError, loadList, scan, scanExit, type AllowEnv } from './scan.js';
import { explain, findRule, formatExplained, listRules, ruleDocs } from './rule-docs.js';
import { commandHelp, commandOptions, isCommand, overview, unknownCommand, type Command } from './help.js';

class UsageError extends Error {}

export async function main(given: string[]): Promise<number> {
  const argv = withSecretArgs(given);
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

  // An option another command takes is ignored here: say so, or scan --no-auth reads as
  // done while the stored logins are used anyway. A warning, not an error: CI scripts pass
  // the shared options (--timeout) to every command.
  const takes = new Set([...commandOptions(sub as Command), 'help', 'version']);
  const at = (k: string) => before.findIndex((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  // In the order they were typed.
  const stray = Object.keys(values).filter((k) => !takes.has(k)).sort((a, b) => at(a) - at(b)).map((k) => `--${k}`);
  if (stray.length) {
    const one = stray.length === 1;
    process.stderr.write(
      `toolmenu: ${sub} ignores ${stray.join(', ')}: ${one ? 'it is' : 'they are'} for other commands.\n  → Next: Leave ${one ? 'it' : 'them'} out to silence this; toolmenu ${sub} --help lists the options ${sub} takes.\n`,
    );
  }

  const asked = values.json ? 'json' : values.format ?? 'text';
  if (!['text', 'json', 'github', 'markdown', 'sarif', 'junit'].includes(asked)) throw new UsageError(`--format must be text, json, github, markdown, sarif or junit`);
  // SARIF and JUnit are findings files, for code scanning and CI test reports: --format
  // sarif|junit prints one instead of the report, --sarif / --junit <path> writes it beside the report.
  const fileCommands = ['snapshot', 'diff', 'session'];
  if ((asked === 'sarif' || values.sarif !== undefined || values['sarif-menu'] !== undefined) && !fileCommands.includes(sub)) throw new UsageError(`SARIF output (--format sarif, --sarif, --sarif-menu) goes with snapshot, diff or session; ${sub} has none.`);
  if ((asked === 'junit' || values.junit !== undefined) && !fileCommands.includes(sub)) throw new UsageError(`JUnit output (--format junit, --junit) goes with snapshot, diff or session; ${sub} has none.`);
  if (sub === 'session' && (values.plan || values.init) && (asked === 'sarif' || values.sarif !== undefined)) throw new UsageError('SARIF needs findings: --plan and --init run nothing.');
  if (sub === 'session' && (values.plan || values.init) && (asked === 'junit' || values.junit !== undefined)) throw new UsageError('JUnit needs findings: --plan and --init run nothing.');
  if (values.html !== undefined && !fileCommands.includes(sub)) throw new UsageError(`The HTML report (--html) goes with snapshot, diff or session; ${sub} has none.`);
  if (sub === 'session' && (values.plan || values.init) && values.html !== undefined) throw new UsageError('The HTML report needs a run: --plan and --init run nothing.');
  const sarifToStdout = asked === 'sarif';
  const junitToStdout = asked === 'junit';
  const format = (sarifToStdout || junitToStdout ? 'text' : asked) as Format;
  /** session --html: the menu after each step, for the page only. */
  const stepMenus = new Map<number, StepTool[]>();
  /** Print the report, or the SARIF / JUnit file with --format sarif|junit; write --sarif's, --junit's and --html's files too. */
  const emit = async (report: string, findings: Finding[], command: string, menuPath: string | undefined, html?: () => string) => {
    if (values.html !== undefined && html) await writeFile(values.html, html());
    const menu = values['sarif-menu'] ?? menuPath;
    const sarif = values.sarif !== undefined || sarifToStdout ? toSarif(findings, { command, menuPath: menu }) + '\n' : undefined;
    // session's menuPath is where SARIF points, not what it checked (a live server): no target there.
    const junit = values.junit !== undefined || junitToStdout ? toJunit(findings, { command, failOn, target: command === 'session' ? undefined : menuPath }) + '\n' : undefined;
    if (values.sarif !== undefined) await writeFile(values.sarif, sarif!);
    if (values.junit !== undefined) await writeFile(values.junit, junit!);
    if (sarifToStdout) process.stdout.write(sarif!);
    // JUnit is XML, escaped its own way; the report is already safe, its colour toolmenu's.
    else if (junitToStdout) writeUnguarded(process.stdout, junit!);
    else if (report) writeUnguarded(process.stdout, show(report) + '\n');
  };
  // Colour for a report read in a terminal (colour.ts); piped, CI and other formats stay plain.
  // terminalSafe first: a control character a server's text still carries is shown, never acted on. JSON escapes its own.
  const show = (report: string) => {
    // JSON too: JSON.stringify leaves bidi and other format characters raw, and the
    // escapes terminalSafe writes read back as the same characters.
    const safe = terminalSafe(report);
    if (format === 'json') return safe;
    return format === 'text' && colourFor(process.stdout) ? colourise(safe) : safe;
  };
  const failOn = (values['fail-on'] ?? 'error') as Severity;
  if (!(failOn in SEVERITY_RANK)) throw new UsageError(`--fail-on must be error, warn or info`);
  const timeoutMs = values.timeout ? Number(values.timeout) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError(`--timeout must be a positive number of milliseconds`);

  if (sub === 'mcp') {
    if (command || rest.length) throw new UsageError('mcp takes no server: it is one. Add it to a client as: npx -y toolmenu mcp');
    // Loaded only here: the CLI's other commands don't need the server SDK.
    const { serveMcp } = await import('./mcp.js');
    await serveMcp();
    return 0;
  }
  // Every command's output, whatever writes it: a server's text that reaches a line
  // some report forgot is shown as escapes, never acted on by the terminal. Not toolmenu
  // mcp's stdout above: that's the protocol.
  guardStream(process.stdout);
  guardStream(process.stderr);
  if (sub === 'auth') return authCommand(rest, values);
  if (sub === 'explain') return explainCommand(rest, command, format);

  // The invocation up to the server, for examples in messages: a session example
  // without --auto or --scenario wouldn't run.
  const scenarioFlag = values.scenario ? ` --scenario ${shellWord(values.scenario)}` : '';
  const mode = sub !== 'session' ? '' : values.init ? ` --init${scenarioFlag}` : values.auto ? ' --auto' : scenarioFlag;
  const prefix = `${sub}${mode}`;

  const config = await loadConfig(values.config);
  const protocol = (values.protocol ?? config.protocol ?? 'auto') as Protocol;
  if (!PROTOCOLS.includes(protocol)) throw new UsageError(`--protocol must be auto, legacy or modern`);
  const elicitation = (values.elicitation ?? 'decline') as Elicitation;
  if (!ELICITATIONS.includes(elicitation)) throw new UsageError('--elicitation must be decline or cancel');
  if (values.lists !== undefined && sub !== 'snapshot') throw new UsageError('--lists goes with snapshot.');
  const lists = values.lists !== undefined ? values.lists.split(',').map((w) => w.trim()).filter(Boolean) : config.lists;
  const badList = (lists ?? []).find((w) => !(LIST_WORDS as readonly string[]).includes(w));
  if (badList) throw new UsageError(`--lists takes ${LIST_WORDS.join(', ')}, comma-separated; not "${badList}"`);
  if (values.client !== undefined && sub !== 'snapshot') throw new UsageError('--client goes with snapshot.');
  if (values.client !== undefined && !Object.hasOwn(CLIENTS, values.client)) throw new UsageError(`--client must be one of ${CLIENT_NAMES.join(', ')}`);
  if (values['offline-check'] && sub !== 'snapshot') throw new UsageError('--offline-check goes with snapshot.');
  if (values.as !== undefined && sub !== 'snapshot') throw new UsageError('--as goes with snapshot: it lists the menu once per identity.');
  if (values.elicitation !== undefined && sub !== 'session') throw new UsageError('--elicitation goes with session: only session calls tools.');
  // Only session calls tools, so only its targets declare elicitation and say how to answer.
  const answering = (t: Target): Target => ({ ...t, elicitation });
  const processes = values.processes !== undefined ? Number(values.processes) : config.processes ?? 2;
  if (!Number.isInteger(processes) || processes < 1) throw new UsageError('--processes must be a whole number, 1 or more');

  if (sub === 'scan') {
    if (command) throw new UsageError('scan reads its servers from a list file; give the file, not a command.');
    if (rest.length !== 1) throw new UsageError('scan needs one list: an MCP client config (mcp.json) or a text file with a server per line.');
    const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : 4;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError('--concurrency must be a whole number, 1 or more');
    const names = (values['allow-env'] ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    const bad = names.find((n) => n !== '*' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    if (bad) throw new UsageError(`--allow-env takes environment variable names, comma-separated, or '*' for all; "${bad}" isn't one.`);
    const allow: AllowEnv = names.includes('*') ? '*' : new Set(names);
    let entries;
    try {
      entries = await loadList(rest[0], allow);
    } catch (error) {
      if (error instanceof ListError) throw new UsageError(error.message);
      throw error;
    }
    const noAuth = values['no-auth'] === true;
    const withProtocol = entries.map((e) => {
      if (!e.target || e.target.kind !== 'http') return e.target && protocol !== 'auto' ? { ...e, target: { ...e.target, protocol } } : e;
      return { ...e, target: { ...e.target, ...(protocol !== 'auto' ? { protocol } : {}), ...(noAuth ? { noAuth } : {}) } };
    });
    const outDir = values['out-dir'];
    if (outDir) await mkdir(outDir, { recursive: true });
    const tty = process.stderr.isTTY;
    const rows = await scan(withProtocol, {
      timeoutMs,
      processes,
      concurrency,
      rules: config.rules,
      ignore: config.ignore,
      descriptionLimit: config.descriptionLimit,
      fullDescriptions: config.fullDescriptions,
      ...(config.client ? { client: config.client } : {}),
      // stdio servers only: snapshot skips it for HTTP.
      ...(config.offlineCheck ? { offlineCheck: true } : {}),
      onDone: (row, done, total) => {
        if (tty) writeUnguarded(process.stderr, `\r\x1b[K  ${done}/${total}  ${plain(row.name)}`);
      },
    });
    if (tty) writeUnguarded(process.stderr, '\r\x1b[K');
    if (outDir) for (const r of rows) if (r.menu) await writeFile(join(outDir, `${r.name.replace(/[^\w.@-]+/g, '_')}.json`), JSON.stringify(r.menu, null, 2) + '\n');
    writeUnguarded(process.stdout, show(formatScan(rows, format, rest[0])) + '\n');
    return scanExit(rows, failOn);
  }

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
    await emit(formatDiff(result, before.tools.length, after.tools.length, format), result.findings, 'diff', rest[1], () => diffHtml(result, comparedTools(before, after, config.ignore), { paths: [rest[0], rest[1]] }));
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
    process.stdout.write(show(formatHistory(result, format, outDir, values.csv)) + '\n');
    return result.rows.length > 0 && result.rows.every((r) => r.status === 'failed') ? 1 : 0;
  }

  if (sub === 'session' && values.init) {
    const path = values.scenario ?? 'scenario.yml';
    if (existsSync(path)) throw new UsageError(`${path} already exists. Pick another path with --scenario.`);
    const initTarget = answering(parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix, protocol));
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
          const result = await quietExclusions(() => conn.client.callTool({ name: lister, arguments: {} }, { timeout: timeoutMs }));
          const found = result.isError ? [] : valuesFromListing(result);
          if (found.length) {
            unlockValues[unlock] = found;
            read.push(`${found.length} values for ${plain(unlock)} from ${plain(lister)}`);
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
    const target = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix, protocol);
    const plan = planInit({ cwd: process.cwd(), target, out: values.out, session: values['with-session'] });
    if (plan.existing.length) throw new UsageError(existingMessage(plan));
    const { menu, findings } = await snapshot(target, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, descriptionLimit: config.descriptionLimit, fullDescriptions: config.fullDescriptions, ...(config.offlineCheck && target.kind === 'stdio' ? { offlineCheck: true } : {}) });
    await writeInit(plan, JSON.stringify(menu, null, 2) + '\n');
    process.stdout.write(initReport(plan, { server: menu.server.name === undefined ? undefined : plain(menu.server.name), version: menu.server.version === undefined ? undefined : plain(menu.server.version), tools: menu.tools.length, tokens: menu.totalTokens, counts: counts(findings) }, target));
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
    const autoTarget = answering(parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix, protocol));
    const waited = { ms: 0 };
    const menu = await probeMenu(seeded(autoTarget, MAIN_SEED), timeoutMs, undefined, waited).catch((error) => {
      throw refusedForTooMany(error, waited.ms);
    });
    const options = { openWorld: values['open-world'], createHandles: values['create-handles'], values: given, assumeReadOnly };
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
    const result = await session(autoTarget, plan.scenario, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, scenarioName: 'auto', unionOut: !!values['union-out'], auto, replan, onStepMenu: values.html !== undefined ? (step, menu) => stepMenus.set(step, menu) : undefined });
    // A --value or --assume-read-only for a tool behind an unlock isn't unused: check
    // them against every tool the session saw, not just the starting menu.
    auto.ignored = autoScenario(result.union, { values: given, assumeReadOnly }).ignored;
    result.auto = { ...result.auto, ...auto };
    if (values['union-out']) await writeFile(values['union-out'], JSON.stringify(result.union, null, 2) + '\n');
    await emit(formatSession(result, format), result.findings, 'session', values['union-out'] ?? (existsSync('menu.json') ? 'menu.json' : undefined), () => sessionHtml(result, stepMenus));
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
    const sessionTarget = answering(parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix, protocol));
    const result = await session(sessionTarget, scenario, { timeoutMs, processes, rules: config.rules, ignore: config.ignore, scenarioName: values.scenario, unionOut: !!values['union-out'], onStepMenu: values.html !== undefined ? (step, menu) => stepMenus.set(step, menu) : undefined });
    if (values['union-out']) await writeFile(values['union-out'], JSON.stringify(result.union, null, 2) + '\n');
    await emit(formatSession(result, format), result.findings, 'session', values['union-out'] ?? (existsSync('menu.json') ? 'menu.json' : undefined), () => sessionHtml(result, stepMenus));
    return result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
  }

  const target = parseTarget(rest, command, values.header ?? [], values.env ?? [], values['no-auth'], prefix, protocol);
  const identities = values.as?.length ? parseIdentities(values.as, target.kind) : configIdentities(config.identities, target.kind);
  const routesPath = values.routes ?? config.routes;
  const routes = routesPath ? await loadRoutes(routesPath) : undefined;

  const client = values.client ?? config.client;
  const offlineCheck = values['offline-check'] ?? config.offlineCheck;
  if (values['offline-check'] && target.kind !== 'stdio') throw new UsageError("--offline-check goes with a stdio server: an HTTP server's network isn't this machine's to cut.");
  const { menu, findings, cost, notOffered } = await snapshot(target, { offlineCheck: offlineCheck && target.kind === 'stdio', routes, timeoutMs, processes, identities, client, lists, catalog: values.catalog ? (config.catalog ?? true) : undefined, rules: config.rules, ignore: config.ignore, descriptionLimit: config.descriptionLimit, fullDescriptions: config.fullDescriptions });

  const outPath = values['no-write'] ? undefined : values.out ?? 'menu.json';
  if (outPath) await writeFile(outPath, JSON.stringify(menu, null, 2) + '\n');

  await emit(formatSnapshot(menu, findings, format, outPath, cost, notOffered), findings, 'snapshot', outPath, () => snapshotHtml(menu, findings, { transport: target.kind, cost, notOffered, outPath }));
  if (values.badge !== undefined) {
    await writeFile(values.badge, JSON.stringify(badge(menu, findings), null, 2) + '\n');
    // stderr: stdout stays the report (or the JSON/SARIF a script parses).
    process.stderr.write(`toolmenu: wrote the badge to ${values.badge}. Commit it with the menu file; in the README:\n  ${badgeMarkdown(values.badge)}\n`);
  }
  return findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
}

function parseTarget(positionals: string[], command: string[] | undefined, headers: string[], env: string[], noAuth: boolean | undefined, prefix: string, protocol: Protocol): Target {
  if (command) {
    if (command.length === 0) throw new UsageError('Nothing after "--": give the command that starts the server.');
    if (positionals.length) throw new UsageError(`Unexpected "${positionals[0]}" before "--".`);
    return { kind: 'stdio', command: command[0], args: command.slice(1), env: parsePairs(env, '=', '--env'), ...(protocol !== 'auto' ? { protocol } : {}) };
  }
  const [url, ...extra] = positionals;
  if (!url) throw new UsageError(`Give a server: a URL, or the command that starts it after "--".\n  → Next: toolmenu ${prefix} -- node dist/server.js (stdio) or toolmenu ${prefix} https://example.com/mcp (HTTP)`);
  if (extra.length) throw new UsageError(`Unexpected "${extra[0]}". For a stdio server, put the command after "--".`);
  if (!/^https?:\/\//.test(url)) throw new UsageError(`"${url}" isn't an http(s) URL. For a stdio server, put the command after "--".`);
  return { kind: 'http', url, headers: parsePairs(headers, ':', '--header'), ...(noAuth ? { noAuth } : {}), ...(protocol !== 'auto' ? { protocol } : {}) };
}

async function authCommand(args: string[], values: { port?: string; scope?: string; 'client-id'?: string; 'client-secret'?: string; timeout?: string; 'no-browser'?: boolean }): Promise<number> {
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
  const result = await login(url, { port, scope: values.scope, clientId: values['client-id'], clientSecret: values['client-secret'], noBrowser: values['no-browser'] });
  process.stdout.write(`Logged in to ${plain(result.name ?? url)} (${url}): it lists ${result.tools} tool${result.tools === 1 ? '' : 's'} with this login.\nsnapshot and session use it from now on (--no-auth to skip it); stored in ${authDir()}.\n`);
  return 0;
}

/**
 * --as name:credential, repeatable, in order of first mention: `reader:Authorization:
 * Bearer x` (HTTP header) or `admin:ROLE=admin` (stdio env var). A name alone is an
 * identity with only the --header/--env given to every run.
 */
function parseIdentities(items: string[], kind: Target['kind']): Identity[] {
  const byName = new Map<string, Identity>();
  for (const item of items) {
    const colon = item.indexOf(':');
    const name = (colon < 0 ? item : item.slice(0, colon)).trim();
    if (!/^[\w.-]+$/.test(name)) throw new UsageError(`--as "${item}" should start with a name (letters, digits, _ . -): --as reader:${kind === 'http' ? 'Authorization: Bearer …' : 'TOKEN=…'}`);
    const identity = byName.get(name) ?? { name };
    byName.set(name, identity);
    if (colon < 0) continue;
    const credential = item.slice(colon + 1);
    if (kind === 'http') identity.headers = { ...identity.headers, ...parsePairs([credential], ':', `--as ${name}:`) };
    else identity.env = { ...identity.env, ...parsePairs([credential], '=', `--as ${name}:`) };
  }
  if (byName.size < 2) throw new UsageError('--as needs two identities or more to compare: --as reader:… --as admin:…');
  return [...byName.values()];
}

/** The config file's identities, for this kind of server: headers for HTTP, env for stdio. */
function configIdentities(ids: Config['identities'], kind: Target['kind']): Identity[] | undefined {
  if (!ids) return undefined;
  // Credentials for the other kind of server only (env for an HTTP server): that identity would list as nobody in particular.
  const wrong = Object.entries(ids).filter(([, id]) => (kind === 'http' ? !id.headers && id.env : !id.env && id.headers)).map(([name]) => name);
  if (wrong.length) {
    throw new UsageError(`identities ${wrong.join(', ')} in the config give ${kind === 'http' ? 'env vars' : 'headers'} only, and this is ${kind === 'http' ? 'an HTTP' : 'a stdio'} server: give each ${kind === 'http' ? '"headers"' : '"env"'}.`);
  }
  const list = Object.entries(ids).map(([name, id]) => ({ name, ...(kind === 'http' ? (id.headers ? { headers: id.headers } : {}) : id.env ? { env: id.env } : {}) }));
  return list.length >= 2 ? list : undefined;
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
  // An error can quote what a server said: shown, never acted on by the terminal.
  const message = terminalSafe(`toolmenu: ${failureMessage(error)}`);
  writeUnguarded(process.stderr, `${colourFor(process.stderr) ? colouriseError(message) : message}\n`);
  exitWhenFlushed(2);
});

function explainCommand(rest: string[], command: string[] | undefined, format: Format): number {
  if (command) throw new UsageError("explain takes a rule's name, not a server.");
  if (format !== 'text' && format !== 'json') throw new UsageError('explain prints text, or JSON with --json.');
  if (rest.length > 1) throw new UsageError(`explain takes one rule at a time; got ${rest.length}.`);
  if (!rest.length) {
    process.stdout.write(format === 'json' ? `${JSON.stringify(Object.keys(ruleDocs()))}\n` : listRules());
    return 0;
  }
  const found = findRule(rest[0]);
  if ('near' in found) {
    const hint = found.near.length ? ` Did you mean ${found.near.join(', ')}?` : '';
    throw new UsageError(`No rule "${rest[0]}".${hint} toolmenu explain lists every rule.`);
  }
  const e = explain(found.id);
  process.stdout.write(format === 'json' ? `${JSON.stringify(e, null, 2)}\n` : formatExplained(e));
  return 0;
}

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

/**
 * Arguments the CLI takes from the environment, each a JSON array of arguments that
 * goes before the server command's "--": TOOLMENU_ARGS, for anyone who'd rather keep
 * --header, --env or --client-secret values off the command line (argv is readable by
 * any local user), and TOOLMENU_MCP_ARGS, which toolmenu mcp passes credentials in.
 * Each is removed from the environment once read.
 */
function withSecretArgs(argv: string[]): string[] {
  const extra: string[] = [];
  for (const name of [ARGS_ENV, SECRET_ARGS_ENV]) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    delete process.env[name];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) throw new UsageError(`${name} must be a JSON array of strings, e.g. ["--header", "Authorization: Bearer …"].`);
    extra.push(...parsed);
  }
  if (!extra.length) return argv;
  const dash = argv.indexOf('--');
  return dash === -1 ? [...argv, ...extra] : [...argv.slice(0, dash), ...extra, ...argv.slice(dash)];
}

function parseRelease(value: string): { before: string; after: string } {
  const m = /^(.+?)\.\.(.+)$/.exec(value);
  if (!m) throw new UsageError(`--release expects <old>..<new>, e.g. 1.4.0..1.5.0 (got "${value}")`);
  return { before: m[1], after: m[2] };
}
