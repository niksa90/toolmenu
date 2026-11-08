// Server text in reports: shown as it is, never acted on by a terminal, GitHub's log
// parser or markdown (sanitize.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mdCode, mdText, plain, terminalSafe } from '../dist/sanitize.js';
import { FIXTURES, run, tempDir } from './helpers.mjs';

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const hostile = ['--protocol', 'legacy', '--', process.execPath, join(FIXTURES, 'hostile-server.mjs')];

/**
 * Markdown with code blocks and code spans taken out: what GitHub renders as text.
 * Code spans as CommonMark pairs them: a run of n backticks (not backslash-escaped)
 * up to the next run of exactly n; one with no partner is literal text.
 */
function outsideCode(md) {
  const text = md.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '');
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] !== '`') {
      out += text[i++];
      continue;
    }
    let n = 0;
    while (text[i + n] === '`') n++;
    const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, 'g');
    close.lastIndex = i + n;
    const m = close.exec(text);
    if (m) i = m.index + n;
    else {
      out += '`'.repeat(n);
      i += n;
    }
  }
  return out;
}

test('plain: control characters, newlines and bidi overrides are shown as escapes', () => {
  assert.equal(plain('a\u001b[2Jb'), 'a\\u001b[2Jb');
  assert.equal(plain('c\n::error::x'), 'c\\n::error::x');
  assert.equal(plain('x\u202ey'), 'x\\u202ey');
  assert.equal(plain('get_form · ~309 → ok'), 'get_form · ~309 → ok');
  // A report keeps its own lines; what a field still carries is escaped.
  assert.equal(terminalSafe('line one\n\tline \u0007two'), 'line one\n\tline \\u0007two');
});

test('mdCode: a code span the text can\'t close, one line, pipes escaped in a cell', () => {
  assert.equal(mdCode('get_form'), '`get_form`');
  assert.equal(mdCode('a`b'), '``a`b``');
  assert.equal(mdCode('`x'), '`` `x ``');
  assert.equal(mdCode('a|b', { cell: true }), '`a\\|b`');
  assert.equal(mdCode('a\nb'), '`a\\nb`');
});

test('mdText: toolmenu\'s own code stays code; links, images, HTML, mentions and refs are inert', () => {
  assert.equal(mdText('`get_form` changed'), '`get_form` changed');
  const out = mdText('![t](https://evil.example/t.png) [Approve](https://evil.example) <img src=x> @org/team a@b.example #12 www.evil.example');
  assert.doesNotMatch(out, /(?<!\\)!(?<!\\)\[|(?<!\\)\]\(|<img|@org|@b\.|#12|https:\/\/|www\./);
  assert.doesNotMatch(out, /&#&/, 'one entity, not an entity inside an entity');
  // toolmenu's own links stay links.
  assert.match(mdText('see https://github.com/niksa90/toolmenu/issues'), /see https:\/\/github\.com\/niksa90\/toolmenu\/issues$/);
  // A server's backtick only moves where code starts: every piece is inert.
  const odd = mdText('`a` b` ![t](https://evil.example)');
  assert.doesNotMatch(outsideCode(odd), /(?<!\\)!\[|https:\/\//);
});

test('snapshot and diff text reports show a hostile server\'s names as escapes', async () => {
  const dir = tempDir();
  const menu = join(dir, 'menu.json');
  const snap = await run(['snapshot', '--out', menu, ...hostile]);
  assert.equal(snap.code, 1, snap.stderr); // spec/tool-name: an error for the hidden characters
  assert.doesNotMatch(snap.stdout, RAW_CONTROL);
  assert.match(snap.stdout, /1\.0\.0\\u001b\[31m/);
  writeFileSync(join(dir, 'empty.json'), JSON.stringify({ toolmenu: 1, server: {}, tools: [] }));
  for (const format of ['text', 'github']) {
    const diff = await run(['diff', '--format', format, join(dir, 'empty.json'), menu]);
    assert.doesNotMatch(diff.stdout, RAW_CONTROL, format);
    assert.match(diff.stdout, /a\\u001b\]0;PWNED\\u0007\\u001b\[2Jb/, format);
    assert.match(diff.stdout, /safe\\u202eexe\.txt/, format);
    // The newline in a name is shown, not a line of its own: no forged annotation.
    assert.doesNotMatch(diff.stdout, /^::error::forged/m, format);
    assert.match(diff.stdout, /c\\n::error::forged\\nd/, format);
  }
});

test('markdown reports (the PR comment) render a hostile server\'s text inert', async () => {
  const dir = tempDir();
  const menu = join(dir, 'menu.json');
  const snap = await run(['snapshot', '--format', 'markdown', '--out', menu, ...hostile]);
  writeFileSync(join(dir, 'empty.json'), JSON.stringify({ toolmenu: 1, server: {}, tools: [] }));
  const diff = await run(['diff', '--format', 'markdown', join(dir, 'empty.json'), menu]);
  for (const [what, md] of [['snapshot', snap.stdout], ['diff', diff.stdout]]) {
    assert.doesNotMatch(md, RAW_CONTROL, what);
    const text = outsideCode(md);
    assert.doesNotMatch(text, /(?<!\\)!\[|(?<!\\)\]\(https?:|<img|@org|#12\b|https:\/\/evil|www\.evil/, `${what}:\n${text}`);
    // Each table row is still one row.
    for (const line of md.split('\n').filter((l) => l.startsWith('|'))) assert.ok(!/\n/.test(line));
    assert.doesNotMatch(md, /^::error::forged/m, what);
  }
  // The names are still there to read.
  assert.match(diff.stdout, /Approve/);
});

test('terminalSafe keeps JSON the same JSON, characters past the first plane included', () => {
  const value = { name: `a${String.fromCodePoint(0xe0041)}b${String.fromCharCode(0x202e)}c`, line: 'x\ny' };
  const safe = terminalSafe(JSON.stringify(value));
  assert.doesNotMatch(safe, RAW_CONTROL);
  assert.deepEqual(JSON.parse(safe), value);
});

test('mdCode survives a name made of 200k backtick runs; own links only on their own path', async () => {
  assert.ok(mdCode('a`'.repeat(200_000)).startsWith('``'));
  const linked = (u) => mdText(u) === u;
  assert.equal(linked('https://github.com/niksa90/toolmenu/issues'), true);
  assert.equal(linked('https://github.com/niksa90/toolmenu'), true);
  assert.equal(linked('https://github.com/niksa90/toolmenu/../../attacker/x'), false);
  assert.equal(linked('https://github.com/niksa90/toolmenu.evil/x'), false);
  assert.equal(linked('https://github.com/niksa90/toolmenu/%2e%2e/x'), false);
  assert.doesNotMatch(mdText('see GH-12'), /GH-12/);
});

test('the --client cost line and init/session --init output show a server\'s text inert', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ client: 'claude-code' }));
  const md = await run(['snapshot', '--no-write', '--format', 'markdown', ...hostile], { cwd: dir });
  assert.match(md.stdout, /largest: /);
  assert.doesNotMatch(outsideCode(md.stdout), /(?<!\\)!\[|@org|https:\/\/evil/);
  const text = await run(['snapshot', '--no-write', ...hostile], { cwd: dir });
  assert.doesNotMatch(text.stdout, RAW_CONTROL);
  assert.doesNotMatch(text.stdout, /^::error::forged/m);
  // JSON: the same values, nothing raw.
  const json = await run(['snapshot', '--no-write', '--format', 'json', ...hostile], { cwd: dir });
  assert.doesNotMatch(json.stdout, RAW_CONTROL);
  assert.ok(JSON.parse(json.stdout).breakdown.top.some((t) => t.name.includes(String.fromCharCode(0x202e))));
});
