import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareMenus } from '../dist/compare.js';
import { changeFindings, clip, MAX_UNLOCKS, mergeRepeats, parseScenario, scopeOf, session, starterScenario, unlockers, unlockListers, valuesFromListing } from '../dist/session.js';
import { autoScenario, autoSummary } from '../dist/auto.js';
import { parse as parseYaml } from 'yaml';
import { FIXTURES, ROOT, menuOf, run, tempDir, TIMEOUT_MS, tool } from './helpers.mjs';
import { start as startSdkHttp } from './fixtures/http-server.mjs';
import { start as startRawHttp } from './fixtures/raw-http-server.mjs';
import { start as startDomains } from './fixtures/domains-http-server.mjs';
import { probeMenu } from '../dist/probe.js';
import { formatSession } from '../dist/report.js';
import { build } from './fixtures/session-server.mjs';
import { build as buildRateLimited } from './fixtures/rate-limit-tools.mjs';
import { RATE_LIMITED, serverWords, waitsFrom } from '../dist/failures.js';

const stdio = (env = {}) => ({ kind: 'stdio', command: process.execPath, args: [join(FIXTURES, 'session-server.mjs')], env });
const UNLOCK = parseScenario({
  steps: [
    'list',
    { call: 'search_forms', args: { query: 'onboarding' } },
    { call: 'unlock_toolset', args: { toolset: 'audits' } },
    { call: 'unlock_toolset', args: { toolset: 'reports' } },
    { call: 'touch_descriptions' },
    'list',
    { call: 'delete_form', args: { form_id: 'f_1' } },
  ],
});
const byStep = (result) => result.findings.map((f) => `${f.step}:${f.rule}`);

test('parseScenario accepts the three step kinds and rejects mistakes', () => {
  const s = parseScenario({ allow_writes: true, steps: ['list', { list: true }, { call: 'x', args: { a: 1 } }, { wait_for: 'tools_list_changed', timeout_ms: 100 }] });
  assert.equal(s.allowWrites, true);
  assert.deepEqual(s.steps.map((x) => x.kind), ['list', 'list', 'call', 'wait_for']);
  assert.equal(s.steps[3].timeoutMs, 100);
  assert.equal(parseScenario({ steps: [{ wait_for: 'tools_list_changed' }] }).steps[0].timeoutMs, 5000);
  assert.throws(() => parseScenario({}), /at least one step/);
  assert.throws(() => parseScenario({ steps: ['dance'] }), /step 1: expected/);
  assert.throws(() => parseScenario({ steps: [{ call: '' }] }), /needs a tool name/);
  assert.throws(() => parseScenario({ steps: [{ call: 'x', args: [1] }] }), /must be a map/);
  assert.throws(() => parseScenario({ steps: [{ wait_for: 'sunrise' }] }), /tools_list_changed/);
  assert.throws(() => parseScenario({ allow_writes: 'yes', steps: ['list'] }), /allow_writes/);
});

test('changeFindings: append is a warning (tools come first in the prompt), everything else an error with its cost', () => {
  const base = menuOf([tool('a'), tool('b'), tool('c')]).tools;
  const find = (after) => changeFindings(base, after, compareMenus(base, after), 3);

  const appended = find(menuOf([tool('a'), tool('b'), tool('c'), tool('d')]).tools);
  assert.deepEqual(appended.map((f) => f.rule), ['session/append']);
  assert.equal(appended[0].severity, 'warn');
  assert.match(appended[0].message, /end of the tool list isn't the end of the prompt/);
  assert.match(appended[0].message, /tool search/);

  const inserted = find(menuOf([tool('a'), tool('x'), tool('b'), tool('c')]).tools);
  assert.deepEqual(inserted.map((f) => f.rule), ['session/mid-insert']);
  assert.match(inserted[0].message, /position 1 \(x\)/);
  assert.match(inserted[0].detail[0], /^cost: the whole tool list \(this server's part: ~\d+ tokens, estimate\) .*; the change starts at position 1$/);

  assert.deepEqual(find(menuOf([tool('b'), tool('a'), tool('c')]).tools).map((f) => f.rule), ['session/reorder']);
  assert.deepEqual(find(menuOf([tool('a'), tool('c')]).tools).map((f) => f.rule), ['session/remove']);
  const edited = find(menuOf([tool('a'), tool('b', [], { description: 'new' }), tool('c')]).tools);
  assert.deepEqual(edited.map((f) => `${f.rule}:${f.tool}`), ['session/edit:b']);
  assert.ok(edited.every((f) => f.step === 3));
});

test('scopeOf: does a fresh connection see this step\'s changes?', () => {
  const before = menuOf([tool('a'), tool('b')]).tools;
  const after = menuOf([tool('a'), tool('x'), tool('b')]).tools;
  const changes = compareMenus(before, after);
  assert.equal(scopeOf(changes, after, after, 'http'), 'global');
  assert.equal(scopeOf(changes, after, before, 'http'), 'connection-local');
  assert.equal(scopeOf(changes, after, before, 'stdio'), 'per-process');
  assert.equal(scopeOf(compareMenus(before, [before[1], before[0]]), [before[1], before[0]], before, 'http'), 'unclear', 'a reorder alone can\'t tell');
});

test('session over stdio (2026-07-28): each change is pinned to the step that caused it', async () => {
  const r = await session(stdio(), UNLOCK, { timeoutMs: TIMEOUT_MS });
  assert.equal(r.server.protocolVersion, '2026-07-28');
  assert.equal(r.listening, true);
  assert.equal(r.connectionCheck, 'same');
  assert.deepEqual(byStep(r), [
    '3:session/mid-insert',
    '3:session/side-effect',
    '4:session/append',
    '5:session/edit',
    '7:session/refused',
  ]);
  assert.match(r.findings.find((f) => f.rule === 'session/side-effect').message, /^Steps 3, 4, 5: /);
  assert.deepEqual(r.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'refused']);
  assert.deepEqual(r.steps.map((s) => s.changed), [false, false, true, true, true, false, false]);
  assert.ok(r.steps[2].listChanged > 0, 'list_changed arrived on the subscriptions/listen stream');
  assert.equal(r.steps[2].scope, 'per-process');
  assert.equal(r.final.tools, 8);
});

test('session: a server that holds a lock still gets its report, with the scope left unchecked', async () => {
  const lock = join(tempDir(), 'db.lock');
  const r = await session(stdio({ LOCKFILE: lock }), UNLOCK, { timeoutMs: TIMEOUT_MS });
  assert.deepEqual(byStep(r).filter((f) => f !== '3:session/scope-unchecked'), ['0:menu/process-variance', '3:session/mid-insert', '4:session/append', '5:session/edit', '7:session/refused']);
  const unchecked = r.findings.filter((f) => f.rule === 'session/scope-unchecked');
  assert.equal(unchecked.length, 1, 'said once for the run');
  assert.equal(unchecked[0].severity, 'info');
  assert.match(unchecked[0].message, /steps 3, 4, 5/);
  assert.equal(r.steps[2].scope, 'unclear');
  // The second process couldn't start before the first steps either.
  assert.ok(r.findings.some((f) => f.rule === 'menu/process-variance' && f.severity === 'info'));
});

test('session over stdio (2025 protocol): cache findings, but no 2026-07-28 side-effect rule', async () => {
  const r = await session(stdio({ LEGACY: '1' }), UNLOCK, { timeoutMs: TIMEOUT_MS });
  assert.equal(r.server.protocolVersion, '2025-11-25');
  assert.deepEqual(byStep(r), ['3:session/mid-insert', '4:session/append', '5:session/edit', '7:session/refused']);
});

test('allow_writes lets the scenario call a destructive tool', async () => {
  const r = await session(stdio(), parseScenario({ allow_writes: true, steps: [{ call: 'delete_form', args: { form_id: 'f_1', dry_run: true } }] }), { timeoutMs: TIMEOUT_MS });
  assert.deepEqual(byStep(r), []);
  assert.equal(r.steps[0].status, 'ok');
});

test('a tool that returns an error is a warning, not a clean step', async () => {
  const r = await session(stdio(), parseScenario({ steps: [{ call: 'get_form', args: { form_id: 'broken' } }, { call: 'get_form', args: { form_id: 'f_1' } }] }), { timeoutMs: TIMEOUT_MS });
  assert.deepEqual(byStep(r), ['1:session/tool-error']);
  assert.equal(r.findings[0].severity, 'warn');
  assert.match(r.findings[0].message, /The form definition is corrupt/);
});

test('calls that fail on credentials are one session/untested finding: warn if some got through, error if none did', async () => {
  const some = await session(stdio(), parseScenario({ steps: [{ call: 'get_form', args: { form_id: 'expired' } }, { call: 'get_form', args: { form_id: 'f_1' } }] }), { timeoutMs: TIMEOUT_MS });
  assert.deepEqual(byStep(some), ['undefined:session/untested']);
  assert.equal(some.findings[0].severity, 'warn');
  assert.match(some.findings[0].message, /^1 of 2 tool calls failed before reaching the tool: 1 on authentication/);
  assert.equal(some.steps[0].failure, 'auth');
  assert.match(some.findings[0].fix, /rerun with real ones \(--env KEY=…\)/);
  assert.equal(some.findings[0].confidence, 'unsure');
  const none = await session(stdio(), parseScenario({ steps: [{ call: 'get_form', args: { form_id: 'expired' } }] }), { timeoutMs: TIMEOUT_MS });
  assert.equal(none.findings.find((f) => f.rule === 'session/untested').severity, 'error');
  assert.match(none.findings[0].message, /^All 1 tool calls failed/);
});

test('clip: never splits a character, drops a server\'s broken tail', () => {
  assert.equal(clip('short', 120), 'short');
  const long = '401 Unauthorized: the token for this workspace has expired, please sign in again and retry the request 😀😀😀 later on';
  const c = clip(long, 60);
  assert.ok(Array.from(c).length <= 60);
  assert.ok(c.endsWith('…'));
  assert.doesNotMatch(c, /�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.equal(clip('401 Unauthori�', 120), '401 Unauthori');
  const emoji = clip('😀'.repeat(200), 10);
  assert.equal(emoji, '😀'.repeat(9) + '…');
});

test('a tool that isn\'t in the menu yet fails its step', async () => {
  const r = await session(stdio(), parseScenario({ steps: [{ call: 'list_team_audits', args: { team: 't' } }] }), { timeoutMs: TIMEOUT_MS });
  assert.deepEqual(byStep(r), ['1:session/step-failed']);
});

test('http, SDK server with shared state: global change, and no list_changed', async () => {
  const shared = {};
  const server = await startSdkHttp({ factory: () => build(shared) });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: TIMEOUT_MS });
    assert.equal(r.steps[0].scope, 'global');
    assert.deepEqual(byStep(r), ['1:session/mid-insert', '1:session/unannounced', '1:session/unlock-coverage']);
  } finally {
    await server.close();
  }
});

test('http, rate limit: a limit that clears is waited out; one that stays is one finding, and the run stops', async () => {
  const steps = ['list', { call: 'unlock_toolset', args: { toolset: 'audits' } }, { call: 'unlock_toolset', args: { toolset: 'reports' } }, 'list'];
  // One state for every connection to a server: an unlock changes the menu for all
  // of them, so the scope probe after it runs.
  const sharedState = (state = {}) => () => build(state);
  const clean = await startSdkHttp({ factory: sharedState() });
  let expected, total;
  try {
    expected = byStep(await session({ kind: 'http', url: clean.url }, parseScenario({ steps }), { timeoutMs: TIMEOUT_MS }));
    total = clean.seen.posts;
  } finally {
    await clean.close();
  }
  // Each limit trips at a different request: connecting, the second connection that
  // compares menus, a call, a listing, the scope probe after an unlock.
  for (let limit = 0; limit < total; limit++) {
    const clears = await startSdkHttp({ factory: sharedState(), limit, resetAfterMs: 100 });
    try {
      const r = await session({ kind: 'http', url: clears.url }, parseScenario({ steps }), { timeoutMs: TIMEOUT_MS, rateLimitWaitsMs: [150, 300] });
      assert.ok(clears.seen.refused > 0, `limit ${limit}`);
      assert.deepEqual(byStep(r), expected, `limit ${limit}: refused requests sent again, the same run as with no limit`);
    } finally {
      await clears.close();
    }
  }
  // It trips on step 3, the second unlock: the "reports" value isn't also unlock-coverage.
  const stays = await startSdkHttp({ factory: () => build({}), limit: 8 });
  try {
    const r = await session({ kind: 'http', url: stays.url }, parseScenario({ steps }), { timeoutMs: TIMEOUT_MS, rateLimitWaitsMs: [20, 40] });
    const limited = r.findings.filter((f) => f.rule === 'session/rate-limited');
    assert.equal(limited.length, 1);
    assert.equal(limited[0].severity, 'error');
    assert.match(limited[0].message, /^Rate-limited at step 3, and still after waiting 0\.1 s: “Too many requests, please try again later\.” Steps 3–4 weren't checked\./);
    assert.equal(r.steps[2].note, 'rate-limited');
    assert.equal(r.findings.filter((f) => f.rule === 'session/step-failed' || f.rule === 'session/unlock-coverage').length, 0);
    assert.equal(r.steps.length, 3, 'nothing is sent after the limit stops the run');
    assert.equal(stays.seen.refused, 3, 'the first try and two retries, then no more');
  } finally {
    await stays.close();
  }
});

test('http, rate limit: a tool that says it was limited is called again only if it is read-only', async () => {
  // Where no wait is expected, the waits are a minute long: a retry would show as a
  // run that long, while a run on a busy machine can take far more than 300 ms
  // without ever waiting (a 300 ms bound failed under load).
  const NO_WAIT = [60_000, 60_000];
  const one = async (name, waits = [300, 300]) => {
    const ran = {};
    const server = await startSdkHttp({ factory: () => buildRateLimited(ran) });
    try {
      const started = Date.now();
      const r = await session({ kind: 'http', url: server.url }, parseScenario({ allow_writes: true, steps: [{ call: name, args: {} }, 'list'] }), { timeoutMs: TIMEOUT_MS, rateLimitWaitsMs: waits });
      return { ran: ran[name], ms: Date.now() - started, rules: byStep(r), limited: r.findings.find((f) => f.rule === 'session/rate-limited') };
    } finally {
      await server.close();
    }
  };
  // A write that did its work, then threw "rate limit exceeded" (JSON-RPC -32603, no 429): once.
  const thrown = await one('send_message');
  assert.equal(thrown.ran, 1);
  assert.deepEqual(thrown.rules, ['1:session/rate-limited']);
  assert.match(thrown.limited.message, /^Rate-limited at step 1: send_message said “Upstream API rate limit exceeded”\. Not called again: it isn't marked readOnlyHint/);
  // Its result says so: once too, and the finding claims no wait.
  const said = await one('post_comment', NO_WAIT);
  assert.equal(said.ran, 1);
  assert.doesNotMatch(said.limited.message, /waited/);
  assert.ok(said.ms < NO_WAIT[0], `no wait: ${said.ms} ms`);
  // Read-only, limited twice then fine: waited out.
  const reads = await one('list_items');
  assert.equal(reads.ran, 3);
  assert.deepEqual(reads.rules, []);
  // Errors that only mention a 429 or a rateLimit: no wait, not a rate limit.
  for (const name of ['get_order', 'set_quota']) {
    const r = await one(name, NO_WAIT);
    assert.equal(r.ran, 1, name);
    assert.equal(r.limited, undefined, name);
    assert.ok(r.ms < NO_WAIT[0], `${name}: ${r.ms} ms`);
  }
});

test('TOOLMENU_RATE_LIMIT_WAITS_MS: a list of milliseconds, or the defaults (a typo never turns the waiting off)', () => {
  assert.deepEqual(waitsFrom('100,200'), [100, 200]);
  assert.deepEqual(waitsFrom(' 0 , 50 '), [0, 50]);
  for (const bad of [undefined, '', 'abc', '100,abc', '100,', '-5', '1.5', '1e3']) assert.equal(waitsFrom(bad), undefined, String(bad));
});

test('serverWords: the server\'s message, not the transport\'s wrapping of its body', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests \u2014 retry later' }, id: null });
  assert.equal(serverWords(new Error(`Error POSTing to endpoint: ${body}`)), 'Too many requests — retry later');
  assert.equal(serverWords(new Error(`Error POSTing to endpoint (HTTP 429): ${body}`)), 'Too many requests — retry later');
  assert.equal(serverWords(new Error('Error POSTing to endpoint: Too many requests, please try again later.')), 'Too many requests, please try again later.');
  assert.equal(serverWords('MCP error -32602: Invalid params\nat line 2'), 'MCP error -32602: Invalid params');
  assert.equal(serverWords('x'.repeat(150)).length, 100);
});

test('RATE_LIMITED: the words for a refusal, not every 429 or rateLimit', () => {
  for (const t of ['Too many requests, please try again later.', 'API rate limit exceeded for 1.2.3.4', 'Rate limit reached for requests', 'You are being rate-limited', 'You have exceeded your rate limit', 'Request failed with status code 429', 'HTTP 429 Too Many Requests', 'rate_limit_exceeded']) assert.ok(RATE_LIMITED.test(t), t);
  for (const t of ['Order 429 not found', 'rateLimit must be a positive number', 'Invalid rate_limit parameter', 'Item 1429 is archived', 'Set the rate limit in settings']) assert.ok(!RATE_LIMITED.test(t), t);
});

test('http, rate limit: a connection refused throughout is said so, not the transport error', async () => {
  const server = await startSdkHttp({ limit: 0 });
  try {
    await assert.rejects(session({ kind: 'http', url: server.url }, parseScenario({ steps: ['list'] }), { timeoutMs: TIMEOUT_MS, rateLimitWaitsMs: [20, 40] }), /Rate-limited while connecting, and still after waiting 0\.1 s: “Too many requests, please try again later\.” The limit counts/);
  } finally {
    await server.close();
  }
});

test('http, SDK server with per-instance state: the unlock silently does nothing', async () => {
  const server = await startSdkHttp({ factory: () => build() });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: TIMEOUT_MS });
    assert.equal(r.steps[0].changed, false);
    // Nothing changed; only the other toolset was never tried.
    assert.deepEqual(byStep(r), ['1:session/unlock-coverage']);
  } finally {
    await server.close();
  }
});

test('http with sessions: a change only this connection sees is connection-local', async () => {
  const server = await startRawHttp({ scope: 'local' });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset' }] }), { timeoutMs: TIMEOUT_MS });
    assert.equal(r.steps[0].scope, 'connection-local');
    assert.deepEqual(byStep(r), ['1:session/mid-insert', '1:session/connection-local']);
    assert.equal(r.findings[1].severity, 'info', '2025-era: allowed, but noted');
  } finally {
    await server.close();
  }
});

test('http: a 2025 server is probed with server/discover once per run, not once per connection', async () => {
  const server = await startRawHttp({ scope: 'local' });
  try {
    const r = await run(['session', '--auto', server.url]);
    assert.ok(r.code <= 1, r.stderr);
    assert.equal(server.discovers(), 1);
  } finally {
    await server.close();
  }
});

test('http with sessions: a global change is global', async () => {
  const server = await startRawHttp({ scope: 'global' });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset' }] }), { timeoutMs: TIMEOUT_MS });
    assert.equal(r.steps[0].scope, 'global');
    assert.deepEqual(byStep(r), ['1:session/mid-insert']);
  } finally {
    await server.close();
  }
});

test('http: menus that differ per connection are caught before the first step', async () => {
  const server = await startRawHttp({ vary: true });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: ['list'] }), { timeoutMs: TIMEOUT_MS });
    assert.equal(r.connectionCheck, 'different');
    assert.deepEqual(byStep(r), ['0:menu/connection-variance']);
  } finally {
    await server.close();
  }
});

test('cli: session output, --plan and usage errors', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'bad.yml'), 'steps: [dance]\n');
  const scenario = join(ROOT, 'examples/unlock.scenario.yml');
  const server = ['--', process.execPath, join(FIXTURES, 'session-server.mjs')];

  const r = await run(['session', '--scenario', scenario, ...server], { cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /^step 3: call unlock_toolset \{"toolset":"audits"\} · answered · menu changed · \+2 tools · list_changed received · scope: per-process$/m);
  assert.match(r.stdout, /ERROR  session\/mid-insert\n\s+\+2 tools inserted at position 1 \(list_team_audits, get_team_audit\)/);
  assert.match(r.stdout, /cost: the whole tool list \(this server's part: ~\d+ tokens, estimate\) and the conversation after it; the change starts at position 1/);

  const gh = await run(['session', '--format', 'github', '--scenario', scenario, ...server], { cwd: dir });
  assert.match(gh.stdout, /^::error title=toolmenu session\/mid-insert::step 3 \(call unlock_toolset/m);

  const plan = await run(['session', '--plan', '--scenario', scenario], { cwd: dir });
  assert.equal(plan.code, 0);
  assert.match(plan.stdout, /Nothing was run/);

  assert.equal((await run(['session', ...server], { cwd: dir })).code, 2, 'no --scenario');
  const bad = await run(['session', '--scenario', 'bad.yml', ...server], { cwd: dir });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /step 1: expected/);
});

test('starterScenario: runnable as written, and it unlocks for real', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const menu = menuOf([
    tool('list_forms', [], ro),
    tool('get_form', ['form_id'], ro),
    tool('get_my_scope_ids', [], ro),
    tool('unlock_toolset', [], { ...ro, inputSchema: { type: 'object', properties: { toolset: { type: 'string', enum: ['audits', 'reports'] } }, required: ['toolset'] } }),
    tool('delete_form', ['form_id'], { annotations: { destructiveHint: true } }),
  ], { name: 'fx', version: '1.0.0' });
  const yaml = starterScenario(menu);
  const scenario = parseScenario(parseYaml(yaml));
  assert.equal(scenario.allowWrites, false);
  assert.deepEqual(scenario.steps.map((s) => (s.kind === 'call' ? `${s.tool}${s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : ''}` : s.kind)), [
    'list', 'list_forms', 'get_my_scope_ids',
    'unlock_toolset{"toolset":"audits"}', 'list', 'unlock_toolset{"toolset":"reports"}', 'list', 'unlock_toolset{"toolset":"audits"}', 'list',
    'list_forms', 'list',
  ]);
  assert.doesNotMatch(yaml, /could change the menu/, '"scope" in a name is not an unlock');
  assert.match(yaml, /# - call: get_form\n  # {3}args: \{ form_id: TODO \}/);
  assert.doesNotMatch(yaml, /delete_form/, 'write tools are never suggested');
});

test('starterScenario: an optional domains array is the unlock argument', () => {
  const menu = menuOf([
    tool('search_capabilities', [], {
      description: 'Shows what the server can do. Pass domains to unlock their tools.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { domains: { type: 'array', items: { type: 'string', enum: ['tasks', 'content'] } }, query: { type: 'string' } } },
    }),
    tool('list_forms', [], { annotations: { readOnlyHint: true } }),
  ]);
  const steps = parseScenario(parseYaml(starterScenario(menu))).steps.filter((s) => s.kind === 'call').map((s) => `${s.tool}${s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : ''}`);
  assert.deepEqual(steps, ['list_forms', 'search_capabilities{"domains":["tasks"]}', 'search_capabilities{"domains":["content"]}', 'search_capabilities{"domains":["tasks"]}', 'list_forms']);
});

test('cli: session --init writes a scenario and never overwrites', async () => {
  const dir = tempDir();
  const server = ['--', process.execPath, join(FIXTURES, 'session-server.mjs')];
  const r = await run(['session', '--init', ...server], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /wrote scenario\.yml/);
  const again = await run(['session', '--init', ...server], { cwd: dir });
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already exists/);
  const s = await run(['session', '--scenario', 'scenario.yml', ...server], { cwd: dir });
  assert.match(s.stdout, /session\/edit/, 'the starter scenario alone catches the description rewrite');
});

test('unlockers: a search filter named category is not an unlock; with an unlock signal it is (FINDINGS F12)', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const categories = { type: 'array', items: { type: 'string', enum: ['github', 'research', 'pdf'] } };
  const search = tool('firecrawl_search', [], { ...ro, description: 'Search the web.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, categories } } });
  assert.deepEqual(unlockers([search]).map((u) => u.tool.name), []);
  const enable = tool('enable_category', [], { ...ro, description: 'Enable more tools.', inputSchema: { type: 'object', properties: { category: { type: 'string', enum: ['audits'] } } } });
  assert.deepEqual(unlockers([enable]).map((u) => [u.tool.name, u.param]), [['enable_category', 'category']]);
});

test('unlockers: a description about loading tools backs a weak parameter; one that only mentions a word doesn\'t', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const withParam = (name, description, param) =>
    tool(name, [], { ...ro, description, inputSchema: { type: 'object', properties: { [param]: { type: 'string', enum: ['a', 'b'] } }, required: [param] } });
  const found = (t) => unlockers([t]).map((u) => `${u.tool.name}:${u.param ?? '-'}`);
  // Only the description says it: nothing in the name.
  assert.deepEqual(found(withParam('switch_mode', 'Adds the tools for one group to the menu.', 'group')), ['switch_mode:group']);
  assert.deepEqual(found(withParam('set_scope', 'Enables more capabilities for a module.', 'module')), ['set_scope:module']);
  // A word inside another word, or a device's capabilities, isn't an unlock.
  assert.deepEqual(found(withParam('get_report', 'Downloads reports generated by the analytics tools.', 'module')), []);
  assert.deepEqual(found(withParam('get_device', "Returns the device's capabilities and status.", 'feature')), []);
});

test('unlockers: a namespace on an ordinary read is not an unlock (Kubernetes, Pinecone)', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const ns = { type: 'object', properties: { namespace: { type: 'string', enum: ['default', 'kube-system'] } }, required: ['namespace'] };
  assert.deepEqual(unlockers([tool('pods_list', [], { ...ro, description: 'List pods in a namespace.', inputSchema: ns })]), []);
  const loader = tool('load_namespace', [], { ...ro, description: 'Loads the tools in one namespace.', inputSchema: ns });
  assert.deepEqual(unlockers([loader]).map((u) => u.param), ['namespace']);
});

// Meta-tools as the live servers served them (2026-09-29): github-mcp-server 1.0.5
// --dynamic-toolsets, and toolception 0.6.3 in DYNAMIC mode. Descriptions trimmed.
const toolsets = { type: 'string', enum: ['actions', 'code_security', 'issues'] };
const GITHUB_DYNAMIC = [
  { name: 'enable_toolset', description: 'Enable one of the sets of tools the GitHub MCP server provides, use get_toolset_tools and list_available_toolsets first to see what this will enable', inputSchema: { type: 'object', properties: { toolset: toolsets }, required: ['toolset'] }, annotations: { readOnlyHint: true } },
  { name: 'get_toolset_tools', description: 'Lists all the capabilities that are enabled with the specified toolset, use this to get clarity on whether enabling a toolset would help you to complete a task', inputSchema: { type: 'object', properties: { toolset: toolsets }, required: ['toolset'] }, annotations: { readOnlyHint: true } },
  { name: 'list_available_toolsets', description: 'List all available toolsets this GitHub MCP server can offer, providing the enabled status of each.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];
const byName = { type: 'object', properties: { name: { type: 'string', description: 'Toolset name' } }, required: ['name'] };
const TOOLCEPTION = [
  { name: 'enable_toolset', description: 'Enable a toolset by name', inputSchema: byName, annotations: { destructiveHint: true, idempotentHint: true } },
  { name: 'disable_toolset', description: 'Disable a toolset by name (state only)', inputSchema: byName, annotations: { destructiveHint: true, idempotentHint: true } },
  { name: 'list_toolsets', description: 'List available toolsets with active status and definitions', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'describe_toolset', description: 'Describe a toolset with definition, active status and tools', inputSchema: byName, annotations: { readOnlyHint: true } },
];

test('unlockers on live meta-tools: the unlock, not the lookups that talk about toolsets', () => {
  const found = (tools) => unlockers(menuOf(tools).tools).map((u) => `${u.tool.name}:${u.param ?? '-'}`);
  assert.deepEqual(found(GITHUB_DYNAMIC), ['enable_toolset:toolset']);
  assert.deepEqual(found(TOOLCEPTION), ['enable_toolset:name', 'disable_toolset:name']);
  // Firecrawl 3.25.5's catalog browser takes `capabilities`, and unlocks nothing.
  const findTools = tool('firecrawl_find_tools', [], { annotations: { readOnlyHint: true }, description: 'Browse Alexandria data providers and workflows or read a selected contract.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } } } } });
  assert.deepEqual(found([findTools]), []);
  // A lookup that says outright it loads tools is still one.
  const loader = tool('get_tools', [], { annotations: { readOnlyHint: true }, description: 'Loads the tools for one category into the menu.', inputSchema: { type: 'object', properties: { category: { type: 'string', enum: ['a', 'b'] } }, required: ['category'] } });
  assert.deepEqual(found([loader]), ['get_tools:category']);
});

test('starterScenario: an unlock annotated destructive is suggested, never called', () => {
  const yaml = starterScenario(menuOf(TOOLCEPTION, { name: 'toolception-demo' }));
  assert.match(yaml, /# \(not marked readOnlyHint: needs allow_writes: true\)\n {2}# - call: enable_toolset\n {2}# {3}args: \{ name: TODO \}/);
  const calls = parseScenario(parseYaml(yaml)).steps.filter((s) => s.kind === 'call').map((s) => s.tool);
  assert.ok(!calls.includes('enable_toolset') && !calls.includes('disable_toolset'), calls.join(', '));
  // The GitHub lookups are lookups, not a second unlock block.
  const github = starterScenario(menuOf(GITHUB_DYNAMIC, { name: 'github-mcp-server' }));
  assert.equal((github.match(/looks like it unlocks tools/g) ?? []).length, 1);
  assert.match(github, /# Read-only tools that need arguments:\n {2}# - call: get_toolset_tools/);
});

test('starterScenario and --auto unlock every value, so the union holds the tools behind each (GitHub: 19 toolsets, 81 tools)', () => {
  const many = { type: 'string', enum: Array.from({ length: 19 }, (_, i) => `set_${i}`) };
  const menu = menuOf([{ ...GITHUB_DYNAMIC[0], inputSchema: { type: 'object', properties: { toolset: many }, required: ['toolset'] } }, GITHUB_DYNAMIC[2]]);
  const calls = (yaml) => parseScenario(parseYaml(yaml)).steps.filter((s) => s.kind === 'call' && s.tool === 'enable_toolset').map((s) => s.args.toolset);
  // Every value once, then the first again.
  assert.deepEqual(calls(starterScenario(menu)), [...many.enum, 'set_0']);
  const auto = autoScenario(menu).scenario.steps.filter((s) => s.kind === 'call' && s.tool === 'enable_toolset').map((s) => s.args.toolset);
  // Every value, then the first again (a second identical unlock should change nothing), as --init does.
  assert.deepEqual(auto, [...many.enum, 'set_0'], 'outside the call budget');
  assert.equal(autoScenario(menu, { maxCalls: 1 }).scenario.steps.filter((s) => s.tool === 'enable_toolset').length, 20);
  // A long enum is capped, and the rest named.
  const huge = { type: 'string', enum: Array.from({ length: MAX_UNLOCKS + 3 }, (_, i) => `v${i}`) };
  const capped = starterScenario(menuOf([{ ...GITHUB_DYNAMIC[0], inputSchema: { type: 'object', properties: { toolset: huge }, required: ['toolset'] } }]));
  assert.equal(calls(capped).length, MAX_UNLOCKS + 1);
  assert.match(capped, /…and 3 more: "v50", "v51", "v52"/);
});

test('unlock values without an enum come from the server\'s own listing (toolception)', () => {
  assert.deepEqual(unlockListers(menuOf(TOOLCEPTION).tools), [
    { unlock: 'enable_toolset', lister: 'list_toolsets' },
    { unlock: 'disable_toolset', lister: 'list_toolsets' },
  ]);
  // What list_toolsets returned, live: the item's key, not its display name.
  const listing = { content: [{ type: 'text', text: JSON.stringify({ toolsets: [{ key: 'quotes', active: false, definition: { name: 'Quotes', modules: ['quotes'] }, tools: [] }, { key: 'news', active: false, definition: { name: 'News' }, tools: [] }] }) }] };
  assert.deepEqual(valuesFromListing(listing), ['quotes', 'news']);
  assert.deepEqual(valuesFromListing({ structuredContent: { toolsets: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(valuesFromListing({ content: [{ type: 'text', text: 'no JSON here' }] }), []);
  const yaml = starterScenario(menuOf(TOOLCEPTION), { values: { enable_toolset: ['quotes', 'news'] } });
  assert.match(yaml, /# - call: enable_toolset\n {2}# {3}args: \{ name: "quotes" \}\n {2}# - list\n {2}# - call: enable_toolset\n {2}# {3}args: \{ name: "news" \}/);
});

test('--auto: calling nothing is a warning that says why; an unlock skipped as open world is a coverage gap', async () => {
  // Every tool calls an outside service (openWorldHint), like the reporter's server.
  const ow = { readOnlyHint: true, openWorldHint: true };
  const search = tool('search_web', [], { annotations: ow, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } });
  const fetchPage = tool('fetch_page', [], { annotations: ow, inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } });
  const plan = autoScenario(menuOf([search, fetchPage]));
  assert.deepEqual(plan.called, []);
  // The session fixture's own menu doesn't matter: what counts is the plan it was given.
  const r = await session(stdio(), plan.scenario, { timeoutMs: TIMEOUT_MS, processes: 1, auto: { called: plan.called, skipped: plan.skipped } });
  const nothing = r.findings.find((f) => f.rule === 'session/nothing-called');
  assert.equal(nothing?.severity, 'warn');
  assert.match(nothing.message, /--auto called no tools: 2 marked openWorldHint \(they may cost API credits\)/);
  assert.match(nothing.fix, /^Rerun with --open-world/);
});

test('--auto: one skipped tool is counted in the singular', async () => {
  const unmarked = tool('search_docs', []);
  const needs = tool('get_page', [], { annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] } });
  const web = tool('search_web', [], { annotations: { readOnlyHint: true, openWorldHint: true } });
  const plan = autoScenario(menuOf([unmarked, needs, web]));
  const r = await session(stdio(), plan.scenario, { timeoutMs: TIMEOUT_MS, processes: 1, auto: { called: plan.called, skipped: plan.skipped } });
  const nothing = r.findings.find((f) => f.rule === 'session/nothing-called');
  assert.match(nothing.message, /--auto called no tools: 1 needs values the schema doesn't give; 1 isn't marked readOnlyHint; 1 marked openWorldHint \(it may cost API credits\)\./);
  const header = autoSummary({ called: plan.called, skipped: plan.skipped }).join('\n');
  assert.match(header, /1 needs values the schema doesn't give/);
});

test('--auto: a read-only unlock runs even when marked openWorldHint, every value then the first again', () => {
  // The reporter's server marks every tool openWorldHint: true, its unlock too.
  const unlock = tool('enable_domains', [], { annotations: { readOnlyHint: true, openWorldHint: true }, description: 'Enable more tools.', inputSchema: { type: 'object', properties: { domains: { type: 'string', enum: ['a', 'b'] } }, required: ['domains'] } });
  const search = tool('search_web', [], { annotations: { readOnlyHint: true, openWorldHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } });
  const plan = autoScenario(menuOf([search, unlock]));
  assert.deepEqual(plan.scenario.steps.filter((s) => s.tool === 'enable_domains').map((s) => s.args.domains), ['a', 'b', 'a']);
  // Other open-world tools still wait for --open-world: they may spend credits.
  assert.deepEqual(plan.skipped, [{ tool: 'search_web', reason: 'open world' }]);
});

test('--auto: an unlock it can\'t call (not read-only) is named, with the reason', async () => {
  const menu = menuOf([{ name: 'unlock_toolset', description: 'Unlock more tools.', inputSchema: { type: 'object', properties: { toolset: { type: 'string', enum: ['audits', 'reports'] } }, required: ['toolset'] }, annotations: { readOnlyHint: false } }]);
  const plan = autoScenario(menu);
  const r = await session(stdio(), plan.scenario, { timeoutMs: TIMEOUT_MS, processes: 1, auto: { called: plan.called, skipped: plan.skipped } });
  const cov = r.findings.find((f) => f.rule === 'session/unlock-coverage');
  assert.match(cov?.message ?? '', /got through 0 of its 2 toolset values.*--auto skipped it: it isn't marked readOnlyHint/);
});

test('session/unlock-coverage: a partial unlock is a warning; an unlock never called only when the run builds the baseline', async () => {
  const partial = await session(stdio(), parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: TIMEOUT_MS, processes: 1 });
  const cov = partial.findings.find((f) => f.rule === 'session/unlock-coverage');
  assert.equal(cov?.severity, 'warn');
  assert.match(cov.message, /got through 1 of its 2 toolset values/);
  assert.deepEqual(cov.detail, ['not unlocked: "reports"']);
  const full = await session(stdio(), parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }, { call: 'unlock_toolset', args: { toolset: 'reports' } }] }), { timeoutMs: TIMEOUT_MS, processes: 1 });
  assert.ok(!full.findings.some((f) => f.rule === 'session/unlock-coverage'));
  const never = parseScenario({ steps: ['list'] });
  assert.ok(!(await session(stdio(), never, { timeoutMs: TIMEOUT_MS, processes: 1 })).findings.some((f) => f.rule === 'session/unlock-coverage'));
  assert.ok((await session(stdio(), never, { timeoutMs: TIMEOUT_MS, processes: 1, unionOut: true })).findings.some((f) => f.rule === 'session/unlock-coverage'));
});

test('scopeOf: undoing an unlock back to the baseline is unclear, not global (a fresh process starts there)', () => {
  const baseline = menuOf([tool('room_create'), tool('room_join')]).tools;
  const joined = menuOf([tool('room_create'), tool('room_join'), tool('scene_read'), tool('room_leave')]).tools;
  const left = compareMenus(joined, baseline);
  assert.equal(scopeOf(left, baseline, baseline, 'stdio', baseline), 'unclear');
  assert.equal(scopeOf(left, baseline, baseline, 'stdio'), 'global', 'without the baseline it reads as global');
  // The unlock itself still reads as per-process.
  assert.equal(scopeOf(compareMenus(baseline, joined), joined, baseline, 'stdio', baseline), 'per-process');
});

test('session: a server with one session per client ends ours when the probe connects; said once, clearly', async () => {
  const server = await startRawHttp({ scope: 'local', onePerClient: true });
  try {
    const target = { kind: 'http', url: server.url, headers: { 'mcp-client-id': 'audit' } };
    const scenario = parseScenario({ steps: ['list', { call: 'unlock_toolset' }, 'list', 'list'] });
    const r = await session(target, scenario, { timeoutMs: TIMEOUT_MS });
    const rules = r.findings.map((f) => f.rule);
    assert.deepEqual(rules.filter((x) => x === 'session/session-lost'), ['session/session-lost']);
    assert.ok(!rules.includes('session/untested'), 'not blamed on credentials');
    assert.ok(!rules.includes('session/step-failed'));
    const lost = r.findings.find((f) => f.rule === 'session/session-lost');
    assert.match(lost.message, /“Session not found or expired”/);
    assert.equal(lost.fix, 'Rerun with --processes 1: toolmenu then opens no second one.');
    // --processes 1 opens no second connection, the scope probe included: the run completes.
    const one = await session(target, scenario, { timeoutMs: TIMEOUT_MS, processes: 1 });
    assert.deepEqual(one.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok']);
    assert.ok(one.findings.some((f) => f.rule === 'session/mid-insert' && f.step === 2));
  } finally {
    await server.close();
  }
});

test('no control characters in the source: a stray byte in a regex is invisible and silently breaks it', () => {
  const dir = join(ROOT, 'src');
  const bad = readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.ts'))
    .filter((f) => /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(readFileSync(join(dir, String(f)), 'utf8')));
  assert.deepEqual(bad, []);
});

test('the union menu holds every tool the session saw, first-seen order, and diffs like any menu', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'unlock.yml'), 'steps:\n  - list\n  - call: unlock_toolset\n    args: { toolset: audits }\n');
  const r = await run(['session', '--scenario', 'unlock.yml', '--union-out', 'union.json', '--', process.execPath, join(FIXTURES, 'session-server.mjs')], { cwd });
  assert.ok([0, 1].includes(r.code), r.stderr);
  const union = JSON.parse(readFileSync(join(cwd, 'union.json'), 'utf8'));
  assert.equal(union.toolmenu, 1);
  const names = union.tools.map((t) => t.name);
  assert.ok(names.includes('search_forms') && names.includes('unlock_toolset'));
  assert.ok(names.some((n) => /audit/.test(n)), names.join(','));
  // The core tools come first, the unlocked ones after.
  assert.ok(names.indexOf('unlock_toolset') < names.findIndex((n) => /audit/.test(n)));
  const d = await run(['diff', 'union.json', 'union.json'], { cwd });
  assert.equal(d.code, 0);
});

// A server that unlocks tools per domain, for this connection only (see the fixture).
const domainsRun = async () => {
  const server = await startDomains();
  try {
    const target = { kind: 'http', url: server.url };
    const plan = autoScenario(await probeMenu(target, TIMEOUT_MS));
    const auto = { called: plan.called, skipped: plan.skipped };
    const r = await session(target, plan.scenario, { timeoutMs: TIMEOUT_MS, scenarioName: 'auto', auto });
    const calls = (name) => plan.scenario.steps.filter((s) => s.kind === 'call' && s.tool === name).length;
    const ran = (name) => r.steps.filter((s) => s.label.startsWith(`call ${name}`)).length;
    return { r, calls, ran };
  } finally {
    await server.close();
  }
};

test('session --auto, unlock per domain: one append and one connection-local finding for every unlock step, each step in the detail', async () => {
  const { r } = await domainsRun();
  const of = (rule) => r.findings.filter((f) => f.rule === rule);
  assert.equal(of('session/append').length, 1);
  assert.equal(of('session/connection-local').length, 1);
  const append = of('session/append')[0];
  const unlocked = r.steps.filter((s) => s.label.startsWith('call search_capabilities') && s.changed).map((s) => s.index);
  assert.equal(unlocked.length, 3);
  assert.deepEqual(append.steps, unlocked);
  assert.equal(append.step, unlocked[0]);
  assert.equal(append.severity, 'warn');
  assert.match(append.message, /^Steps \d+–\d+: /);
  assert.deepEqual(append.detail.slice(0, 3).map((d) => d.replace(/~\d+/, '~T')), [
    `step ${unlocked[0]}: +3 tools (~T tokens): billing_findTypes, billing_getSummary, billing_listInvoices`,
    `step ${unlocked[1]}: +2 tools (~T tokens): reports_list, reports_get`,
    `step ${unlocked[2]}: +1 tool (~T tokens): alerts_list`,
  ]);
  assert.deepEqual(of('session/connection-local')[0].steps, unlocked);
  assert.equal(of('session/connection-local')[0].severity, 'info');
  const text = formatSession(r, 'text');
  assert.equal(text.match(/The end of the tool list isn't the end of the prompt/g).length, 1);
  assert.match(text, /step \d+: call search_capabilities \{"domains":\["billing"\]\} · answered · menu changed · \+3 tools/);
});

test('unlockers: a lookup counts only when it says its parameter unlocks tools; a claim about another parameter is not one', () => {
  const lookup = (name, description) => ({ ...tool(name), description, inputSchema: { type: 'object', properties: { query: { type: 'string' }, domain: { type: 'string', enum: ['a', 'b'] } } } });
  assert.deepEqual(unlockers([lookup('list_recipes', 'Lists recipes. Recipes found by a query enable the tools they use.')]).map((u) => u.tool.name), []);
  assert.deepEqual(unlockers([lookup('search_capabilities', 'Finds workflows and loads the tools of the chosen domain.')]).map((u) => u.tool.name), ['search_capabilities']);
  assert.deepEqual(unlockers([lookup('list_things', 'List things that expose tools.')]).map((u) => u.tool.name), [], '"expose" or "add" is no claim to unlock');
});

test('session --auto: a lookup is called once; an unlock that never says so and changed nothing on its first value stops there', async () => {
  const { r, calls, ran } = await domainsRun();
  assert.equal(calls('list_recipes'), 1, 'list_recipes is a lookup: one call, not one per domain');
  assert.equal(ran('summarize_domain'), 1, 'its first value changed nothing: the other values are not called');
  assert.equal(ran('search_capabilities'), 4, 'the real unlock runs every value, and once again');
  assert.deepEqual(r.auto?.stopped, [{ tool: 'summarize_domain', calls: 3 }]);
  assert.ok(!r.findings.some((f) => f.rule === 'session/unlock-coverage'), 'not charged for values it chose not to call');
  assert.match(formatSession(r, 'text'), /summarize_domain: its first value changed nothing and it doesn't say it unlocks tools, so the other 3 calls were left out/);
});

test('session: the same error from different tools is one tool-error finding; a feature not set up here is not a --value problem', async () => {
  const { r } = await domainsRun();
  const errors = r.findings.filter((f) => f.rule === 'session/tool-error');
  assert.equal(errors.length, 1);
  const [e] = errors;
  assert.deepEqual(e.steps, [3, 4]);
  assert.match(e.message, /^Steps 3 and 4: audits_findTypes and audits_getSummary returned the same error: /);
  assert.doesNotMatch(e.fix, /--value/);
  assert.match(e.fix, /isn't available here/);
  assert.equal(e.confidence, 'unsure');
});

test('session: a mid-session finding says the cache cost once', async () => {
  const scenario = join(ROOT, 'examples/unlock.scenario.yml');
  const r = await run(['session', '--scenario', scenario, '--json', '--', process.execPath, join(FIXTURES, 'session-server.mjs')]);
  const changes = JSON.parse(r.stdout).findings.filter((f) => /^session\/(mid-insert|edit|reorder|remove)$/.test(f.rule));
  assert.ok(changes.length > 0);
  for (const f of changes) {
    const text = [f.message, ...(f.detail ?? [])].join(' ');
    assert.equal(text.match(/invalidates the cached prompt/gi)?.length, 1, text);
  }
});

test("session: the same edit at two steps is one finding with each step's cost", async () => {
  const r = await run(['session', '--auto', '--json', '--', process.execPath, join(FIXTURES, 'session-server.mjs')]);
  const edits = JSON.parse(r.stdout).findings.filter((f) => f.rule === 'session/edit' && f.tool === 'get_form');
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].steps, [2, 7]);
  assert.equal(edits[0].step, 2);
  assert.match(edits[0].message, /^Steps 2 and 7: get_form: description changed mid-session/);
  assert.ok(edits[0].detail.some((d) => /^step 2: position 1 · ~\d+ tokens \(estimate\)/.test(d)), edits[0].detail.join('\n'));
  assert.ok(edits[0].detail.some((d) => /^step 7: position 3 · ~\d+ tokens \(estimate\)/.test(d)), edits[0].detail.join('\n'));
  assert.match(edits[0].fix, /Keep get_form's definition fixed/);
  assert.equal(edits[0].cause, undefined);
});

test('session: edits at different paths of one tool stay separate; the same path merges', () => {
  const a = { name: 't', description: 'x', inputSchema: { type: 'object', properties: { d: { type: 'string', default: '1' } } }, tokens: 10 };
  const b1 = { ...a, description: 'y' };
  const b2 = { ...b1, inputSchema: { type: 'object', properties: { d: { type: 'string', default: '2' } } } };
  const s2 = changeFindings([a], [b1], [{ kind: 'description', tool: 't', position: 0 }], 2);
  const s5 = changeFindings([b1], [b2], [{ kind: 'inputSchema', tool: 't', position: 0 }], 5);
  assert.equal(mergeRepeats([...s2, ...s5]).filter((f) => f.rule === 'session/edit').length, 2);
  const s6 = changeFindings([b1], [{ ...b1, description: 'z' }], [{ kind: 'description', tool: 't', position: 0 }], 6);
  assert.equal(mergeRepeats([...s2, ...s6]).filter((f) => f.rule === 'session/edit').length, 1);
});

test('session: the text report leads with one line per cause, before the step log', async () => {
  const r = await run(['session', '--auto', '--', process.execPath, join(FIXTURES, 'session-server.mjs')]);
  const head = r.stdout.split('\nstep 1:')[0];
  assert.match(head, /\n2 errors, 2 warnings:\n/);
  assert.match(head, /\n  ERROR  session\/edit · steps 2 and 7 · get_form: description changed mid-session\.\n/);
  assert.match(head, /\n  ERROR  session\/mid-insert · step 4 · \+2 tools inserted at position 1 \(list_team_audits, get_team_audit\)\./);
  assert.match(head, /\n  WARN   session\/side-effect · steps 2, 4, 5 and 7 · A freshly started server doesn't show this change\./);
  // One line each, cut at 100 characters.
  for (const l of head.split('\n').filter((l) => /^  (ERROR|WARN )  /.test(l))) assert.ok(l.split(' · ').slice(2).join(' · ').length <= 100, l);
  const labels = head.split('\n').filter((l) => /^  (ERROR|WARN )  /.test(l)).map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(labels, ['ERROR', 'ERROR', 'WARN', 'WARN']);
});

test('session: the markdown report has the same summary above the step table', async () => {
  const r = await run(['session', '--auto', '--format', 'markdown', '--', process.execPath, join(FIXTURES, 'session-server.mjs')]);
  const at = r.stdout.indexOf('**2 errors, 2 warnings:**');
  assert.ok(at > -1, r.stdout);
  assert.ok(at < r.stdout.indexOf('| Step |'));
  assert.match(r.stdout, /\n- \*\*ERROR\*\* `session\/edit` · steps 2 and 7 · get_form: description changed mid-session\.\n/);
});

test('session: a clean run has no summary block', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 's.yml'), 'steps:\n  - list\n');
  const r = await run(['session', '--scenario', 's.yml', '--', process.execPath, join(FIXTURES, 'sdk-server.mjs')], { cwd: dir });
  assert.doesNotMatch(r.stdout, /^\d+ errors?, /m);
});

test('session: the summary says "before step 1" for what was found before the first step', async () => {
  const { formatSession } = await import('../dist/report.js');
  const result = {
    scenario: 's', server: { name: 'x' }, transport: 'stdio', listening: true, connectionCheck: 'different',
    baseline: { tools: 1, tokens: 10 }, final: { tools: 1, tokens: 10 }, steps: [],
    findings: [
      { rule: 'menu/process-variance', severity: 'error', step: 0, message: 'A second server process served a different menu.' },
      { rule: 'session/nothing-called', severity: 'warn', message: '--auto called no tools.' },
    ],
    union: { toolmenu: 1, server: {}, capturedAt: '', tools: [], totalTokens: 0 },
  };
  const text = formatSession(result, 'text');
  assert.match(text, /\n  ERROR  menu\/process-variance · before step 1 · A second server process served a different menu\.\n/);
  assert.match(text, /\n  WARN   session\/nothing-called · the whole run · --auto called no tools\.\n/);
});

test('session: the summary keeps a quoted sentence whole and marks unsure findings', async () => {
  const { formatSession } = await import('../dist/report.js');
  const result = {
    scenario: 's', server: { name: 'x' }, transport: 'stdio', listening: true,
    baseline: { tools: 1, tokens: 10 }, final: { tools: 1, tokens: 10 }, steps: [],
    findings: [{ rule: 'session/session-lost', severity: 'error', step: 3, confidence: 'unsure', message: 'The server ended this session at step 3 (“Session not found. Please reinitialize.”) after toolmenu opened a second process.' }],
    union: { toolmenu: 1, server: {}, capturedAt: '', tools: [], totalTokens: 0 },
  };
  const line = formatSession(result, 'text').split('\n').find((l) => l.startsWith('  ERROR  session/session-lost · '));
  assert.match(line, /^  ERROR  session\/session-lost · unsure · step 3 · The server ended this session at step 3 \(“Session not found\. Please reinitialize\.”\) after t/);
});

test('session: a tool-error summary line names its step once', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 's.yml'), 'steps:\n  - call: get_form\n    args: { form_id: broken }\n');
  const r = await run(['session', '--scenario', 's.yml', '--', process.execPath, join(FIXTURES, 'session-server.mjs')], { cwd: dir });
  const line = r.stdout.split('\n').find((l) => l.startsWith('  WARN   session/tool-error · '));
  assert.match(line, /^  WARN   session\/tool-error · step 1 · get_form returned an error/);
  assert.doesNotMatch(line, / · step 1 · Step 1/);
});

test('session: the markdown summary uses the same labels as the text summary', async () => {
  const r = await run(['session', '--auto', '--format', 'markdown', '--', process.execPath, join(FIXTURES, 'session-server.mjs')]);
  assert.match(r.stdout, /\n- \*\*ERROR\*\* `session\/edit` · steps 2 and 7 · /);
  assert.match(r.stdout, /\n- WARN `session\/side-effect` · steps 2, 4, 5 and 7 · /);
});

test('session: an edit that changes more than the earlier one is its own finding', () => {
  const props = (extra) => ({ type: 'object', properties: { end: { type: 'string', default: extra.end }, ...(extra.foo ? { foo: { type: 'string' } } : {}) } });
  const a = { name: 't', inputSchema: props({ end: '1' }), tokens: 10 };
  const b = { name: 't', inputSchema: props({ end: '2' }), tokens: 10 };
  const c = { name: 't', inputSchema: props({ end: '3', foo: true }), tokens: 12 };
  const s2 = changeFindings([a], [b], [{ kind: 'inputSchema', tool: 't', position: 0 }], 2);
  const s7 = changeFindings([b], [c], [{ kind: 'inputSchema', tool: 't', position: 0 }], 7);
  assert.equal(mergeRepeats([...s2, ...s7]).filter((f) => f.rule === 'session/edit').length, 2);
});

test('session: the same edit from different origins is not merged', () => {
  const a = { name: 't', description: 'x', tokens: 10 };
  const s2 = changeFindings([a], [{ ...a, description: 'y' }], [{ kind: 'description', tool: 't', position: 0 }], 2, 'no tool call in between');
  const s7 = changeFindings([a], [{ ...a, description: 'z' }], [{ kind: 'description', tool: 't', position: 0 }], 7, 'after calling get_x');
  assert.equal(mergeRepeats([...s2, ...s7]).filter((f) => f.rule === 'session/edit').length, 2);
});

test('http: snapshot and session end every session they open', async () => {
  const server = await startRawHttp({ scope: 'local' });
  try {
    const snap = await run(['snapshot', '--no-write', server.url]);
    assert.equal(snap.code, 0, snap.stderr);
    assert.equal(server.open(), 0, 'snapshot left sessions open');
    const auto = await run(['session', '--auto', server.url]);
    assert.ok(auto.code <= 1, auto.stderr);
    assert.equal(server.open(), 0, 'session left sessions open');
  } finally {
    await server.close();
  }

const SESSION_SERVER = ['--', process.execPath, join(FIXTURES, 'session-server.mjs')];

test('session: the report counts what the calls did, and each call step says how it went', async () => {
  const r = await run(['session', '--auto', ...SESSION_SERVER]);
  assert.match(r.stdout, /\n  calls: 6 · 6 answered, 0 tool errors, 0 failed\n/);
  assert.match(r.stdout, /\nstep 3: call search_forms \{"query":"test"\} · answered · no change\n/);
  const json = JSON.parse((await run(['session', '--auto', '--json', ...SESSION_SERVER])).stdout);
  assert.equal(json.steps[2].outcome, 'answered');
  assert.equal(json.steps[0].outcome, undefined, 'a list step has no call outcome');
  const dir = tempDir();
  writeFileSync(join(dir, 's.yml'), 'steps:\n  - call: get_form\n    args: { form_id: broken }\n');
  const broken = await run(['session', '--scenario', 's.yml', ...SESSION_SERVER], { cwd: dir });
  assert.match(broken.stdout, /\n  calls: 1 · 0 answered, 1 tool error, 0 failed\n/);
});

test('session --auto calls the tools an unlock brings, right after it', async () => {
  const r = await run(['session', '--auto', '--json', '--value', 'team=platform', ...SESSION_SERVER]);
  const out = JSON.parse(r.stdout);
  const labels = out.steps.map((s) => s.label);
  const unlock = labels.indexOf('call unlock_toolset {"toolset":"audits"}');
  assert.equal(labels[unlock + 1], 'call list_team_audits {"team":"platform"}', labels.join('\n'));
  assert.ok(out.auto.called.includes('list_team_audits'));
  assert.ok(out.auto.skipped.some((s) => s.tool === 'get_team_audit' && s.reason === 'needs values'));
  assert.ok(out.auto.skipped.some((s) => s.tool === 'export_report' && s.reason === 'needs values'));
  assert.ok(!(out.auto.ignored ?? []).some((x) => /team/.test(x.input)), JSON.stringify(out.auto.ignored));
});

const UNLOCKED_VALUES = ['--value', 'team=platform', '--value', 'team_audit_id=a1', '--value', 'report_id=r1'];
const calledBesidesUnlock = (out) => out.auto.called.filter((t) => t !== 'unlock_toolset');

test('session --auto gives each unlock its own call budget, so every toolset gets calls', async () => {
  const out = JSON.parse((await run(['session', '--auto', '--json', ...UNLOCKED_VALUES, ...SESSION_SERVER])).stdout);
  for (const t of ['list_team_audits', 'get_team_audit', 'export_report']) assert.ok(out.auto.called.includes(t), `${t} called`);
});

test('session --auto: --max-calls-per-unlock caps the calls for the tools one unlock brings', async () => {
  const r = await run(['session', '--auto', '--max-calls-per-unlock', '1', ...UNLOCKED_VALUES, ...SESSION_SERVER]);
  assert.match(r.stdout, /1 over the per-unlock budget → --max-calls-per-unlock 2/);
  const out = JSON.parse((await run(['session', '--auto', '--json', '--max-calls-per-unlock', '1', ...UNLOCKED_VALUES, ...SESSION_SERVER])).stdout);
  const audits = ['list_team_audits', 'get_team_audit'].filter((t) => out.auto.called.includes(t));
  assert.equal(audits.length, 1, 'one of the two audit tools');
  assert.ok(out.auto.called.includes('export_report'), 'the next unlock has its own budget');
  assert.ok(out.auto.skipped.some((s) => s.reason === 'over the per-unlock budget'));
});

test('session --auto: --max-calls caps every call, unlocked tools included, and keeps room for them', async () => {
  const out = JSON.parse((await run(['session', '--auto', '--json', '--max-calls', '2', ...UNLOCKED_VALUES, ...SESSION_SERVER])).stdout);
  assert.ok(calledBesidesUnlock(out).length <= 2, calledBesidesUnlock(out).join(', '));
  assert.ok(calledBesidesUnlock(out).some((t) => ['list_team_audits', 'get_team_audit'].includes(t)), 'the starting menu left room for the unlock');
  assert.ok(out.auto.skipped.some((s) => s.reason === 'over the call budget'));
});

test('session: the header says the fresh-connection check is of the starting menu', async () => {
  const r = await run(['session', '--auto', ...SESSION_SERVER]);
  assert.match(r.stdout, /\n  fresh-process check of the starting menu: the same\n/);
});

test('session: the summary leads with the menu change and its cost, and lists info findings', async () => {
  const r = await run(['session', '--auto', ...SESSION_SERVER]);
  const head = r.stdout.split('\nstep 1:')[0];
  assert.match(head, /\nmenu: 5 → 8 tools \(\+3\) · ~290 → ~479 tokens \(\+189, estimate\) · changed at steps 2, 4, 5 and 7\n/);
  const md = (await run(['session', '--auto', '--format', 'markdown', ...SESSION_SERVER])).stdout;
  assert.match(md, /\*\*Menu:\*\* 5 → 8 tools \(\+3\) · ~290 → ~479 tokens \(\+189, estimate\) · changed at steps 2, 4, 5 and 7/);
});

test('session: the summary cuts at a sentence end when one is near, never inside a quote', async () => {
  const { formatSession } = await import('../dist/report.js');
  const base = { scenario: 's', server: { name: 'x' }, transport: 'stdio', listening: true, baseline: { tools: 1, tokens: 10 }, final: { tools: 1, tokens: 10 }, steps: [], union: { toolmenu: 1, server: {}, capturedAt: '', tools: [], totalTokens: 0 } };
  const findings = [
    { rule: 'session/append', severity: 'warn', step: 2, message: '+97 tools appended at the end of the list, over 9 steps. The end of the tool list isn\'t the end of the prompt: most clients send tools first.' },
    { rule: 'session/known-variance', severity: 'info', step: 1, message: 'The menu changed again, only in values that already differ.' },
    { rule: 'session/session-lost', severity: 'error', step: 3, message: 'The server ended this session at step 3 (“Session not found. Please reinitialize now or later.”) after toolmenu opened a second process with the same credentials.' },
  ];
  const text = formatSession({ ...base, findings }, 'text');
  assert.match(text, /\n  WARN   session\/append · step 2 · \+97 tools appended at the end of the list, over 9 steps\.\n/);
  assert.match(text, /\n  INFO   session\/known-variance · step 1 · The menu changed again, only in values that already differ\.\n/);
  // No sentence end outside the quote fits in 100 characters: cut at the length, after the quote's own period.
  assert.match(text, /\n  ERROR  session\/session-lost · step 3 · The server ended this session at step 3 \(“Session not found\. Please reinitialize now or later\.”\)…\n/);
  assert.match(text, /\n1 error, 1 warning, 1 info:\n/);
});

