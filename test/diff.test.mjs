import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffMenus, versionBump } from '../dist/diff.js';
import { loadMenu } from '../dist/menu.js';
import { FIXTURES, menuOf, run, tempDir, tool } from './helpers.mjs';

const menu = (tools, version = '1.0.0') => menuOf(tools, { name: 'fx', version });
const rules = (result) => result.findings.map((f) => `${f.rule}${f.tool ? ':' + f.tool : ''}`).sort();
const str = { type: 'string' };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

test('no changes: no findings, no bump', () => {
  const m = menu([tool('get_form', ['form_id'])]);
  const d = diffMenus(m, m);
  assert.deepEqual(d.findings, []);
  assert.equal(d.suggestedBump, 'none');
  assert.equal(d.tokens.delta, 0);
});

test('removed tool is breaking; added tool is minor', () => {
  const d = diffMenus(menu([tool('a', ['x']), tool('b', ['y'])]), menu([tool('a', ['x']), tool('c', ['z', 'w'])], '2.0.0'));
  assert.deepEqual(rules(d), ['diff/tool-added:c', 'diff/tool-removed:b']);
  assert.equal(d.suggestedBump, 'major');
  assert.equal(d.findings.find((f) => f.rule === 'diff/tool-removed').class, 'breaking');
});

test('a rename is reported as one rename, not a removal plus an addition', () => {
  const d = diffMenus(menu([tool('get_audit_trail', ['since'])]), menu([tool('get_change_log', ['since'])], '2.0.0'));
  assert.deepEqual(rules(d), ['diff/tool-renamed:get_change_log']);
  assert.match(d.findings[0].message, /get_audit_trail was renamed to get_change_log/);
});

test('parameter changes are classified', () => {
  const before = menu([
    { name: 't', description: 'T.', inputSchema: schema({ keep: str, gone: str, opt: str, req: str, num: str, color: { type: 'string', enum: ['red', 'blue'] }, size: { type: 'string', enum: ['s'] } }, ['keep', 'req']) },
  ]);
  const after = menu([
    { name: 't', description: 'T.', inputSchema: schema({ keep: str, opt: str, req: str, num: { type: 'number' }, color: { type: 'string', enum: ['red'] }, size: { type: 'string', enum: ['s', 'm'] }, fresh: str, extra: str }, ['keep', 'opt', 'fresh']) },
  ], '2.0.0');
  assert.deepEqual(rules(diffMenus(before, after)), [
    'diff/enum-narrowed:t',
    'diff/enum-widened:t',
    'diff/param-added:t',
    'diff/param-dropped:t',
    'diff/param-relaxed:t',
    'diff/param-required:t',
    'diff/param-required:t',
    'diff/param-type:t',
  ]);
});

test('safety hints use the spec defaults (readOnlyHint false, destructiveHint true)', () => {
  const write = (annotations) => menu([tool('write_file', ['path'], annotations === undefined ? {} : { annotations })]);
  const rules = (result) => result.findings.filter((f) => f.rule !== 'diff/version-bump').map((f) => `${f.rule}:${f.tool}`).sort();
  // unannotated is already "destructive", so making it explicit changes nothing
  assert.deepEqual(rules(diffMenus(write(undefined), write({ readOnlyHint: false, destructiveHint: true }))), ['diff/annotations:write_file']);
  assert.deepEqual(rules(diffMenus(write({ destructiveHint: false }), write({ destructiveHint: true }))), ['diff/safety-hint:write_file']);
  assert.deepEqual(rules(diffMenus(write({ readOnlyHint: true }), write({}))), ['diff/safety-hint:write_file']);
  // becoming safer is not breaking
  assert.equal(diffMenus(write({}), write({ readOnlyHint: true })).suggestedBump, 'patch');
});

test('description, output schema, annotation and other field changes are notices', () => {
  const before = menu([tool('t', ['a'], { title: 'T' })]);
  const after = menu([tool('t', ['a'], { title: 'Tee', description: 'New words.', outputSchema: schema({ ok: { type: 'boolean' } }), annotations: { openWorldHint: false } })], '1.0.1');
  const d = diffMenus(before, after);
  assert.deepEqual(rules(d), ['diff/annotations:t', 'diff/description:t', 'diff/other:t', 'diff/schema-other:t']);
  assert.equal(d.suggestedBump, 'patch');
  assert.match(d.findings.find((f) => f.rule === 'diff/schema-other').message, /now declares an outputSchema/);
  assert.deepEqual(d.findings.find((f) => f.rule === 'diff/description').detail, ['- t.', '+ New words.']);
});

test('an empty old schema is not read as every parameter being new', () => {
  const before = menu([{ name: 't', description: 'T.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#' } }]);
  const after = menu([tool('t', ['path'])], '1.0.1');
  assert.deepEqual(rules(diffMenus(before, after)), ['diff/description:t', 'diff/schema-other:t']);
});

test('order changes are a notice between releases', () => {
  const d = diffMenus(menu([tool('a'), tool('b')]), menu([tool('b'), tool('a')], '1.0.1'));
  assert.deepEqual(rules(d), ['diff/order']);
  assert.equal(d.findings[0].severity, 'info');
});

test('token change is reported per tool, largest first', () => {
  const d = diffMenus(menu([tool('a')]), menu([tool('a', [], { description: 'A much longer description than before. '.repeat(20) }), tool('b')], '1.1.0'));
  assert.ok(d.tokens.delta > 0);
  assert.equal(d.tokens.tools[0].name, 'a');
  assert.equal(d.tokens.tools.reduce((s, t) => s + t.delta, 0), d.tokens.delta);
});

test('version bump checks, including 0.x and calendar versions', () => {
  assert.equal(versionBump('1.2.3', '1.2.4'), 'patch');
  assert.equal(versionBump('1.2.3', '2.0.0'), 'major');
  assert.equal(versionBump('1.2.3', '1.2.3'), 'none');
  assert.equal(versionBump('2026.1.14', '2026.8.31'), undefined);
  const breaking = (from, to) => diffMenus(menu([tool('a', ['x'])]), menu([]), { release: { before: from, after: to } }).findings.filter((f) => f.rule === 'diff/version-bump');
  assert.equal(breaking('1.2.3', '1.3.0').length, 1, 'breaking change in a minor release');
  assert.equal(breaking('1.2.3', '2.0.0').length, 0);
  assert.equal(breaking('0.2.0', '0.3.0').length, 0, 'under 1.0, a minor bump may break');
  assert.equal(breaking('0.2.0', '0.2.0').length, 1);
});

test('token budget and config', () => {
  const before = menu([tool('a')]);
  const after = menu([tool('a'), tool('b')], '1.1.0');
  assert.ok(rules(diffMenus(before, after, { tokenBudget: 1 })).includes('diff/token-budget'));
  assert.deepEqual(rules(diffMenus(before, after, { rules: { 'diff/tool-added': 'off' } })), []);
  assert.deepEqual(rules(diffMenus(before, after, { ignore: ['b'] })), []);
});

test('ignored tools leave the token change and the budget too', () => {
  const before = menu([tool('a'), tool('debug_dump')]);
  const after = menu([tool('a'), tool('debug_dump', [], { description: 'Dump everything. '.repeat(400) })]);
  const d = diffMenus(before, after, { ignore: ['debug_*'], tokenBudget: 1000 });
  assert.equal(d.tokens.delta, 0);
  assert.deepEqual(d.tokens.tools, []);
  assert.deepEqual(rules(d), []);
  assert.ok(rules(diffMenus(before, after, { tokenBudget: 1000 })).includes('diff/token-budget'));
});

test('real data: server-filesystem 2026.1.14 → 2026.8.31', async () => {
  const before = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2026.1.14.json'));
  const after = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2026.8.31.json'));
  const d = diffMenus(before, after);
  assert.deepEqual(d.findings.filter((f) => f.class === 'breaking').map((f) => f.tool), ['move_file']);
  assert.equal(d.findings.filter((f) => f.rule === 'diff/annotations').length, 13, 'openWorldHint added to every other tool');
  assert.ok(d.tokens.delta > 0);
});

test('real data: an empty-schema menu (2025.7.1 installed today) does not produce false breaking changes', async () => {
  const before = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2025.7.1.json'));
  const after = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2025.11.25.json'));
  const d = diffMenus(before, after);
  assert.deepEqual(d.findings.filter((f) => f.class === 'breaking'), []);
  assert.equal(d.suggestedBump, 'minor');
});

test('cli: diff exit codes and formats', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'old.json'), JSON.stringify(menu([tool('a', ['x']), tool('b')])));
  writeFileSync(join(dir, 'new.json'), JSON.stringify(menu([tool('b')], '1.0.1')));
  writeFileSync(join(dir, 'same.json'), JSON.stringify(menu([tool('a', ['x']), tool('b')])));
  writeFileSync(join(dir, 'junk.json'), '{"hello": 1}');

  const breaking = await run(['diff', 'old.json', 'new.json'], { cwd: dir });
  assert.equal(breaking.code, 1);
  assert.match(breaking.stdout, /ERROR  diff\/tool-removed/);
  assert.match(breaking.stdout, /1\.0\.0 → 1\.0\.1 \(server-reported\)/);
  assert.match(breaking.stdout, /suggested bump: major · actual: not checked \(pass --release\)/);
  assert.doesNotMatch(breaking.stdout, /diff\/version-bump/, 'serverInfo.version is not the release version');

  const released = await run(['diff', '--release', '2.3.0..2.3.1', 'old.json', 'new.json'], { cwd: dir });
  assert.match(released.stdout, /2\.3\.0 → 2\.3\.1\n/);
  assert.match(released.stdout, /suggested bump: major · actual: patch/);
  assert.match(released.stdout, /WARN   diff\/version-bump/);
  const server = await run(['diff', '--server-version-is-release', 'old.json', 'new.json'], { cwd: dir });
  assert.match(server.stdout, /1\.0\.0 → 1\.0\.1 \(server-reported\)/, 'the label stays when the check uses it');
  assert.match(server.stdout, /suggested bump: major · actual: patch/);
  assert.match(server.stdout, /WARN   diff\/version-bump\n\s+1\.0\.0 → 1\.0\.1 is a patch bump, but the menu has breaking changes/);
  const calendar = await run(['diff', '--release', '2026.1.1..2026.2.1', 'old.json', 'new.json'], { cwd: dir });
  assert.match(calendar.stdout, /actual: not checked \(calendar version\)/);
  assert.doesNotMatch(calendar.stdout, /diff\/version-bump/);
  assert.equal((await run(['diff', '--release', '2.3.0', 'old.json', 'new.json'], { cwd: dir })).code, 2);

  const same = await run(['diff', 'old.json', 'same.json'], { cwd: dir });
  assert.equal(same.code, 0);
  assert.match(same.stdout, /No findings/);

  const json = JSON.parse((await run(['diff', '--json', 'old.json', 'new.json'], { cwd: dir })).stdout);
  assert.equal(json.suggestedBump, 'major');
  assert.ok(json.tokens.delta < 0);

  const gh = await run(['diff', '--format', 'github', 'old.json', 'new.json'], { cwd: dir });
  assert.match(gh.stdout, /^::error title=toolmenu diff\/tool-removed::/m);
  assert.match(gh.stdout, /^::notice title=toolmenu diff::/m);

  assert.equal((await run(['diff', 'old.json'], { cwd: dir })).code, 2);
  const junk = await run(['diff', 'old.json', 'junk.json'], { cwd: dir });
  assert.equal(junk.code, 2);
  assert.match(junk.stderr, /isn't a toolmenu menu file/);
});

test('cli: snapshot then diff, the CI flow', async () => {
  const dir = tempDir();
  const server = ['--', process.execPath, join(FIXTURES, 'sdk-server.mjs')];
  assert.equal((await run(['snapshot', '--out', 'baseline.json', ...server], { cwd: dir })).code, 0);
  assert.equal((await run(['snapshot', '--out', 'current.json', ...server], { cwd: dir })).code, 0);
  const r = await run(['diff', 'baseline.json', 'current.json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /No findings/);
});

test('type changes: widening is minor, narrowing is breaking (real cases)', () => {
  const t = (prop) => menu([{ name: 't', description: 'T.', inputSchema: { type: 'object', properties: { p: prop }, required: ['p'] } }], '1.0.0');
  const rulesOf = (a, b) => diffMenus(t(a), t(b)).findings.filter((f) => f.rule !== 'diff/version-bump').map((f) => f.rule);
  assert.deepEqual(rulesOf({ type: 'boolean' }, { type: ['boolean', 'string'] }), ['diff/type-widened'], 'sequential-thinking 2026.8.31');
  assert.deepEqual(rulesOf({ type: 'object' }, {}), ['diff/type-widened'], 'notion 2.3.1: object → any');
  assert.deepEqual(rulesOf({ type: 'integer' }, { type: 'number' }), ['diff/type-widened']);
  assert.deepEqual(rulesOf({ type: 'number' }, { type: 'integer' }), ['diff/param-type'], 'firecrawl 3.25.0');
  assert.deepEqual(rulesOf({ type: 'string' }, { type: 'number' }), ['diff/param-type']);
  assert.deepEqual(rulesOf({}, { type: 'string' }), ['diff/param-type'], 'any → string narrows');
});

test('0.0.x versions promise nothing, so any bump is fine', () => {
  const bump = (from, to) => diffMenus(menu([tool('a', ['x'])]), menu([]), { release: { before: from, after: to } }).findings.filter((f) => f.rule === 'diff/version-bump');
  assert.equal(bump('0.0.76', '0.0.77').length, 0, 'playwright-mcp');
  assert.equal(bump('0.33.0', '0.34.0').length, 0, 'sentry: 0.x minor may break');
  assert.equal(bump('1.5.0', '1.6.0').length, 1, 'chrome-devtools: 1.x minor may not');
});

test('removing an optional parameter only breaks callers when extra properties are rejected (notion 2.3.1)', () => {
  const t = (props, required, extra = {}) => menu([{ name: 't', description: 'T.', inputSchema: { type: 'object', properties: props, required, ...extra } }], '1.0.0');
  const rulesOf = (a, b) => diffMenus(a, b).findings.filter((f) => f.rule !== 'diff/version-bump').map((f) => f.rule);
  const withVersion = { user_id: { type: 'string' }, 'Notion-Version': { type: 'string', default: '2025-09-03' } };
  assert.deepEqual(rulesOf(t(withVersion, ['user_id']), t({ user_id: { type: 'string' } }, ['user_id'])), ['diff/param-dropped']);
  assert.deepEqual(rulesOf(t(withVersion, ['user_id']), t({ user_id: { type: 'string' } }, ['user_id'], { additionalProperties: false })), ['diff/param-removed', 'diff/schema-other'], 'closing the schema is itself reported');
  assert.deepEqual(rulesOf(t(withVersion, ['user_id', 'Notion-Version']), t({ user_id: { type: 'string' } }, ['user_id'])), ['diff/param-removed']);
});
