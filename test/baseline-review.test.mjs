// toolmenu review: should a new menu file replace the committed baseline?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { reviewMenus, formatReview } from '../dist/review.js';
import { FIXTURES, menuOf, run, tempDir } from './helpers.mjs';

const ro = { readOnlyHint: true };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const str = { type: 'string' };
const menu = (tools, version = '1.0.0') => menuOf(tools, { name: 'fx', version });
const search = { name: 'search_forms', description: 'Search forms. Returns form_id for each.', inputSchema: obj({ query: str }), annotations: ro };
const get = { name: 'get_form', description: 'Get one form by form_id.', inputSchema: obj({ form_id: str }), annotations: ro };
const BASE = menu([search, get]);

test('unchanged: the same menu is nothing to accept', () => {
  const r = reviewMenus(BASE, BASE);
  assert.equal(r.verdict, 'unchanged');
  assert.equal(r.accept, true);
});

test('safe: a new read-only tool with no new findings at --fail-on', () => {
  const list = { name: 'list_folders', description: 'List folders. Returns folder_id for each.', inputSchema: obj({}), annotations: ro };
  const r = reviewMenus(BASE, menu([search, get, list]));
  assert.equal(r.verdict, 'safe');
  assert.equal(r.accept, true);
  assert.equal(r.diff.classes.minor.changes, 1);
});

test('breaking: a removed tool, without a release that allows it, then with one', () => {
  const after = menu([search]);
  const none = reviewMenus(BASE, after);
  assert.equal(none.verdict, 'breaking');
  assert.equal(none.accept, false);
  const small = reviewMenus(BASE, after, { release: { before: '1.2.0', after: '1.3.0' } });
  assert.equal(small.verdict, 'breaking');
  assert.equal(small.diff.releaseAs, '2.0.0');
  assert.match(formatReview(small, ['menu.json', 'new.json'], 'text'), /minor bump is too small \(release 2\.0\.0\)/);
  const major = reviewMenus(BASE, after, { release: { before: '1.2.0', after: '2.0.0' } });
  assert.equal(major.verdict, 'breaking-released');
  assert.equal(major.accept, true);
});

test('review: nothing breaks, but the new menu adds a finding at --fail-on', () => {
  // A write named as one, with no annotations: write/unannotated (warn).
  const del = { name: 'delete_form', description: 'Delete a form.', inputSchema: obj({ form_id: str }) };
  const after = menu([search, get, del]);
  assert.equal(reviewMenus(BASE, after).verdict, 'safe', 'a warning is below the default --fail-on');
  const r = reviewMenus(BASE, after, { failOn: 'warn' });
  assert.equal(r.verdict, 'review');
  assert.equal(r.accept, false);
  assert.deepEqual(r.findings.introduced.map((f) => f.rule).filter((x) => x === 'write/unannotated'), ['write/unannotated']);
  // Turned off in the config: nothing new, so safe.
  assert.equal(reviewMenus(BASE, after, { failOn: 'warn', rules: { 'write/unannotated': 'off', 'write/no-dry-run': 'off' } }).verdict, 'safe');
});

test('findings gone are counted, and a fixed menu is safe', () => {
  const del = { name: 'delete_form', description: 'Delete a form.', inputSchema: obj({ form_id: str }) };
  const fixed = { ...del, inputSchema: obj({ form_id: str, dry_run: { type: 'boolean' } }, ['form_id']), annotations: { destructiveHint: true } };
  const r = reviewMenus(menu([search, get, del]), menu([search, get, fixed]), { failOn: 'warn' });
  assert.ok(r.findings.resolved.some((f) => f.rule === 'write/unannotated'));
  assert.equal(r.findings.introduced.length, 0);
  assert.equal(r.verdict, 'safe');
});

test('one tool\'s finding that became a summary of two is one changed finding, worse because it names a new tool', () => {
  // write/unannotated: about one tool, then a summary of two.
  const del = { name: 'delete_form', description: 'Delete a form.', inputSchema: obj({ form_id: str }) };
  const send = { name: 'send_form', description: 'Send a form to a user.', inputSchema: obj({ form_id: str, email: str }) };
  const r = reviewMenus(menu([search, get, del]), menu([search, get, del, send]), { failOn: 'warn' });
  const c = r.findings.changed.find((x) => x.after.rule === 'write/unannotated');
  assert.ok(c, JSON.stringify(r.findings, null, 1));
  assert.equal(c.worse, true, 'it now names send_form');
  assert.ok(!r.findings.introduced.some((f) => f.rule === 'write/unannotated'));
  assert.ok(!r.findings.resolved.some((f) => f.rule === 'write/unannotated'));
  assert.equal(r.verdict, 'review');
});

test('markdown: server text stays text', () => {
  const hostile = { ...search, name: 'x` ![t](https://evil.example/t.png) @org/team `' };
  const r = reviewMenus(BASE, menu([search, get, hostile]));
  const md = formatReview(r, ['menu.json', 'new.json'], 'markdown');
  // Outside code spans, the image and the mention are escaped: they render as text.
  for (const line of md.split('\n')) {
    const outside = line.replace(/(`+)[^`]*?\1/g, '');
    assert.doesNotMatch(outside, /(?<!\\)!(?<!\\)\[t\]/, line);
    assert.doesNotMatch(outside, /(^|\s)@org\/team/, line);
  }
  assert.match(md, /### toolmenu review/);
});

test('CLI: real filesystem releases, exit codes follow the verdict', async () => {
  const dir = join(FIXTURES, 'menus');
  const breaking = await run(['review', join(dir, 'server-filesystem-2026.1.14.json'), join(dir, 'server-filesystem-2026.8.31.json')]);
  assert.equal(breaking.code, 1, breaking.stdout + breaking.stderr);
  assert.match(breaking.stdout, /don't accept as is: 1 breaking change/);
  assert.match(breaking.stdout, /diff\/safety-hint/);
  const released = await run(['review', '--release', '1.0.0..2.0.0', join(dir, 'server-filesystem-2026.1.14.json'), join(dir, 'server-filesystem-2026.8.31.json')]);
  assert.equal(released.code, 0, released.stdout);
  const safe = await run(['review', '--json', join(dir, 'server-filesystem-2025.7.1.json'), join(dir, 'server-filesystem-2025.11.25.json')]);
  assert.equal(safe.code, 0, safe.stdout + safe.stderr);
  const json = JSON.parse(safe.stdout);
  assert.equal(json.verdict, 'safe');
  assert.equal(json.accept, true);
  assert.ok(json.findings.resolved.some((f) => f.rule === 'write/unannotated'), 'the 2025.11.25 release annotated its writes');
});

test('CLI: usage errors', async () => {
  assert.equal((await run(['review', 'only-one.json'])).code, 2);
  assert.equal((await run(['review', 'a.json', 'b.json', '--', 'node', 'server.js'])).code, 2);
  const dir = tempDir();
  writeFileSync(join(dir, 'bad.json'), '{');
  assert.equal((await run(['review', join(dir, 'bad.json'), join(dir, 'bad.json')])).code, 2);
});

test('a note that something was not compared is not a change: still unchanged (bench, 2026-11-09)', () => {
  // A snapshot read with --lists against a session's union menu (no lists): diff says
  // diff/lists-unread, and the menus are otherwise the same.
  const withLists = { ...BASE, prompts: [{ name: 'p' }] };
  const r = reviewMenus(withLists, BASE);
  assert.ok(r.diff.findings.some((f) => f.rule === 'diff/lists-unread'));
  assert.equal(r.verdict, 'unchanged');
});
