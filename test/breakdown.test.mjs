import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, breakdownLines } from '../dist/breakdown.js';
import { menuOf, run, FIXTURES, tool } from './helpers.mjs';
import { join } from 'node:path';

test('breakdown: top tools with their split, big enums, parameters repeated byte for byte', () => {
  const lang = { type: 'string', enum: Array.from({ length: 30 }, (_, i) => `lang-${i}`), description: 'The language of the results.' };
  const tools = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => tool(`search_${n}`, [], { inputSchema: { type: 'object', properties: { query: { type: 'string' }, ui_lang: lang } } }));
  tools.push(tool('big', [], { description: 'Long. '.repeat(300) }));
  const b = breakdown(menuOf(tools));
  assert.equal(b.top[0].name, 'big');
  assert.ok(b.top[0].description > b.top[0].schema);
  assert.equal(b.enums[0].values, 30);
  assert.deepEqual(b.repeated.map((r) => [r.param, r.tools]), [['ui_lang', 6]]);
  const lines = breakdownLines(b, tools.length);
  assert.match(lines[0], /^Where the tokens go \(estimate\): the top 5 tools are \d+% of the menu$/);
  assert.ok(lines.some((l) => /repeated: ui_lang .* in 6 tools/.test(l)));
  assert.deepEqual(breakdownLines(breakdown(menuOf(tools.slice(0, 3))), 3), []);
});

test('cli: snapshot shows where the tokens go', async () => {
  const r = await run(['snapshot', '--no-write', '--env', 'FIXTURE=smells', '--', process.execPath, join(FIXTURES, 'raw-server.mjs')]);
  assert.match(r.stdout, /Where the tokens go \(estimate\)/);
});
