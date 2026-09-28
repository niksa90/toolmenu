import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolDifference, firstDifference } from '../dist/difference.js';
import { isContainerWrapper, seeded } from '../dist/probe.js';
import { tool } from './helpers.mjs';

test('firstDifference: the first differing leaf, and whether it is a reordering', () => {
  assert.equal(firstDifference({ a: 1 }, { a: 1 }), undefined);
  assert.deepEqual(firstDifference({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }), { path: 'a.c', before: 2, after: 3, reordered: false });
  assert.equal(firstDifference({ d: 'x,y,z' }, { d: 'z,x,y' }).reordered, true);
  assert.equal(firstDifference({ e: ['a', 'b'] }, { e: ['b', 'a'] }).reordered, true);
  assert.equal(firstDifference({ e: ['a', 'b'] }, { e: ['a', 'c'] }).path, 'e[1]');
  assert.equal(firstDifference({ 'x-y': 1 }, { 'x-y': 2 }).path, '["x-y"]');
});

test('describeToolDifference names the path, the values, and key-order-only changes', () => {
  const a = tool('t', [], { inputSchema: { type: 'object', properties: { f: { type: 'string', default: 'a,b,c' } } } });
  const b = tool('t', [], { inputSchema: { type: 'object', properties: { f: { type: 'string', default: 'c,a,b' } } } });
  assert.match(describeToolDifference(a, b), /^t: inputSchema\.properties\.f\.default: same 3 items, different order/);
  const keys = { name: 'k', inputSchema: { type: 'object' }, description: 'K.' };
  const swapped = { description: 'K.', name: 'k', inputSchema: { type: 'object' } };
  assert.match(describeToolDifference(keys, swapped), /keys in a different order/);
});

test('seeded pins PYTHONHASHSEED on stdio targets unless the user set it', () => {
  const stdio = { kind: 'stdio', command: 'python', args: [] };
  assert.equal(seeded(stdio, '0').env.PYTHONHASHSEED, '0');
  assert.equal(seeded({ ...stdio, env: { PYTHONHASHSEED: '42' } }, '0').env.PYTHONHASHSEED, '42');
  assert.equal(seeded({ kind: 'http', url: 'http://x' }, '0').env, undefined);
  assert.equal(isContainerWrapper({ ...stdio, command: '/usr/bin/docker' }), true);
  assert.equal(isContainerWrapper(stdio), false);
});
