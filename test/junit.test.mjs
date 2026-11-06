// JUnit XML output (--format junit, --junit <path>): for CI test reports. Each finding
// is a test case; findings at --fail-on or above fail, so the report agrees with the exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toJunit, xml } from '../dist/junit.js';
import { FIXTURES, run, tempDir } from './helpers.mjs';

const headers = join(FIXTURES, 'header-server.mjs');
const count = (text, re) => (text.match(re) ?? []).length;

test('toJunit: a failure per finding at --fail-on or above, the rest pass with their text', () => {
  const findings = [
    { rule: 'naming/vague-id', severity: 'warn', message: 'a uses "id"', tool: 'a', fix: 'Rename it' },
    { rule: 'naming/vague-id', severity: 'warn', message: 'a uses "ids"', tool: 'a' },
    { rule: 'menu/tokens', severity: 'info', message: 'big menu' },
    { rule: 'diff/removed', severity: 'error', message: 'two tools gone', tools: ['b', 'c'] },
  ];
  const out = toJunit(findings, { command: 'diff', failOn: 'warn' });
  assert.match(out, /<testsuite name="toolmenu diff" tests="5" failures="4"/);
  assert.equal(count(out, /<failure /g), 4);
  assert.match(out, /classname="toolmenu\.diff\.naming\/vague-id" name="a #2"/, 'a second finding on one tool gets its own stable name');
  assert.match(out, /name="b"[\s\S]*name="c"/, 'one case per tool of a change found in several');
  assert.match(out, /name="\(menu\)" time="0">\n {6}<system-out>info: big menu/);
  assert.match(out, /→ Next: Rename it/);
  assert.equal(count(toJunit(findings, { command: 'diff' }), /<failure /g), 2, 'default --fail-on is error');
});

test('toJunit: no findings is one passing case, not an empty report', () => {
  const out = toJunit([], { command: 'snapshot' });
  assert.match(out, /tests="1" failures="0"/);
  assert.match(out, /<testcase classname="toolmenu\.snapshot" name="no findings" time="0"\/>/);
});

test('xml: escapes markup and drops characters XML 1.0 cannot hold', () => {
  assert.equal(xml('<a href="x">&\u0001</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('snapshot --junit writes the file beside the report; --format junit prints it instead', async () => {
  const cwd = tempDir();
  const a = await run(['snapshot', '--junit', 'out.xml', '--', process.execPath, headers], { cwd });
  assert.match(a.stdout, /toolmenu snapshot/, 'the text report still prints');
  const file = readFileSync(join(cwd, 'out.xml'), 'utf8');
  assert.match(file, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites name="toolmenu"/);
  assert.match(file, /classname="toolmenu\.snapshot\.spec\/x-mcp-header"/);
  const b = await run(['snapshot', '--format', 'junit', '--fail-on', 'warn', '--', process.execPath, headers], { cwd });
  assert.match(b.stdout, /^<\?xml/);
  assert.ok(count(b.stdout, /<failure /g) > 0);
  assert.equal(b.code, 1, 'failures in the report, exit 1');
});

test('JUnit output goes with snapshot, diff and session only', async () => {
  const r = await run(['history', 'x', '--format', 'junit']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /JUnit output .* goes with snapshot, diff or session/);
});
