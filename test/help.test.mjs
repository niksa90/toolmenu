import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandHelp, COMMANDS, overview, unknownCommand } from '../dist/help.js';
import { failureAdvice } from '../dist/history.js';
import { formatHistory } from '../dist/report.js';
import { run } from './helpers.mjs';

test('help: every command has usage, options, examples and exit codes; the overview names them all', () => {
  for (const c of COMMANDS) {
    const h = commandHelp(c);
    for (const part of ['Usage:', 'Options:', 'Examples:', 'Exit codes:']) assert.ok(h.includes(part), `${c}: ${part}`);
    assert.match(h, new RegExp(`^toolmenu ${c}: `));
    assert.ok(overview().includes(`  ${c} `), c);
  }
  // Each command lists only what it takes.
  assert.doesNotMatch(commandHelp('diff'), /--header|--env|--processes/);
  assert.match(commandHelp('diff'), /--release <old>\.\.<new>/);
  assert.match(commandHelp('history'), /--install-timeout/);
  assert.doesNotMatch(commandHelp('snapshot'), /--install-timeout|--scenario/);
  assert.match(commandHelp('session'), /--max-calls/);
  assert.ok(overview().split('\n').length < 30, 'the overview stays short');
});

test('cli: <command> --help and help <command> show that command; an unknown one lists the commands', async () => {
  const history = await run(['history', '--help']);
  assert.equal(history.code, 0);
  assert.match(history.stdout, /^toolmenu history: /);
  assert.doesNotMatch(history.stdout, /--scenario/);
  assert.equal((await run(['help', 'auth'])).stdout, commandHelp('auth'));
  const unknown = await run(['snap', '--help']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command "snap"\. Did you mean snapshot\? The commands are init, snapshot, diff, session, history, auth/);
  assert.match(unknownCommand('frobnicate'), /^Unknown command "frobnicate"\. The commands are/);
});

test('history: a failed version says what happened and what to try, and marks inferences unsure', () => {
  const env = failureAdvice('needs-env', "throw new Error('HubSpot access token is required');\nError: HubSpot access token is required", '@hubspot/mcp-server', '0.1.0');
  assert.match(env.message, /asking for configuration: “HubSpot access token is required”/);
  assert.match(env.fix, /--env NAME=dummy/);
  assert.equal(env.confidence, 'unsure');
  assert.match(failureAdvice('needs-env', 'Error: FX_API_KEY is not set', 'fx', '1.0.0').fix, /--env FX_API_KEY=dummy/);
  const missing = failureAdvice('crashed', "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pkce-challenge' imported from /x/index.js", 'chrome-devtools-mcp', '1.10.0');
  assert.match(missing.message, /imports pkce-challenge, and npm didn't install that with it/);
  assert.match(failureAdvice('no-bin', '', 'fx', '1.0.0').fix, /--cmd/);
  assert.equal(failureAdvice('install-failed', 'npm ERR! 404', 'fx', '9.9.9').confidence, undefined);
});

test('history: the report shows each failure with its next step, in text and markdown', () => {
  const h = {
    package: 'fx-mcp',
    installedAt: '2026-09-30T00:00:00Z',
    totalVersions: 3,
    rows: [
      { version: '1.0.0', status: 'failed', reason: 'needs-env', error: 'Error: FX_API_KEY is not set', ...failureAdvice('needs-env', 'Error: FX_API_KEY is not set', 'fx-mcp', '1.0.0') },
      { version: '1.1.0', status: 'ok', protocolVersion: '2025-11-25', tools: 2, tokens: 100, counts: { error: 0, warn: 0, info: 0 } },
    ],
  };
  const text = formatHistory(h, 'text', 'out', 'h.csv');
  assert.match(text, /Failed \(1 of 2\):\n {2}1\.0\.0 {2}needs-env · unsure\n.*asking for configuration.*\n.*→ Next: Pass it: --env FX_API_KEY=dummy/);
  assert.match(text, /^! 1 of 2 versions inspected · 1 failed \(1 needs-env\)$/m, 'no "no breaking changes" with one version to compare');
  assert.match(text, /menus and history\.json in out · CSV in h\.csv/);
  const md = formatHistory(h, 'markdown', 'out');
  assert.match(md, /^\| 1\.0\.0 \| {2}\| \*\*failed: needs-env\*\* \|/m);
  assert.match(md, /- `1\.0\.0` · needs-env · _unsure_: .*<br>\*\*→ Next:\*\* Pass it/);
  const json = JSON.parse(formatHistory(h, 'json', 'out', 'h.csv'));
  assert.deepEqual(json.written, { dir: 'out', csv: 'h.csv' });
  assert.equal(json.rows[0].reason, 'needs-env', 'the fields it had are kept');
});

test('help: every option any help names is one the CLI parses, and every parsed option is in some help', async () => {
  const { CLI_OPTIONS } = await import('../dist/options.js');
  const parsed = new Set(Object.keys(CLI_OPTIONS));
  const texts = [overview(), ...COMMANDS.map((c) => commandHelp(c))];
  // --arg=--flag is how a server's own flag is passed, not a toolmenu option.
  const named = new Set(texts.flatMap((t) => [...t.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1])).filter((n) => n !== 'flag'));
  for (const n of named) assert.ok(parsed.has(n), `help names --${n}, which the CLI doesn't parse`);
  for (const p of parsed) assert.ok(named.has(p), `the CLI parses --${p}, which no help names`);
});

test('history: versions failing the same install-failed or no-bin way are one entry, whatever their version', () => {
  const versions = ['0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0', '0.10.0', '0.11.0'];
  const npm = (v) => `npm error code ETARGET\nnpm error notarget No matching version found for left-pad@^9 (needed by fx-mcp@${v}).`;
  const rows = [
    ...versions.map((v) => ({ version: v, status: 'failed', reason: 'install-failed', error: npm(v), ...failureAdvice('install-failed', npm(v), 'fx-mcp', v) })),
    ...['1.0.0', '1.1.0'].map((v) => ({ version: v, status: 'failed', reason: 'no-bin', error: 'no bin', ...failureAdvice('no-bin', 'no bin', 'fx-mcp', v) })),
  ];
  const h = { package: 'fx-mcp', installedAt: '2026-09-30T00:00:00Z', totalVersions: rows.length, rows };
  const text = formatHistory(h, 'text', 'out');
  assert.match(text, /^ {2}0\.2\.0, 0\.3\.0 … 0\.11\.0 \(10 versions\) {2}install-failed$/m);
  assert.match(text, /^ {2}1\.0\.0, 1\.1\.0 {2}no-bin$/m);
  assert.equal(text.match(/install-failed$/gm).length, 1, text);
  assert.match(text, /npm couldn't install fx-mcp@<version>/, 'a grouped entry names no one version');
  assert.doesNotMatch(text, /fx-mcp@0\.2\.0/);
  const md = formatHistory(h, 'markdown', 'out');
  assert.equal(md.match(/· install-failed/g).length, 1);
});
