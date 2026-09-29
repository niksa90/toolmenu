import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffMenus, versionBump } from '../dist/diff.js';
import { buildMenu, loadMenu } from '../dist/menu.js';
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

// One block repeated in a tool's schema, inline, then moved into $defs: the refactor
// from the review that prompted this (content_generateMessageHtml, −899 tokens).
const block = { type: 'object', properties: { text: { type: 'string' }, size: { type: 'string', enum: ['s', 'm', 'l'] } }, required: ['text'] };
const inlined = (b = block) => ({ type: 'object', properties: { header: b, footer: b, body: b }, required: ['body'] });
const referenced = (b = block) => ({ type: 'object', $defs: { Block: b }, properties: { header: { $ref: '#/$defs/Block' }, footer: { $ref: '#/$defs/Block', description: 'Shown last.' }, body: { $ref: '#/$defs/Block' } }, required: ['body'] });
const gen = (inputSchema, description = 'Generate.') => menu([{ name: 'gen', description, inputSchema }]);

test('a $ref refactor that accepts the same input is one notice with its token change, not a widened type', () => {
  const after = referenced();
  delete after.properties.footer.description;
  const d = diffMenus(gen(inlined()), gen(after), { release: { before: '1.0.0', after: '1.0.1' } });
  assert.deepEqual(rules(d), ['diff/schema-equivalent:gen']);
  assert.match(d.findings[0].message, /accepts the same input: ~\d+ tokens fewer/);
  assert.equal(d.suggestedBump, 'patch');
  assert.ok(d.tokens.delta < 0);
});

test('breaking changes inside $defs and inside nested objects are breaking, with their path', () => {
  const narrower = { type: 'object', properties: { text: { type: 'integer' }, size: { type: 'string', enum: ['s'] }, lang: { type: 'string' } }, required: ['text', 'lang'] };
  for (const [label, before, after] of [
    ['$defs', referenced(), referenced(narrower)],
    ['inline', inlined(), inlined(narrower)],
  ]) {
    const d = diffMenus(gen(before), gen(after));
    assert.equal(d.suggestedBump, 'major', label);
    const msgs = d.findings.map((f) => `${f.rule}: ${f.message.split(/[ :]/)[0]}`);
    for (const expected of ['diff/param-type: gen.body.text', 'diff/enum-narrowed: gen.body.size', 'diff/param-required: gen.body.lang']) {
      assert.ok(msgs.includes(expected), `${label}: ${expected} in ${msgs.join('; ')}`);
    }
    assert.ok(!d.findings.some((f) => f.rule === 'diff/type-widened'), label);
  }
});

test('arrays of objects are compared item field by item field', () => {
  const rows = (id) => ({ type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { id }, required: ['id'] } } } });
  const d = diffMenus(gen(rows({ type: 'string' })), gen(rows({ type: 'integer' })));
  assert.deepEqual(d.findings.map((f) => `${f.rule}: ${f.message.split(' ')[0]}`), ['diff/param-type: gen.rows[].id']);
});

test('a recursive $ref neither hangs nor hides a change', () => {
  const tree = (label) => ({ type: 'object', $defs: { Node: { type: 'object', properties: { label, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } }, properties: { root: { $ref: '#/$defs/Node' } } });
  assert.deepEqual(diffMenus(gen(tree({ type: 'string' })), gen(tree({ type: 'string' }))).findings, []);
  const d = diffMenus(gen(tree({ type: 'string' })), gen(tree({ type: 'integer' })));
  assert.ok(d.findings.some((f) => f.rule === 'diff/param-type' && f.message.startsWith('gen.root.label')), d.findings.map((f) => f.message).join('; '));
  assert.equal(d.suggestedBump, 'major');
});

// zod: .nullable() on an array, and z.discriminatedUnion, become anyOf/oneOf.
const marks = (values) => ({ anyOf: [{ type: 'array', items: { type: 'string', enum: values } }, { type: 'null' }] });
const shared = (values) => ({ type: 'object', $defs: { Text: { type: 'object', properties: { text: { type: 'string' }, marks: marks(values) } } }, properties: { title: { $ref: '#/$defs/Text' }, body: { $ref: '#/$defs/Text' } } });

test('an enum narrowed inside a union, behind a shared $ref, is breaking (the reporter\'s marks)', () => {
  const d = diffMenus(gen(shared(['bold', 'italic', 'code'])), gen(shared(['bold', 'italic'])));
  assert.equal(d.suggestedBump, 'major');
  assert.deepEqual(d.findings.map((f) => `${f.severity} ${f.rule}: ${f.message.split(':')[0]}`).sort(), [
    'error diff/enum-narrowed: gen.body.marks (array option) (array items)',
    'error diff/enum-narrowed: gen.title.marks (array option) (array items)',
  ]);
  // Widened, it's minor; nothing but the enum changed, so nothing else is said.
  assert.equal(diffMenus(gen(shared(['bold'])), gen(shared(['bold', 'code']))).suggestedBump, 'minor');
});

test('union options: removed is breaking, added is minor, matched by discriminator and compared inside', () => {
  const text = { type: 'object', properties: { kind: { const: 'text' }, value: { type: 'string' } }, required: ['kind'] };
  const image = (format) => ({ type: 'object', properties: { kind: { const: 'image' }, url: { type: 'string', format } }, required: ['kind'] });
  const block = (options) => ({ type: 'object', properties: { block: { oneOf: options } } });
  const gone = diffMenus(gen(block([text, image('uri')])), gen(block([text])));
  assert.deepEqual(rules(gone), ['diff/param-type:gen']);
  assert.match(gone.findings[0].message, /gen\.block: no longer accepts the kind="image" option/);
  assert.equal(gone.suggestedBump, 'major');
  const added = diffMenus(gen(block([text])), gen(block([text, image('uri')])));
  assert.deepEqual(rules(added), ['diff/type-widened:gen']);
  // Options in another order are matched by kind, not position; a change inside one is found.
  const inside = diffMenus(gen(block([text, image('uri')])), gen(block([{ ...image('uri'), required: ['kind', 'url'] }, text])));
  assert.deepEqual(inside.findings.map((f) => f.message.split(' ')[0]), ['gen.block(kind="image").url']);
  assert.equal(inside.findings[0].rule, 'diff/param-required');
  // Nullable added to a plain type widens; taken away, it breaks.
  const plain = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
  const nullable = { type: 'object', properties: { tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] } } };
  assert.equal(diffMenus(gen(plain), gen(nullable)).suggestedBump, 'minor');
  assert.equal(diffMenus(gen(nullable), gen(plain)).suggestedBump, 'major');
});

test('a recursive schema refactored into $defs is equivalent; a change in the recursive definition is found once', () => {
  const node = (label) => ({ type: 'object', properties: { label: { type: label }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } });
  const b = { type: 'object', properties: { text: { type: 'string' }, size: { type: 'string', enum: ['s', 'm'] } } };
  const before = { type: 'object', $defs: { Node: node('string') }, properties: { tree: { $ref: '#/$defs/Node' }, header: b, footer: b } };
  const after = { type: 'object', $defs: { Node: node('string'), B: b }, properties: { tree: { $ref: '#/$defs/Node' }, header: { $ref: '#/$defs/B' }, footer: { $ref: '#/$defs/B' } } };
  // Before: no findings at all, not even this notice.
  assert.deepEqual(rules(diffMenus(gen(before), gen(after))), ['diff/schema-equivalent:gen']);
  const changed = diffMenus(gen({ ...before, $defs: { Node: node('string') } }), gen({ ...before, $defs: { Node: node('integer') } }));
  assert.deepEqual(changed.findings.map((f) => f.message.split(' ')[0]), ['gen.tree.label']);
});

test('a schema change no rule classifies is never silent', () => {
  // A keyword toolmenu doesn't compare, deep in a union option: still a "review it".
  const s = (min) => ({ type: 'object', properties: { v: { anyOf: [{ type: 'object', properties: { n: { type: 'integer', minimum: min } } }, { type: 'null' }] } } });
  const d = diffMenus(gen(s(0)), gen(s(1)));
  assert.ok(d.findings.length > 0 && d.findings.every((f) => f.rule === 'diff/schema-other'), JSON.stringify(d.findings));
});

test('only the $schema dialect changing, in several tools, is one notice naming them (mongodb-mcp-server 3.0.0)', () => {
  const s = (dialect, extra = {}) => ({ $schema: dialect, type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false, ...extra });
  const [d7, d20] = ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema'];
  const names = ['connect', 'find', 'count'];
  const d = diffMenus(menu(names.map((n) => ({ name: n, inputSchema: s(d7) }))), menu(names.map((n) => ({ name: n, inputSchema: s(d20) }))));
  assert.deepEqual(rules(d), ['diff/schema-dialect']);
  assert.match(d.findings[0].message, /^3 tools declare a different JSON Schema dialect/);
  assert.deepEqual(d.findings[0].detail, ['connect, find, count']);
  // One tool: said for it. With another change outside the parameters: still a review.
  assert.deepEqual(rules(diffMenus(menu([{ name: 'find', inputSchema: s(d7) }]), menu([{ name: 'find', inputSchema: s(d20) }]))), ['diff/schema-dialect:find']);
  assert.deepEqual(rules(diffMenus(menu([{ name: 'find', inputSchema: s(d7) }]), menu([{ name: 'find', inputSchema: s(d20, { additionalProperties: true }) }]))), ['diff/schema-other:find']);
});

test('a $ref to another document is left as it is', () => {
  const remote = { type: 'object', properties: { cfg: { $ref: 'https://example.com/schema.json' } } };
  assert.deepEqual(diffMenus(gen(remote), gen(structuredClone(remote))).findings, []);
});

test('a const is a one-value enum: changing it breaks callers, adding one narrows', () => {
  const withMode = (mode) => menu([{ name: 'run_query', inputSchema: schema({ mode }) }]);
  const changed = diffMenus(withMode({ type: 'string', const: 'fast' }), withMode({ type: 'string', const: 'safe' }));
  assert.deepEqual(rules(changed), ['diff/enum-narrowed:run_query']);
  assert.equal(changed.suggestedBump, 'major');
  assert.deepEqual(rules(diffMenus(withMode(str), withMode({ type: 'string', const: 'fast' }))), ['diff/enum-narrowed:run_query']);
  assert.deepEqual(rules(diffMenus(withMode({ type: 'string', const: 'fast' }), withMode({ type: 'string', enum: ['fast', 'safe'] }))), ['diff/enum-widened:run_query']);
});

test('version bump checks, including 0.x and calendar versions', () => {
  assert.equal(versionBump('1.2.3', '1.2.3foo'), undefined, 'not semver: trailing junk');
  assert.equal(versionBump('v1.2.3', '1.3.0+build.5'), 'minor', 'a v prefix and build metadata still parse');
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

test('tokens count what the model reads: name, description, inputSchema', () => {
  const plain = tool('get_form', ['form_id']);
  const dressed = {
    ...plain,
    title: 'Get form',
    icons: [{ src: 'data:image/png;base64,' + 'A'.repeat(4000) }],
    outputSchema: { type: 'object', properties: { form: { type: 'object', description: 'The form. '.repeat(50) } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { 'x/y': 'z'.repeat(500) },
  };
  const [a, b] = [buildMenu([plain], {}), buildMenu([dressed], {})];
  assert.equal(b.totalTokens, a.totalTokens);
  assert.equal(diffMenus(a, b).tokens.delta, 0);
});

test('loadMenu recounts tokens a baseline file carries (older toolmenu counted every field)', async () => {
  const fresh = buildMenu([tool('a', ['x'])], {});
  const path = join(tempDir(), 'menu.json');
  writeFileSync(path, JSON.stringify({ ...fresh, tools: fresh.tools.map((t) => ({ ...t, tokens: 9999 })), totalTokens: 9999 }));
  const loaded = await loadMenu(path);
  assert.equal(loaded.totalTokens, fresh.totalTokens);
  assert.equal(loaded.tools[0].tokens, fresh.tools[0].tokens);
});

test('a type written as anyOf alternatives is the same type (zod switched between the two)', () => {
  const desc = { description: 'Sort field.' };
  const before = menu([{ name: 't', inputSchema: schema({ sort: { anyOf: [{ type: 'string' }, { type: 'null' }], ...desc } }, []) }]);
  const after = menu([{ name: 't', inputSchema: schema({ sort: { type: ['string', 'null'], ...desc } }, []) }]);
  assert.deepEqual(rules(diffMenus(before, after)), []);
  // A real narrowing written either way is still caught.
  const narrow = menu([{ name: 't', inputSchema: schema({ sort: { type: 'string', ...desc } }, []) }]);
  assert.deepEqual(rules(diffMenus(before, narrow)), ['diff/param-type:t']);
});

test('a new required parameter with a default says so', () => {
  const before = menu([{ name: 'shot', inputSchema: schema({ type: str }) }]);
  const after = menu([{ name: 'shot', inputSchema: schema({ type: str, scale: { type: 'string', enum: ['css', 'device'], default: 'css' } }) }]);
  const f = diffMenus(before, after).findings.find((f) => f.rule === 'diff/param-required');
  assert.match(f.message, /has a default \("css"\)/);
});
