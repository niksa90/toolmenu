import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareMenus } from '../dist/compare.js';
import { changeFindings, clip, parseScenario, scopeOf, session, starterScenario, unlockers } from '../dist/session.js';
import { parse as parseYaml } from 'yaml';
import { FIXTURES, ROOT, menuOf, run, tempDir, tool } from './helpers.mjs';
import { start as startSdkHttp } from './fixtures/http-server.mjs';
import { start as startRawHttp } from './fixtures/raw-http-server.mjs';
import { build } from './fixtures/session-server.mjs';

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
  assert.match(inserted[0].detail[0], /positions 1–3/);

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
  const r = await session(stdio(), UNLOCK, { timeoutMs: 15_000 });
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

test('session over stdio (2025 protocol): cache findings, but no 2026-07-28 side-effect rule', async () => {
  const r = await session(stdio({ LEGACY: '1' }), UNLOCK, { timeoutMs: 15_000 });
  assert.equal(r.server.protocolVersion, '2025-11-25');
  assert.deepEqual(byStep(r), ['3:session/mid-insert', '4:session/append', '5:session/edit', '7:session/refused']);
});

test('allow_writes lets the scenario call a destructive tool', async () => {
  const r = await session(stdio(), parseScenario({ allow_writes: true, steps: [{ call: 'delete_form', args: { form_id: 'f_1', dry_run: true } }] }), { timeoutMs: 15_000 });
  assert.deepEqual(byStep(r), []);
  assert.equal(r.steps[0].status, 'ok');
});

test('a tool that returns an error is a warning, not a clean step', async () => {
  const r = await session(stdio(), parseScenario({ steps: [{ call: 'get_form', args: { form_id: 'expired' } }, { call: 'get_form', args: { form_id: 'f_1' } }] }), { timeoutMs: 15_000 });
  assert.deepEqual(byStep(r), ['1:session/tool-error']);
  assert.equal(r.findings[0].severity, 'warn');
  assert.match(r.findings[0].message, /401 Unauthorized: token expired/);
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
  const r = await session(stdio(), parseScenario({ steps: [{ call: 'list_team_audits', args: { team: 't' } }] }), { timeoutMs: 15_000 });
  assert.deepEqual(byStep(r), ['1:session/step-failed']);
});

test('http, SDK server with shared state: global change, and no list_changed', async () => {
  const shared = {};
  const server = await startSdkHttp({ factory: () => build(shared) });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: 15_000 });
    assert.equal(r.steps[0].scope, 'global');
    assert.deepEqual(byStep(r), ['1:session/mid-insert', '1:session/unannounced']);
  } finally {
    await server.close();
  }
});

test('http, SDK server with per-instance state: the unlock silently does nothing', async () => {
  const server = await startSdkHttp({ factory: () => build() });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: 15_000 });
    assert.equal(r.steps[0].changed, false);
    assert.deepEqual(r.findings, []);
  } finally {
    await server.close();
  }
});

test('http with sessions: a change only this connection sees is connection-local', async () => {
  const server = await startRawHttp({ scope: 'local' });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset' }] }), { timeoutMs: 15_000 });
    assert.equal(r.steps[0].scope, 'connection-local');
    assert.deepEqual(byStep(r), ['1:session/mid-insert', '1:session/connection-local']);
    assert.equal(r.findings[1].severity, 'info', '2025-era: allowed, but noted');
  } finally {
    await server.close();
  }
});

test('http with sessions: a global change is global', async () => {
  const server = await startRawHttp({ scope: 'global' });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset' }] }), { timeoutMs: 15_000 });
    assert.equal(r.steps[0].scope, 'global');
    assert.deepEqual(byStep(r), ['1:session/mid-insert']);
  } finally {
    await server.close();
  }
});

test('http: menus that differ per connection are caught before the first step', async () => {
  const server = await startRawHttp({ vary: true });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: ['list'] }), { timeoutMs: 15_000 });
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
  assert.match(r.stdout, /^step 3: call unlock_toolset \{"toolset":"audits"\} · menu changed · list_changed received · scope: per-process$/m);
  assert.match(r.stdout, /ERROR  session\/mid-insert\n\s+\+2 tools inserted at position 1 \(list_team_audits, get_team_audit\)/);
  assert.match(r.stdout, /estimated tokens of the tool list from position 1 on \(positions 1–6\), a floor/);

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

