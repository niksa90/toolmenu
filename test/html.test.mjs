// The HTML report (--html <path>): one self-contained page per run of snapshot, diff
// or session. No script and nothing fetched, so it opens offline from a CI artifact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffHtml, esc, sessionHtml, snapshotHtml } from '../dist/html.js';
import { diffMenus } from '../dist/diff.js';
import { stepMenu } from '../dist/session.js';
import { FIXTURES, ROOT, menuOf, run, tempDir, tool } from './helpers.mjs';

const menus = join(FIXTURES, 'menus');

/** Self-contained: one document, no script, nothing loaded from elsewhere. */
function assertStandalone(html) {
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.doesNotMatch(html, /<script|<link |<iframe|@import|src="http/i);
  assert.match(html, /prefers-color-scheme:dark/, 'dark mode follows the system');
}

test('stepMenu: what a step did to each tool, in list order', () => {
  const t = (name, tokens = 10) => ({ name, tokens });
  const menu = stepMenu([t('a'), t('x'), t('b'), t('c'), t('y')], [
    { kind: 'added', tool: 'x', position: 1 },
    { kind: 'added', tool: 'y', position: 4 },
    { kind: 'description', tool: 'b', position: 2 },
    { kind: 'moved', tool: 'c', position: 3 },
  ]);
  assert.deepEqual(menu.map((m) => [m.name, m.change]), [['a', undefined], ['x', 'inserted'], ['b', 'edited'], ['c', 'moved'], ['y', 'appended']]);
  assert.deepEqual(stepMenu([t('a')]), [{ name: 'a', tokens: 10 }], 'no changes, no marks');
});

test('stepMenu: by position, so a second tool of the same name marks only itself', () => {
  const t = (name) => ({ name, tokens: 10 });
  const menu = stepMenu([t('search'), t('a'), t('search')], [{ kind: 'added', tool: 'search', position: 2 }]);
  assert.deepEqual(menu.map((m) => m.change), [undefined, undefined, 'appended']);
});

test('esc: markup in tool names and messages is text', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  const html = snapshotHtml(menuOf([tool('<b>bold</b>')]), [{ rule: 'naming/x', severity: 'warn', message: 'see `<i>`', tool: '<b>bold</b>' }]);
  assert.doesNotMatch(html, /<b>bold<\/b>|<i>/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /<code>&lt;i&gt;<\/code>/, 'backticks become code, escaped');
});

test('snapshot --html: the menu in server order, each tool with its status, beside the findings', async () => {
  const cwd = tempDir();
  const r = await run(['snapshot', '--html', 'report.html', '--', process.execPath, join(FIXTURES, 'header-server.mjs')], { cwd });
  assert.match(r.stdout, /toolmenu snapshot/, 'the text report still prints');
  const html = readFileSync(join(cwd, 'report.html'), 'utf8');
  assertStandalone(html);
  assert.match(html, /<title>toolmenu snapshot: header-fixture<\/title>/);
  const menu = JSON.parse(readFileSync(join(cwd, 'menu.json'), 'utf8'));
  const order = [...html.matchAll(/<td class="name">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(order, menu.tools.map((t) => t.name));
  assert.match(html, /spec\/x-mcp-header/);
  assert.match(html, /aria-label="Has a warning"/);
  assert.match(html, /aria-label="No errors or warnings"/, 'clean tools get the check');
});

test('diff --html: before and after per tool, new tools marked, file names in the header', async () => {
  const cwd = tempDir();
  const [a, b] = ['server-filesystem-2025.7.1.json', 'server-filesystem-2026.8.31.json'];
  copyFileSync(join(menus, a), join(cwd, a));
  copyFileSync(join(menus, b), join(cwd, b));
  await run(['diff', a, b, '--html', 'diff.html'], { cwd });
  const html = readFileSync(join(cwd, 'diff.html'), 'utf8');
  assertStandalone(html);
  assert.match(html, /<code title="server-filesystem-2025\.7\.1\.json">server-filesystem-2025\.7\.1\.json<\/code> → /);
  assert.match(html, /Both report 0\.2\.0/);
  assert.match(html, /read_text_file<\/td>.*?New/s);
  assert.match(html, />Minor</, 'the suggested bump');
  assert.match(html, /\+713 tokens/);
});

test('session --html: one row per step, with the menu after it and its findings linked', async () => {
  const cwd = tempDir();
  copyFileSync(join(ROOT, 'examples/unlock.scenario.yml'), join(cwd, 'unlock.scenario.yml'));
  const r = await run(['session', '--scenario', 'unlock.scenario.yml', '--html', 'session.html', '--', process.execPath, join(FIXTURES, 'session-server.mjs')], { cwd });
  assert.equal(r.code, 1, 'errors: exit 1, as without --html');
  const html = readFileSync(join(cwd, 'session.html'), 'utf8');
  assertStandalone(html);
  const rows = html.match(/<tr class="(changed)?"><td class="pos">/g);
  assert.equal(rows.length, 7);
  assert.equal(html.match(/<tr class="changed">/g).length, 3, 'steps 3, 4 and 5 changed the menu');
  assert.equal(html.match(/<span class="inserted"/g).length, 2, 'two tools inserted at step 3');
  assert.equal(html.match(/<span class="appended"/g).length, 1, 'one appended at step 4');
  assert.equal(html.match(/<span class="edited"/g).length, 1, 'get_form edited at step 5');
  const link = /<a class="chip sm rose" href="#(finding-\d+)">session\/mid-insert<\/a>/.exec(html);
  assert.ok(link, 'the step links its finding');
  assert.match(html, new RegExp(`<article class="tile" id="${link[1]}">`));
});

test('session without --html records no step menus: the JSON output is unchanged', async () => {
  const cwd = tempDir();
  copyFileSync(join(ROOT, 'examples/unlock.scenario.yml'), join(cwd, 'unlock.scenario.yml'));
  const r = await run(['session', '--scenario', 'unlock.scenario.yml', '--format', 'json', '--', process.execPath, join(FIXTURES, 'session-server.mjs')], { cwd });
  assert.ok(JSON.parse(r.stdout).steps.every((s) => s.menu === undefined));
});

test('snapshot html: the menu the agent is shown, as the text report counts it', () => {
  const app = tool('app_refresh', [], { _meta: { ui: { resourceUri: 'ui://x', visibility: ['app'] } } });
  const html = snapshotHtml(menuOf([tool('list_forms'), app]), []);
  assert.doesNotMatch(html, /<td class="name">app_refresh/);
  assert.match(html, /1 more tool isn&#39;t shown to the agent/);
  assert.match(html, /<span class="t-title-1">1 tool<\/span>/);
});

test('diff html: ignored tools left out, a rename one row, growth from nothing in tokens', () => {
  const before = menuOf([tool('get_user', ['id']), tool('debug_dump')]);
  const after = menuOf([tool('fetch_user', ['id']), tool('list_forms')]);
  const ignore = ['debug_*'];
  const html = diffHtml(diffMenus(before, after, { ignore }), before, after, { ignore });
  assert.doesNotMatch(html, /debug_dump/, 'ignored, as diff ignores it');
  assert.match(html, /fetch_user<span class="chip sm rose" title="Was get_user">Renamed/);
  assert.doesNotMatch(html, /get_user<\/td>/, 'the old name is not a removed row');
  assert.match(html, /list_forms<\/td>.*?New/s);
  const empty = menuOf([]);
  const grown = diffHtml(diffMenus(empty, after), empty, after);
  assert.doesNotMatch(grown, /\+0%/, 'no percentage of nothing');
});

test('session html: a finding over several steps is linked from each; linked info findings start open', () => {
  const step = (index) => ({ index, label: `call t${index}`, status: 'ok', outcome: 'answered', changed: false, listChanged: 0, tools: 1, tokens: 10 });
  const result = {
    scenario: 's.yml', server: { name: 'x' }, transport: 'stdio', listening: true,
    baseline: { tools: 1, tokens: 10 }, final: { tools: 1, tokens: 10 },
    steps: [step(1), step(2), step(3)],
    findings: [{ rule: 'session/tool-error', severity: 'warn', message: 'm', step: 1, steps: [1, 3] }, { rule: 'session/known-variance', severity: 'info', message: 'v', step: 2 }],
    union: menuOf([]),
  };
  const html = sessionHtml(result);
  assert.equal(html.match(/href="#finding-1"/g).length, 2, 'steps 1 and 3');
  assert.match(html, /Steps 1 and 3/);
  assert.match(html, /<details class="more" open>/);
});

test('session --html --json: the JSON has no step menus either', async () => {
  const cwd = tempDir();
  copyFileSync(join(ROOT, 'examples/unlock.scenario.yml'), join(cwd, 'unlock.scenario.yml'));
  const r = await run(['session', '--scenario', 'unlock.scenario.yml', '--html', 'r.html', '--format', 'json', '--', process.execPath, join(FIXTURES, 'session-server.mjs')], { cwd });
  assert.ok(JSON.parse(r.stdout).steps.every((s) => s.menu === undefined));
  assert.match(readFileSync(join(cwd, 'r.html'), 'utf8'), /class="inserted"/);
});

test('--html goes with snapshot, diff and session only', async () => {
  const r = await run(['history', 'x', '--html', 'a.html']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /HTML report \(--html\) goes with snapshot, diff or session/);
});
