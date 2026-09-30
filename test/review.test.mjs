// Regressions for the pre-release code review (0.7.0): each test is one finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cacheBreak, compareMenus } from '../dist/compare.js';
import { diffMenus } from '../dist/diff.js';
import { compareVersions } from '../dist/history.js';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { changeFindings, parseScenario, session } from '../dist/session.js';
import { FIXTURES, menuOf, tool } from './helpers.mjs';

const menu = (tools, version = '1.0.0') => menuOf(tools, { name: 'fx', version });
const withProps = (props) => ({ name: 't', description: 'T.', inputSchema: { type: 'object', properties: props } });

test('review 1: a new property order is a change (caches compare bytes)', () => {
  const a = menuOf([withProps({ a: { type: 'string' }, b: { type: 'string' } })]).tools;
  const b = menuOf([withProps({ b: { type: 'string' }, a: { type: 'string' } })]).tools;
  assert.deepEqual(compareMenus(a, b).map((c) => c.kind), ['serialization']);
  assert.deepEqual(cacheBreak(a, b)?.position, 0);
  const found = runRules(MENU_RULES, { menu: menuOf([withProps({ a: { type: 'string' }, b: { type: 'string' } })]), secondList: b, pages: [], capabilities: {}, usedAuth: false });
  assert.ok(found.some((f) => f.rule === 'menu/nondeterministic'));
});

test('review 2: a classified change on one parameter no longer hides a breaking one on another', () => {
  const before = menu([withProps({ a: { type: 'string', description: 'old' }, b: { type: 'array', items: { type: 'string', enum: ['p', 'q'] } } })]);
  const after = menu([withProps({ a: { type: 'string', description: 'new' }, b: { type: 'array', items: { type: 'string', enum: ['p'] } } })], '1.0.1');
  const d = diffMenus(before, after, { release: { before: '1.0.0', after: '1.0.1' } });
  assert.ok(d.findings.some((f) => f.rule === 'diff/enum-narrowed' && f.message.startsWith('`t.b[]`')));
  assert.equal(d.suggestedBump, 'major');
  const nested = diffMenus(menu([withProps({ a: { type: 'object', properties: { x: { type: 'string' } } } })]), menu([withProps({ a: { type: 'object', properties: { y: { type: 'string' } } } })]));
  // Nested fields are classified like parameters, with their path.
  assert.deepEqual(nested.findings.map((f) => `${f.rule}: ${f.message.split(' ')[0]}`).sort(), ['diff/param-added: `t.a.y`', 'diff/param-dropped: `t.a.x`']);
});

test('review 4: ignored tools and rules set to off do not force a bump', () => {
  const before = menu([tool('get_a'), tool('debug_x')]);
  const after = menu([tool('get_a')], '1.0.1');
  const d = diffMenus(before, after, { ignore: ['debug_*'], release: { before: '1.0.0', after: '1.0.1' } });
  assert.equal(d.suggestedBump, 'none');
  assert.deepEqual(d.findings, []);
  const off = diffMenus(before, after, { rules: { 'diff/tool-removed': 'off' }, release: { before: '1.0.0', after: '1.0.1' } });
  assert.equal(off.suggestedBump, 'none');
});

test('review 5: history orders by version, so a backport is diffed against its own line', () => {
  const order = ['1.0.0', '2.0.0', '1.0.1', '2.0.0-rc.1', '1.10.0'].sort(compareVersions);
  assert.deepEqual(order, ['1.0.0', '1.0.1', '1.10.0', '2.0.0-rc.1', '2.0.0']);
});

test('review 6: a version that goes backwards is flagged; a prerelease is not judged', () => {
  const before = menu([tool('a', ['x'])]);
  const after = menu([]);
  const back = diffMenus(before, after, { release: { before: '2.0.0', after: '1.9.0' } });
  assert.equal(back.bumpNotChecked, 'version went backwards');
  assert.ok(back.findings.some((f) => f.rule === 'diff/version-backwards' && /went backwards/.test(f.message)));
  const rc = diffMenus(before, after, { release: { before: '1.0.0-rc.1', after: '1.0.0' } });
  assert.equal(rc.bumpNotChecked, 'prerelease');
  assert.ok(!rc.findings.some((f) => f.rule === 'diff/version-bump'));
});

test('review 7: a call that times out but changed the menu is reported at its own step', async () => {
  const target = { kind: 'stdio', command: process.execPath, args: [join(FIXTURES, 'slow-unlock-server.mjs')], env: {} };
  // The call never answers in time, whatever the timeout (the fixture waits for the
  // client to give up), so the timeout can leave room for a busy machine to start
  // the server: 1 s was shorter than a start under load (initialize timed out).
  const r = await session(target, parseScenario({ steps: [{ call: 'slow_unlock' }, 'list'] }), { timeoutMs: 10_000 });
  const rules = r.findings.map((f) => `${f.step}:${f.rule}`);
  assert.ok(rules.includes('1:session/step-failed'), rules.join(', '));
  assert.ok(rules.includes('1:session/mid-insert'), rules.join(', '));
  assert.ok(!rules.some((x) => x.startsWith('2:session/')), 'nothing blamed on the list step');
  const change = r.findings.find((f) => f.rule === 'session/mid-insert');
  assert.ok(change.detail.some((d) => /the call failed, but the menu changed/.test(d)));
});

test('a call that runs out toolmenu\'s own timeout says so and suggests --timeout, not the server or the arguments', async () => {
  const target = { kind: 'stdio', command: process.execPath, args: [join(FIXTURES, 'slow-unlock-server.mjs')], env: {} };
  const r = await session(target, parseScenario({ steps: [{ call: 'slow_unlock' }] }), { timeoutMs: 1000 });
  const failed = r.findings.find((f) => f.rule === 'session/step-failed');
  assert.ok(failed, r.findings.map((f) => f.rule).join(', '));
  assert.match(failed.fix, /didn't answer within toolmenu's 1 s request timeout/);
  assert.match(failed.fix, /--timeout 4000/);
  assert.doesNotMatch(failed.fix, /the error is the server's|--value/);
  assert.equal(failed.confidence, undefined);
});

test('review 8: tools removed from the end give a sensible cost line', () => {
  const before = menuOf([tool('a'), tool('b')]).tools;
  const after = menuOf([tool('a')]).tools;
  const f = changeFindings(before, after, compareMenus(before, after), 1);
  assert.equal(f[0].rule, 'session/remove');
  assert.doesNotMatch(f[0].detail[0], /positions 1–0|~0 /);
  assert.match(f[0].detail[0], /removed from the end/);
});

test('review 9: an append in the same step as an edit is still an append', () => {
  const before = menuOf([tool('a')]).tools;
  const after = menuOf([tool('a', [], { description: 'edited' }), tool('z')]).tools;
  const rules = changeFindings(before, after, compareMenus(before, after), 1).map((f) => f.rule).sort();
  assert.deepEqual(rules, ['session/append', 'session/edit']);
});

// Second review pass, on the fixes above.
test('review 2b: array item types and newly added item constraints are classified', () => {
  const arr = (items) => menu([withProps({ a: { type: 'array', ...(items ? { items } : {}) } })]);
  const narrowed = diffMenus(arr(), arr({ type: 'string', enum: ['x'] }));
  assert.ok(narrowed.findings.some((f) => f.rule === 'diff/param-type'));
  assert.ok(narrowed.findings.some((f) => f.rule === 'diff/enum-narrowed'));
  assert.equal(narrowed.suggestedBump, 'major');
  const retyped = diffMenus(arr({ type: 'string' }), arr({ type: 'integer' }));
  assert.ok(retyped.findings.some((f) => f.rule === 'diff/param-type'));
  const reshaped = diffMenus(menu([withProps({ a: { type: 'string' } })]), menu([withProps({ a: { type: 'array', items: { type: 'string' } } })]));
  assert.deepEqual(reshaped.findings.map((f) => f.rule), ['diff/param-type'], 'no duplicate schema-other');
});

test('review 4b: ignored tools do not pair into renames or reorders', () => {
  const before = menu([tool('debug_get_user', ['user_id']), tool('b'), tool('debug_a'), tool('debug_z')]);
  const after = menu([tool('get_user', ['user_id']), tool('b'), tool('debug_z'), tool('debug_a')], '1.3.0');
  const d = diffMenus(before, after, { ignore: ['debug_*'], release: { before: '1.2.0', after: '1.3.0' } });
  assert.deepEqual(d.findings.map((f) => f.rule), ['diff/tool-added']);
  assert.equal(d.suggestedBump, 'minor');
});

test('review 6b: backwards has its own rule and wording; build metadata is not a prerelease', () => {
  const server = diffMenus(menu([tool('a')], '2.0.0'), menu([tool('a')], '1.0.0'), { serverVersionIsRelease: true });
  const back = server.findings.find((f) => f.rule === 'diff/version-backwards');
  assert.ok(back);
  assert.doesNotMatch(back.message, /--release/);
  assert.ok(!server.findings.some((f) => f.rule === 'diff/version-bump'));
  const build = diffMenus(menu([tool('a', ['x'])]), menu([]), { release: { before: '1.0.0+build-1', after: '1.0.1' } });
  assert.equal(build.actualBump, 'patch');
  assert.ok(build.findings.some((f) => f.rule === 'diff/version-bump'));
});

// Third review pass.
test('review 2c: nullable arrays keep their item checks; a widened type still reports new constraints', () => {
  const p = (a) => menu([withProps({ a })]);
  const nullable = diffMenus(p({ type: ['array', 'null'], items: { enum: ['a', 'b'] } }), p({ type: ['array', 'null'], items: { enum: ['a'] } }));
  assert.ok(nullable.findings.some((f) => f.rule === 'diff/enum-narrowed'));
  const mixed = diffMenus(p({ type: 'array', items: { enum: ['a', 'b'] } }), p({ type: ['array', 'null'], items: { enum: ['a'] } }));
  assert.equal(mixed.suggestedBump, 'major');
  const widened = diffMenus(p({ type: 'string' }), p({ type: ['string', 'null'], maxLength: 5 }));
  assert.deepEqual(widened.findings.map((f) => f.rule).sort(), ['diff/schema-other', 'diff/type-widened']);
});
