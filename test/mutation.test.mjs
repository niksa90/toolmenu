import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffMenus } from '../dist/diff.js';
import { MUTATIONS, check, run, sites } from './mutate.mjs';
import { documentSchema } from './fixtures/shared-defs.mjs';
import { FIXTURES, menuOf } from './helpers.mjs';

// Every position diff compares, in real menus, edited ten ways (test/mutate.mjs
// says what each edit must produce): every site, every kind, about 3,100
// mutations in 15 s. A spread sample saved little (the time is tokenizing).
const perKind = Infinity;
const corpus = join(FIXTURES, 'corpus');
const menus = readdirSync(corpus)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(corpus, f), 'utf8'))]);
menus.push(['document schema (field report: five block types, one shared definition)', { tools: [{ name: 'content_create', inputSchema: documentSchema() }] }]);

for (const [name, menu] of menus) {
  test(`mutations: ${name}`, () => {
    const { checked, failures } = run(menu, { perKind });
    assert.ok(checked > 0, 'no mutation applied');
    const report = failures.slice(0, 15).map((f) => `${f.kind} at ${f.tool}${f.at}: ${f.problems.join('; ')}\n      ${f.messages.join('\n      ')}`);
    assert.equal(failures.length, 0, `${failures.length} of ${checked} mutations misreported:\n${report.join('\n')}`);
  });
}

test('mutations: every kind applies somewhere in the corpus, so none is vacuous', () => {
  const seen = new Set();
  for (const [, menu] of menus) {
    for (const tool of menu.tools) {
      for (const s of sites(tool.inputSchema)) {
        for (const [kind, m] of Object.entries(MUTATIONS)) if (m.applies(s.node, s.ptr)) seen.add(kind);
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(MUTATIONS).sort());
});

// The shapes the corpus sweep turned up, each as a small case.
test('a property named "type" is a schema, not a type keyword (Notion API-update-a-block)', () => {
  const s = (options) => ({ type: 'object', properties: { type: { anyOf: options } } });
  const obj = { type: 'object', description: 'The block type.', properties: {}, additionalProperties: true };
  const d = diffMenus(menuOf([{ name: 't', inputSchema: s([obj, { type: 'string' }]) }]), menuOf([{ name: 't', inputSchema: s([{ type: 'string' }, obj]) }]));
  assert.deepEqual(d.findings, [], 'a reorder of its options changes nothing');
});

test('a union option that is itself a union is compared as its options (Notion parent: anyOf [$ref parentRequest, string])', () => {
  const page = { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] };
  const db = { type: 'object', properties: { database_id: { type: 'string' } }, required: ['database_id'] };
  const s = (options) => ({ type: 'object', $defs: { parentRequest: { anyOf: [page, db] } }, properties: { parent: { anyOf: options } } });
  const r = check({ name: 't', inputSchema: s([{ $ref: '#/$defs/parentRequest' }, { type: 'string' }]) }, ['properties', 'parent'], 'option-removed');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.findings.map((f) => f.message), ['t.parent: no longer accepts the string option. Calls that sent it can fail.']);
});

test('an option edited beyond recognition (its type, its only field) is one change, not removed plus added', () => {
  const s = (a) => ({ type: 'object', properties: { v: { anyOf: [a, { type: 'object', properties: { x: { type: 'string' } } }] } } });
  const d = diffMenus(menuOf([{ name: 't', inputSchema: s({ type: 'boolean' }) }]), menuOf([{ name: 't', inputSchema: s({ type: 'string' }) }]));
  assert.deepEqual(d.findings.map((f) => f.rule), ['diff/param-type']);
  // Two options with no properties are the same shape (0/0 isn't "nothing in common").
  const e = { type: 'object', properties: {} };
  const u = (a) => ({ type: 'object', properties: { v: { anyOf: [a, { type: 'string' }] } } });
  const d2 = diffMenus(menuOf([{ name: 't', inputSchema: u({ ...e, description: 'old' }) }]), menuOf([{ name: 't', inputSchema: u({ ...e, description: 'new' }) }]));
  assert.deepEqual(d2.findings.map((f) => f.rule), ['diff/description']);
});

test('removing all but one option compares what is left with the option it was (mongodb create-index dynamic)', () => {
  const s = (options) => ({ type: 'object', properties: { dynamic: { default: false, description: 'Dynamic mapping.', anyOf: options } } });
  const d = diffMenus(
    menuOf([{ name: 't', inputSchema: s([{ type: 'boolean' }, { type: 'object', properties: { typeSet: { type: 'string' } }, required: ['typeSet'] }]) }]),
    menuOf([{ name: 't', inputSchema: s([{ type: 'boolean' }]) }]),
  );
  assert.deepEqual(d.findings.map((f) => f.message), ['t.dynamic: no longer accepts the object{typeSet} option. Calls that sent it can fail.']);
});
