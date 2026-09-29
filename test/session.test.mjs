import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareMenus } from '../dist/compare.js';
import { changeFindings, clip, MAX_UNLOCKS, parseScenario, scopeOf, session, starterScenario, unlockers, unlockListers, valuesFromListing } from '../dist/session.js';
import { autoScenario } from '../dist/auto.js';
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
  assert.match(inserted[0].detail[0], /change starts at position 1; .*this server's part: ~\d+ tokens/);

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

test('session: a server that holds a lock still gets its report, with the scope left unchecked', async () => {
  const lock = join(tempDir(), 'db.lock');
  const r = await session(stdio({ LOCKFILE: lock }), UNLOCK, { timeoutMs: 15_000 });
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
  const r = await session(stdio(), parseScenario({ steps: [{ call: 'get_form', args: { form_id: 'broken' } }, { call: 'get_form', args: { form_id: 'f_1' } }] }), { timeoutMs: 15_000 });
  assert.deepEqual(byStep(r), ['1:session/tool-error']);
  assert.equal(r.findings[0].severity, 'warn');
  assert.match(r.findings[0].message, /The form definition is corrupt/);
});

test('calls that fail on credentials are one session/untested finding: warn if some got through, error if none did', async () => {
  const some = await session(stdio(), parseScenario({ steps: [{ call: 'get_form', args: { form_id: 'expired' } }, { call: 'get_form', args: { form_id: 'f_1' } }] }), { timeoutMs: 15_000 });
  assert.deepEqual(byStep(some), ['undefined:session/untested']);
  assert.equal(some.findings[0].severity, 'warn');
  assert.match(some.findings[0].message, /^1 of 2 tool calls failed before reaching the tool: 1 on authentication/);
  assert.equal(some.steps[0].failure, 'auth');
  const none = await session(stdio(), parseScenario({ steps: [{ call: 'get_form', args: { form_id: 'expired' } }] }), { timeoutMs: 15_000 });
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
  const r = await session(stdio(), parseScenario({ steps: [{ call: 'list_team_audits', args: { team: 't' } }] }), { timeoutMs: 15_000 });
  assert.deepEqual(byStep(r), ['1:session/step-failed']);
});

test('http, SDK server with shared state: global change, and no list_changed', async () => {
  const shared = {};
  const server = await startSdkHttp({ factory: () => build(shared) });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: 15_000 });
    assert.equal(r.steps[0].scope, 'global');
    assert.deepEqual(byStep(r), ['1:session/mid-insert', '1:session/unannounced', '1:session/unlock-coverage']);
  } finally {
    await server.close();
  }
});

test('http, SDK server with per-instance state: the unlock silently does nothing', async () => {
  const server = await startSdkHttp({ factory: () => build() });
  try {
    const r = await session({ kind: 'http', url: server.url }, parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: 15_000 });
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
  assert.match(r.stdout, /the change starts at position 1; any change to the tool list invalidates the cached prompt/);

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
  assert.deepEqual(auto, many.enum, 'outside the call budget');
  assert.equal(autoScenario(menu, { maxCalls: 1 }).scenario.steps.filter((s) => s.tool === 'enable_toolset').length, 19);
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

test('session/unlock-coverage: a partial unlock is a warning; an unlock never called only when the run builds the baseline', async () => {
  const partial = await session(stdio(), parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }] }), { timeoutMs: 15_000, processes: 1 });
  const cov = partial.findings.find((f) => f.rule === 'session/unlock-coverage');
  assert.equal(cov?.severity, 'warn');
  assert.match(cov.message, /got through 1 of its 2 toolset values/);
  assert.deepEqual(cov.detail, ['not unlocked: "reports"']);
  const full = await session(stdio(), parseScenario({ steps: [{ call: 'unlock_toolset', args: { toolset: 'audits' } }, { call: 'unlock_toolset', args: { toolset: 'reports' } }] }), { timeoutMs: 15_000, processes: 1 });
  assert.ok(!full.findings.some((f) => f.rule === 'session/unlock-coverage'));
  const never = parseScenario({ steps: ['list'] });
  assert.ok(!(await session(stdio(), never, { timeoutMs: 15_000, processes: 1 })).findings.some((f) => f.rule === 'session/unlock-coverage'));
  assert.ok((await session(stdio(), never, { timeoutMs: 15_000, processes: 1, unionOut: true })).findings.some((f) => f.rule === 'session/unlock-coverage'));
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
    const r = await session(target, scenario, { timeoutMs: 15_000 });
    const rules = r.findings.map((f) => f.rule);
    assert.deepEqual(rules.filter((x) => x === 'session/session-lost'), ['session/session-lost']);
    assert.ok(!rules.includes('session/untested'), 'not blamed on credentials');
    assert.ok(!rules.includes('session/step-failed'));
    assert.match(r.findings.find((f) => f.rule === 'session/session-lost').message, /“Session not found or expired”.*--processes 1/);
    // --processes 1 opens no second connection, the scope probe included: the run completes.
    const one = await session(target, scenario, { timeoutMs: 15_000, processes: 1 });
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

