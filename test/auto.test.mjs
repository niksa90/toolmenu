import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthesize, synthesizeArgs } from '../dist/args.js';
import { autoScenario, autoSummary, loadValuesFile, parseAssumeReadOnly, parseValueFlag } from '../dist/auto.js';
import { probeMenu } from '../dist/probe.js';
import { parseScenario, session } from '../dist/session.js';
import { FIXTURES, menuOf, run, tempDir, tool } from './helpers.mjs';

test('synthesize: only values the schema vouches for', () => {
  const v = (schema, name) => synthesize(schema, name);
  assert.deepEqual(v({ type: 'string', const: 'x' }), { ok: true, value: 'x' });
  assert.deepEqual(v({ type: 'string', default: 'css' }), { ok: true, value: 'css' });
  assert.deepEqual(v({ type: 'string', examples: ['ex'] }), { ok: true, value: 'ex' });
  assert.deepEqual(v({ type: 'string', enum: ['a', 'b'] }), { ok: true, value: 'a' });
  assert.deepEqual(v({ type: 'integer', minimum: 5 }), { ok: true, value: 5 });
  assert.deepEqual(v({ type: 'boolean' }), { ok: true, value: false });
  assert.deepEqual(v({ type: 'string', format: 'date-time' }), { ok: true, value: '2026-01-01T00:00:00Z' });
  assert.deepEqual(v({ type: 'string' }, 'query'), { ok: true, value: 'test' });
  assert.deepEqual(v({ type: ['string', 'null'] }, 'q'), { ok: true, value: 'test' });
  assert.deepEqual(v({ anyOf: [{ type: 'string', pattern: '^x' }, { type: 'integer' }] }), { ok: true, value: 1 });
  // Never an ID, a pattern, or a free-text field it can't name.
  assert.equal(v({ type: 'string' }, 'owner').ok, false);
  assert.equal(v({ type: 'string', pattern: '^[a-f0-9]+$' }, 'query').ok, false);
  assert.equal(v({ type: 'array', items: { type: 'string' }, minItems: 1 }, 'ids').ok, false);
  // A required list it can't fill an item of is "needs values", never [] (Exa's web_fetch_exa {"urls": []}).
  assert.equal(v({ type: 'array', items: { type: 'string' } }, 'urls').ok, false);
  assert.deepEqual(v({ type: 'array', items: { type: 'string', format: 'uri' } }, 'urls'), { ok: true, value: ['https://example.com'] });
  // A default that doesn't fit the type isn't used (Microsoft Learn: default null on a string).
  assert.deepEqual(v({ type: 'string', default: null }, 'question'), { ok: true, value: 'test' });
  assert.equal(v({ type: 'string', default: null }, 'owner').ok, false);
  assert.deepEqual(v({ type: ['string', 'null'], default: null }), { ok: true, value: null });
  assert.deepEqual(v({ type: 'integer', default: '5', minimum: 2 }), { ok: true, value: 2 });
  assert.deepEqual(v({ type: 'string', examples: [3, 'ok'] }), { ok: true, value: 'ok' });
  assert.deepEqual(synthesizeArgs({ type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] }), { ok: false, missing: ['owner', 'repo'] });
});

test('autoScenario: read-only tools only, open world opt-in, cheapest first, a repeat at the end', () => {
  const closed = { readOnlyHint: true, openWorldHint: false };
  const menu = menuOf([
    tool('delete_repo', [], { annotations: { destructiveHint: true } }),
    tool('get_issue', ['issue_key'], { annotations: closed }),
    tool('search_code', [], { annotations: closed, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }),
    tool('get_me', [], { annotations: closed }),
    tool('list_mine', [], { annotations: { readOnlyHint: true } }),
    tool('web_fetch', [], { annotations: { readOnlyHint: true, openWorldHint: true }, inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } }),
  ]);
  const plan = autoScenario(menu);
  // Unmarked (list_mine) is called; marked openWorldHint: true (web_fetch) is opt-in.
  assert.deepEqual(plan.called, ['get_me', 'list_mine', 'search_code']);
  assert.deepEqual(plan.scenario.steps.map((s) => (s.kind === 'call' ? s.tool : s.kind)), ['list', 'get_me', 'list_mine', 'search_code', 'get_me']);
  assert.equal(plan.scenario.allowWrites, false);
  const why = Object.fromEntries(plan.skipped.map((s) => [s.tool, s.reason]));
  assert.deepEqual(why, { delete_repo: 'not read-only', get_issue: 'needs values', web_fetch: 'open world' });
  assert.deepEqual(autoScenario(menu, { openWorld: true }).called, ['get_me', 'list_mine', 'search_code', 'web_fetch']);
  assert.deepEqual(autoScenario(menu, { maxCalls: 1 }).called, ['get_me']);
});

test('cli: session --auto runs, reports what it skipped, and saves its steps', async () => {
  const cwd = tempDir();
  const server = ['--', process.execPath, join(FIXTURES, 'session-server.mjs')];
  const r = await run(['session', '--auto', '--open-world', '--save-scenario', 'auto.yml', ...server], { cwd });
  assert.ok([0, 1].includes(r.code), r.stderr);
  assert.match(r.stdout, /toolmenu session {2}auto/);
  assert.match(r.stdout, /auto: called \d+ tools?/);
  assert.ok(existsSync(join(cwd, 'auto.yml')));
  assert.match(readFileSync(join(cwd, 'auto.yml'), 'utf8'), /^allow_writes: false$/m);
  const again = await run(['session', '--auto', '--save-scenario', 'auto.yml', ...server], { cwd });
  assert.equal(again.code, 2);
  const both = await run(['session', '--auto', '--scenario', 'x.yml', ...server], { cwd });
  assert.equal(both.code, 2);
});

const autoServer = (env = {}) => ({ kind: 'stdio', command: process.execPath, args: [join(FIXTURES, 'auto-server.mjs')], env });
const probe = (env = {}) => probeMenu(autoServer(env), 15_000);

test('autoScenario: --value fills required params by name or for one tool; values no tool takes are reported', async () => {
  const menu = await probe();
  const before = autoScenario(menu);
  const need = Object.fromEntries(before.skipped.filter((s) => s.reason === 'needs values').map((s) => [s.tool, s.missing]));
  assert.deepEqual(need, { git_status: ['repo_path'], git_log: ['repo_path'], get_current_time: ['timezone'], fetch_urls: ['urls'] });
  const plan = autoScenario(menu, {
    values: {
      repo_path: { raw: '/src/app', value: '/src/app' },
      timezone: { raw: 'UTC', value: 'UTC' },
      'git_log.max_count': { raw: '3', value: 3 },
      'fetch_urls.urls': { raw: 'https://example.com', value: 'https://example.com' },
      repo_pth: { raw: 'x', value: 'x' },
    },
  });
  const args = Object.fromEntries(plan.scenario.steps.filter((s) => s.kind === 'call').map((s) => [s.tool, s.args]));
  assert.deepEqual(args.git_status, { repo_path: '/src/app' });
  assert.deepEqual(args.git_log, { repo_path: '/src/app', max_count: 3 });
  assert.deepEqual(args.get_current_time, { timezone: 'UTC' });
  assert.deepEqual(args.fetch_urls, { urls: ['https://example.com'] }, 'a single value for a list is a list of one');
  assert.deepEqual([...plan.withValues].sort(), ['fetch_urls', 'get_current_time', 'git_log', 'git_status']);
  assert.deepEqual(plan.ignored, [{ input: '--value repo_pth', why: 'no tool takes a parameter named repo_pth' }]);
});

test('parseValueFlag and parseAssumeReadOnly: JSON when it parses, exact names only', () => {
  assert.deepEqual(parseValueFlag('repo_path=/src/app'), ['repo_path', { raw: '/src/app', value: '/src/app' }]);
  assert.deepEqual(parseValueFlag('limit=5'), ['limit', { raw: '5', value: 5 }]);
  assert.deepEqual(parseValueFlag('get.ids=["a","b"]'), ['get.ids', { raw: '["a","b"]', value: ['a', 'b'] }]);
  assert.throws(() => parseValueFlag('nothing'), /expected name=value/);
  assert.deepEqual(parseAssumeReadOnly(['a,b', 'c', 'a']), ['a', 'b', 'c']);
  assert.throws(() => parseAssumeReadOnly(['read_*']), /exact tool names, not patterns/);
});

test('values file: a map of names, tool.param keys, or values grouped by tool; assume_read_only in a scenario', async () => {
  const dir = tempDir();
  const path = join(dir, 'values.yml');
  writeFileSync(path, 'repo_path: /src/app\ngit_log:\n  max_count: 2\nget_current_time.timezone: UTC\n');
  const given = await loadValuesFile(path);
  const plan = autoScenario(await probe(), { values: given });
  const args = Object.fromEntries(plan.scenario.steps.filter((s) => s.kind === 'call').map((s) => [s.tool, s.args]));
  assert.deepEqual(args.git_log, { repo_path: '/src/app', max_count: 2 });
  assert.deepEqual(args.get_current_time, { timezone: 'UTC' });
  writeFileSync(path, '- a\n');
  await assert.rejects(loadValuesFile(path), /expected a map/);
  assert.deepEqual(parseScenario({ assume_read_only: ['read_wiki'], steps: ['list'] }).assumeReadOnly, ['read_wiki']);
  assert.throws(() => parseScenario({ assume_read_only: ['read_*'], steps: ['list'] }), /exact tool names/);
});

test('values file: every scalar is fitted to the parameter type from its text, as --value is', async () => {
  const ro = { annotations: { readOnlyHint: true } };
  const schema = (props) => ({ type: 'object', properties: props, required: Object.keys(props) });
  const menu = menuOf([
    tool('get_issue', [], { ...ro, inputSchema: schema({ issue_number: { type: 'string' } }) }),
    tool('find_town', [], { ...ro, inputSchema: schema({ zip: { type: 'string' } }) }),
    tool('get_flag', [], { ...ro, inputSchema: schema({ flag: { type: 'string' } }) }),
    tool('list_page', [], { ...ro, inputSchema: schema({ page: { type: 'integer' } }) }),
  ]);
  const argsOf = (plan) => Object.fromEntries(plan.scenario.steps.filter((s) => s.kind === 'call').map((s) => [s.tool, s.args]));
  const expected = { get_issue: { issue_number: '42' }, find_town: { zip: '02134' }, get_flag: { flag: 'true' }, list_page: { page: 3 } };
  const path = join(tempDir(), 'values.yml');
  // By name, and grouped per tool: both paths keep the text.
  writeFileSync(path, 'issue_number: 42\nzip: 02134\nflag: true\npage: 3\n');
  assert.deepEqual(argsOf(autoScenario(menu, { values: await loadValuesFile(path) })), expected);
  writeFileSync(path, 'get_issue:\n  issue_number: 42\nfind_town:\n  zip: 02134\nget_flag:\n  flag: true\nlist_page:\n  page: 3\n');
  assert.deepEqual(argsOf(autoScenario(menu, { values: await loadValuesFile(path) })), expected);
  // The same as --value.
  const flags = Object.fromEntries(['issue_number=42', 'zip=02134', 'flag=true', 'page=3'].map(parseValueFlag));
  assert.deepEqual(argsOf(autoScenario(menu, { values: flags })), expected);
});

test('autoSummary: over the call budget suggests the budget that fits them, unlocks aside', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const menu = menuOf([
    ...Array.from({ length: 25 }, (_, i) => tool(`get_thing_${i}`, [], ro)),
    tool('enable_toolset', [], { ...ro, inputSchema: { type: 'object', properties: { toolset: { type: 'string', enum: ['a', 'b', 'c'] } }, required: ['toolset'] } }),
  ]);
  const plan = autoScenario(menu);
  assert.ok(plan.called.includes('enable_toolset'), 'the unlock runs outside the budget');
  assert.equal(plan.skipped.filter((s) => s.reason === 'over the call budget').length, 5);
  const text = autoSummary({ ...plan, maxCalls: 20 }).join('\n');
  assert.match(text, /5 over the call budget → --max-calls 25\b/);
  assert.match(autoSummary({ ...plan, maxCalls: 10 }).join('\n'), /--max-calls 15\b/);
});

test('autoScenario: --assume-read-only calls the named unmarked tools, never a write', async () => {
  const menu = await probe();
  const why = Object.fromEntries(autoScenario(menu).skipped.map((s) => [s.tool, s.reason]));
  assert.equal(why.read_wiki, 'unmarked');
  assert.equal(why.ask_question, 'unmarked');
  assert.equal(why.delete_wiki, 'not read-only');
  const plan = autoScenario(menu, { assumeReadOnly: ['read_wiki', 'ask_question', 'delete_wiki', 'nope', 'git_status'] });
  assert.deepEqual([...plan.assumed].sort(), ['ask_question', 'read_wiki']);
  assert.deepEqual([...plan.scenario.assumeReadOnly].sort(), ['ask_question', 'read_wiki']);
  assert.ok(!plan.called.includes('delete_wiki'));
  assert.deepEqual(plan.ignored.map((x) => x.input), ['--assume-read-only delete_wiki', '--assume-read-only nope', '--assume-read-only git_status']);
  assert.match(plan.ignored[0].why, /destructiveHint: true/);
});

test('cli: session --auto with values and assumed tools: one finding per repeated error, the flags to pass, loud about what it called on your word', async () => {
  const cwd = tempDir();
  const calls = join(cwd, 'calls.jsonl');
  const server = ['--', process.execPath, join(FIXTURES, 'auto-server.mjs')];
  const bare = await run(['session', '--auto', '--processes', '1', ...server], { cwd });
  assert.match(bare.stdout, /auto: called \d+ tools/);
  assert.match(bare.stdout, /not called: 4 need values the schema doesn't give → --value repo_path=… \(2\)/);
  assert.match(bare.stdout, /2 not marked read-only → --assume-read-only ask_question,read_wiki if they only read/);
  // broken_search is called twice (it's also the repeat at the end): one finding, both steps.
  const r = await run(['session', '--auto', '--json', '--processes', '1', '--value', 'repo_path=/src/app', '--value', 'timezone=UTC', '--assume-read-only', 'read_wiki,delete_wiki', '--env', `CALLS=${calls}`, ...server], { cwd });
  const out = JSON.parse(r.stdout);
  const errors = out.findings.filter((f) => f.rule === 'session/tool-error');
  assert.equal(errors.length, 1, JSON.stringify(out.findings, null, 1));
  assert.match(errors[0].message, /^Steps \d+ and \d+: broken_search returned an error, the same one each time: “Search engine rejected/);
  assert.match(errors[0].fix, /--value broken_search\.<param>=…/);
  const word = out.findings.find((f) => f.rule === 'session/assumed-read-only');
  assert.match(word.message, /read_wiki, which the server doesn't mark readOnlyHint, on your word \(--assume-read-only\)/);
  assert.ok(out.steps.some((s) => /on your word/.test(s.note ?? '')));
  const called = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(called.some((c) => c.name === 'git_status' && c.args.repo_path === '/src/app'));
  assert.ok(!called.some((c) => c.name === 'delete_wiki'), 'a write is never called on the user\'s word');
  assert.ok(!called.some((c) => c.name === 'fetch_urls'), 'no call with an empty list');
  assert.deepEqual(out.auto.ignored.map((x) => x.input), ['--assume-read-only delete_wiki']);
  const usage = await run(['session', '--scenario', 'x.yml', '--value', 'a=1', ...server], { cwd });
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /go with --auto/);
});

test('session: a menu that varies on every list is one root cause, not an edit per step (PayPal list_transactions.end_date)', async () => {
  const scenario = parseScenario({ steps: ['list', { call: 'git_status', args: { repo_path: '/x' } }, 'list'] });
  const r = await session(autoServer({ CLOCK: '1' }), scenario, { timeoutMs: 15_000 });
  const rules = r.findings.map((f) => f.rule);
  assert.deepEqual(rules.filter((x) => x === 'menu/process-variance'), ['menu/process-variance']);
  assert.ok(!rules.includes('session/edit'), rules.join(','));
  assert.ok(!rules.includes('session/unannounced'), rules.join(','));
  const known = r.findings.find((f) => f.rule === 'session/known-variance');
  assert.equal(known.severity, 'info');
  assert.match(known.message, /Same cause as menu\/process-variance \(before step 1\)/);
  assert.match(known.detail[0], /^list_transactions: inputSchema\.properties\.end_date\.default: "/);
  assert.match(r.findings.find((f) => f.rule === 'menu/process-variance').fix, /not the current time/);
  // With one process, the first list that differs is the finding; later ones point to it.
  const one = await session(autoServer({ CLOCK: '1' }), scenario, { timeoutMs: 15_000, processes: 1 });
  assert.deepEqual(one.findings.filter((f) => f.rule === 'session/edit').map((f) => f.step), [1]);
  assert.match(one.findings.find((f) => f.rule === 'session/known-variance').message, /^Steps 2 and 3: the menu changed again.*session\/edit \(at step 1\)/);
  // A menu that doesn't vary on its own: nothing of the kind.
  const still = await session(autoServer(), scenario, { timeoutMs: 15_000 });
  assert.deepEqual(still.findings.map((f) => f.rule), []);
});
