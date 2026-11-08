// The HTML report (--html <path>): one self-contained page per run of snapshot, diff
// or session. No script and nothing fetched, so it opens offline from a CI artifact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffHtml, esc, sessionHtml, snapshotHtml } from '../dist/html.js';
import { comparedTools, diffMenus } from '../dist/diff.js';
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

/** diffHtml as the CLI calls it: with the tools diffMenus compared. */
function diffPage(before, after, options = {}) {
  return diffHtml(diffMenus(before, after, options), comparedTools(before, after, options.ignore));
}

test('stepMenu: removed tools follow, marked; a long run of appended tools stays linear', () => {
  const t = (name, tokens = 10) => ({ name, tokens });
  const menu = stepMenu([t('a')], [{ kind: 'removed', tool: 'b', position: 1 }], [t('a'), t('b', 30)]);
  assert.deepEqual(menu, [{ name: 'a', tokens: 10 }, { name: 'b', tokens: 30, change: 'removed' }]);
  const many = Array.from({ length: 20000 }, (_, i) => t(`t${i}`));
  const started = Date.now();
  const marked = stepMenu(many, many.slice(1).map((x, i) => ({ kind: 'added', tool: x.name, position: i + 1 })));
  assert.ok(Date.now() - started < 1000, 'not quadratic');
  assert.equal(marked.filter((m) => m.change === 'appended').length, 19999);
});

test('snapshot html: counts as the text report does, every tool listed, app-only ones marked', () => {
  const app = tool('app_refresh', [], { _meta: { ui: { resourceUri: 'ui://x', visibility: ['app'] } } });
  const menu = menuOf([tool('list_forms'), app]);
  const html = snapshotHtml(menu, [], { cost: { client: 'claude-code', label: 'Claude Code', upfront: 40, loaded: [], perTool: 25, basis: 'b' } });
  assert.match(html, /app_refresh<span class="chip sm neutral"[^>]*>App only/);
  assert.match(html, /<span class="t-title-1">2 tools<\/span>/);
  assert.match(html, new RegExp(`~${menu.totalTokens}<`), 'the full total, as the text report says it');
  assert.match(html, /1 tool isn&#39;t shown to the agent/);
  assert.match(html, /As Claude Code: up front ~40 tokens/);
  assert.match(html, /Up front, as Claude Code<\/p><div class="val"><span class="t-title-1 tnum">~40</, "one up-front number, the client's");
});

test('diff html: what diffMenus compared: ignored tools out, a rename one row, visibility no add', () => {
  const before = menuOf([tool('get_user', ['id']), tool('debug_dump'), tool('panel', [], { _meta: { ui: { resourceUri: 'ui://p', visibility: ['app'] } } })]);
  const after = menuOf([tool('fetch_user', ['id']), tool('list_forms'), tool('panel')]);
  const html = diffPage(before, after, { ignore: ['debug_*'] });
  assert.doesNotMatch(html, /debug_dump/, 'ignored, as diff ignores it');
  assert.match(html, /fetch_user<span class="chip sm rose" title="Was get_user">Renamed/);
  assert.doesNotMatch(html, /get_user<\/td>/, 'the old name is not a removed row');
  assert.match(html, /list_forms<\/td>.*?New/s);
  assert.doesNotMatch(html, /panel<\/td>.*?New/s, 'shown to the agent now, but not added: diff says so too');
  assert.match(html, /1 new, 0 removed, 1 renamed/);
  const empty = menuOf([]);
  assert.doesNotMatch(diffPage(empty, after), /\+0%/, 'no percentage of nothing');
});

test('session html: links from every step a finding names, a row for step 0, info open only when linked', () => {
  const step = (index) => ({ index, label: `call t${index}`, status: 'ok', outcome: 'answered', changed: false, listChanged: 0, tools: 1, tokens: 10 });
  const base = { scenario: 's.yml', server: { name: 'x' }, transport: 'stdio', listening: true, baseline: { tools: 1, tokens: 10 }, final: { tools: 1, tokens: 10 }, steps: [step(1), step(2), step(3)], union: menuOf([]) };
  const html = sessionHtml({ ...base, findings: [{ rule: 'session/tool-error', severity: 'warn', message: 'm', step: 1, steps: [1, 3] }, { rule: 'session/known-variance', severity: 'info', message: 'v', step: 2 }] });
  assert.equal(html.match(/href="#finding-1"/g).length, 2, 'steps 1 and 3');
  assert.match(html, /Steps 1 and 3/);
  assert.match(html, /<details class="more" open>/, 'a step links into the info findings');
  const zero = sessionHtml({ ...base, findings: [{ rule: 'session/a', severity: 'warn', message: 'w', step: 1 }, { rule: 'session/b', severity: 'info', message: 'i', step: 0 }] });
  assert.match(zero, /<td class="pos">0<\/td><td class="step"><span class="sec">Before the first step/);
  const unlinked = sessionHtml({ ...base, findings: [{ rule: 'session/a', severity: 'warn', message: 'w', step: 1 }, { rule: 'session/c', severity: 'info', message: 'i' }] });
  assert.match(unlinked, /<details class="more">/, 'no step links to it: folded');
});

test('session --json is the same with --html as without: step menus never reach it', async () => {
  const cwd = tempDir();
  copyFileSync(join(ROOT, 'examples/unlock.scenario.yml'), join(cwd, 'unlock.scenario.yml'));
  const args = ['session', '--scenario', 'unlock.scenario.yml', '--format', 'json'];
  const server = ['--', process.execPath, join(FIXTURES, 'session-server.mjs')];
  const plain = JSON.parse((await run([...args, ...server], { cwd })).stdout);
  const withHtml = JSON.parse((await run([...args, '--html', 'r.html', ...server], { cwd })).stdout);
  // The same keys all the way down; values that vary per run (timings) aside.
  const keys = (o) => (Array.isArray(o) ? o.map(keys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, keys(o[k])])) : typeof o);
  assert.deepEqual(keys(withHtml), keys(plain));
  assert.match(readFileSync(join(cwd, 'r.html'), 'utf8'), /class="inserted"/, 'while the page has them');
});

test('session html: a step\'s status shows, strips share one scale with removed tools in it, --auto summarized', () => {
  const step = (index, extra = {}) => ({ index, label: `call t${index}`, status: 'ok', outcome: 'answered', changed: false, listChanged: 0, tools: 1, tokens: 10, ...extra });
  const result = {
    scenario: 's.yml', server: { name: 'x' }, transport: 'stdio', listening: true, baseline: { tools: 2, tokens: 1000 }, final: { tools: 1, tokens: 500 },
    steps: [step(1, { status: 'timed-out', outcome: undefined }), step(2, { status: 'failed', changed: true })], findings: [], union: menuOf([]),
    auto: { called: ['a'], skipped: [{ tool: 'b', reason: 'writes' }] },
  };
  const menus = new Map([[1, [{ name: 'a', tokens: 500 }, { name: 'b', tokens: 500 }]], [2, [{ name: 'a', tokens: 500 }, { name: 'b', tokens: 500, change: 'removed' }]]]);
  const html = sessionHtml(result, menus);
  assert.match(html, /Timed out/);
  assert.match(html, />Failed after</);
  assert.equal(html.match(/<div class="fill" style="width:100\.00%">/g).length, 2, 'removed tools count in the strip\'s length, so both rows share the scale');
  assert.match(html, /<details class="auto"><summary class="t-body-m">/);
});

test('diff html: positions as served, ignored tools counted; a removal is never a green badge', () => {
  const before = menuOf([tool('debug_dump'), tool('a'), tool('b', ['x'])]);
  const after = menuOf([tool('debug_dump'), tool('a'), tool('c', ['y', 'z'])]);
  const html = diffPage(before, after, { ignore: ['debug_*'] });
  assert.match(html, /<td class="pos">1<\/td><td class="name">a</, 'a is at position 1 in the menu served');
  assert.match(html, /<span class="chip rose">1 new, 1 gone<\/span>/);
  assert.match(diffPage(after, after, { ignore: ['debug_*'] }), /<span class="chip soft">1 ignored<\/span>/);
});

test('--html goes with snapshot, diff and session only', async () => {
  const r = await run(['history', 'x', '--html', 'a.html']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /HTML report \(--html\) goes with snapshot, diff or session/);
});
