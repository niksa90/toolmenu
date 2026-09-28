import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheBreak, canonical, compareMenus } from '../dist/compare.js';
import { menuOf, tool } from './helpers.mjs';

const kinds = (changes) => changes.map((c) => `${c.kind}:${c.tool}`).sort();

test('identical menus have no changes, whatever the key order', () => {
  const a = menuOf([tool('a', ['x']), tool('b')]).tools;
  const b = menuOf([{ inputSchema: a[0].inputSchema, description: a[0].description, name: 'a' }, tool('b')]).tools;
  assert.deepEqual(compareMenus(a, b), []);
  assert.equal(canonical({ b: 1, a: [{ d: 1, c: 2 }] }), canonical({ a: [{ c: 2, d: 1 }], b: 1 }));
});

test('detects added, removed, moved and edited tools', () => {
  const before = menuOf([tool('a'), tool('b'), tool('c'), tool('gone')]).tools;
  const after = menuOf([tool('b'), tool('a'), tool('c', [], { description: 'changed' }), tool('new')]).tools;
  const changes = kinds(compareMenus(before, after));
  assert.ok(changes.includes('removed:gone'));
  assert.ok(changes.includes('added:new'));
  assert.ok(changes.includes('description:c'));
  assert.equal(changes.filter((c) => c.startsWith('moved:')).length, 1, 'one swap is one move');
});

test('an insert in the middle is not a reorder', () => {
  const before = menuOf([tool('a'), tool('b'), tool('c')]).tools;
  const after = menuOf([tool('a'), tool('x'), tool('b'), tool('c')]).tools;
  assert.deepEqual(kinds(compareMenus(before, after)), ['added:x']);
});

test('cacheBreak: appending keeps the cached prefix valid', () => {
  const before = menuOf([tool('a'), tool('b')]).tools;
  const after = menuOf([tool('a'), tool('b'), tool('c')]).tools;
  assert.equal(cacheBreak(before, after), null);
});

test('cacheBreak: a mid-list insert breaks the cache from the insert on', () => {
  const before = menuOf([tool('a'), tool('b'), tool('c')]).tools;
  const after = menuOf([tool('a'), tool('x'), tool('b'), tool('c')]).tools;
  const br = cacheBreak(before, after);
  assert.equal(br.position, 1);
  assert.equal(br.tokensAffected, after.slice(1).reduce((s, t) => s + t.tokens, 0));
});

test('cacheBreak: editing a tool breaks the cache from that tool on', () => {
  const before = menuOf([tool('a'), tool('b'), tool('c')]).tools;
  const after = menuOf([tool('a'), tool('b', [], { description: 'new words' }), tool('c')]).tools;
  assert.equal(cacheBreak(before, after).position, 1);
});
