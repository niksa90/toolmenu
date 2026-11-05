// Colour in a terminal: the same text, with ANSI codes; plain everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { colourFor, colourise, colouriseError } from '../dist/colour.js';
import { FIXTURES, run } from './helpers.mjs';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('colour: only in a terminal, NO_COLOR wins, FORCE_COLOR forces', () => {
  assert.equal(colourFor({ isTTY: true }, {}), true);
  assert.equal(colourFor({ isTTY: false }, {}), false);
  assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '' }), true);
  assert.equal(colourFor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.equal(colourFor({ isTTY: true }, { FORCE_COLOR: '0' }), false);
  assert.equal(colourFor({ isTTY: true }, { TERM: 'dumb' }), false);
});

test('colour: severities, the next step and the verdict are painted; the characters are the same', () => {
  const report = [
    'toolmenu snapshot  raw 0.0.1',
    '  protocol 2025-11-25 · 1 tool',
    '',
    'WARN   naming/vague-id · unsure',
    '       delete_record.id is called just "id".',
    '         "id": delete_record',
    '       → Next: Name it after what it identifies.',
    '  ERROR  session/edit · step 5 · get_form: description changed mid-session.',
    'step 5: call touch · answered · menu changed',
    '✗ 1 error, 1 warning, 0 info',
  ].join('\n');
  const painted = colourise(report);
  assert.equal(strip(painted), report);
  const line = (n) => painted.split('\n')[n];
  assert.match(line(3), /^\x1b\[1;33mWARN\x1b\[0m   \x1b\[1mnaming\/vague-id\x1b\[0m\x1b\[2;3m · unsure\x1b\[0m$/);
  assert.equal(line(4), '       delete_record.id is called just "id".', 'the message stays plain');
  assert.equal(line(5), '\x1b[2m         "id": delete_record\x1b[0m', 'evidence is dimmed');
  assert.match(line(6), /^       \x1b\[1;32m→ Next:\x1b\[0m/);
  assert.match(line(7), /^  \x1b\[1;31mERROR\x1b\[0m/);
  assert.match(line(9), /^\x1b\[1;31m✗ /);
  const error = 'toolmenu: x wants credentials.\n  url   https://x.test\n  → Next: Log in.';
  assert.equal(strip(colouriseError(error)), error);
});

test('colour: piped output and --format json stay plain; FORCE_COLOR colours the text report', async () => {
  const args = ['snapshot', '--no-write', '--env', 'FIXTURE=smells', '--', process.execPath, join(FIXTURES, 'raw-server.mjs')];
  const plain = await run(args);
  assert.doesNotMatch(plain.stdout, /\x1b\[/);
  const forced = await run(args, { env: { FORCE_COLOR: '1' } });
  assert.match(forced.stdout, /\x1b\[1;33mWARN\x1b\[0m/);
  assert.equal(strip(forced.stdout), plain.stdout);
  const json = await run(['snapshot', '--json', ...args.slice(1)], { env: { FORCE_COLOR: '1' } });
  assert.doesNotMatch(json.stdout, /\x1b\[/);
  JSON.parse(json.stdout);
});
