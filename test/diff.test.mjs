import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffMenus, versionBump } from '../dist/diff.js';
import { buildMenu, loadMenu } from '../dist/menu.js';
import { FIXTURES, menuOf, run, tempDir, tool } from './helpers.mjs';

const menu = (tools, version = '1.0.0') => menuOf(tools, { name: 'fx', version });
// Messages name paths as code (`gen.a`); compared without the backticks.
const plain = (s) => s.replace(/`/g, '');
const rules = (result) => result.findings.map((f) => `${f.rule}${f.tool ? ':' + f.tool : ''}`).sort();
const str = { type: 'string' };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

test('no changes: no findings, no bump', () => {
  const m = menu([tool('get_form', ['form_id'])]);
  const d = diffMenus(m, m);
  assert.deepEqual(d.findings, []);
  assert.equal(d.suggestedBump, 'none');
  assert.equal(d.tokens.delta, 0);
});

test('removed tool is breaking; added tool is minor', () => {
  const d = diffMenus(menu([tool('a', ['x']), tool('b', ['y'])]), menu([tool('a', ['x']), tool('c', ['z', 'w'])], '2.0.0'));
  assert.deepEqual(rules(d), ['diff/tool-added:c', 'diff/tool-removed:b']);
  assert.equal(d.suggestedBump, 'major');
  assert.equal(d.findings.find((f) => f.rule === 'diff/tool-removed').class, 'breaking');
});

test('a rename is reported as one rename, not a removal plus an addition', () => {
  const d = diffMenus(menu([tool('get_audit_trail', ['since'])]), menu([tool('get_change_log', ['since'])], '2.0.0'));
  assert.deepEqual(rules(d), ['diff/tool-renamed:get_change_log']);
  assert.match(plain(d.findings[0].message), /get_audit_trail was renamed to get_change_log/);
});

test('parameter changes are classified', () => {
  const before = menu([
    { name: 't', description: 'T.', inputSchema: schema({ keep: str, gone: str, opt: str, req: str, num: str, color: { type: 'string', enum: ['red', 'blue'] }, size: { type: 'string', enum: ['s'] } }, ['keep', 'req']) },
  ]);
  const after = menu([
    { name: 't', description: 'T.', inputSchema: schema({ keep: str, opt: str, req: str, num: { type: 'number' }, color: { type: 'string', enum: ['red'] }, size: { type: 'string', enum: ['s', 'm'] }, fresh: str, extra: str }, ['keep', 'opt', 'fresh']) },
  ], '2.0.0');
  assert.deepEqual(rules(diffMenus(before, after)), [
    'diff/enum-narrowed:t',
    'diff/enum-widened:t',
    'diff/param-added:t',
    'diff/param-dropped:t',
    'diff/param-relaxed:t',
    'diff/param-required:t',
    'diff/param-required:t',
    'diff/param-type:t',
  ]);
});

test('safety hints use the spec defaults (readOnlyHint false, destructiveHint true)', () => {
  const write = (annotations) => menu([tool('write_file', ['path'], annotations === undefined ? {} : { annotations })]);
  const rules = (result) => result.findings.filter((f) => f.rule !== 'diff/version-bump').map((f) => `${f.rule}:${f.tool}`).sort();
  // unannotated is already "destructive", so making it explicit changes nothing
  assert.deepEqual(rules(diffMenus(write(undefined), write({ readOnlyHint: false, destructiveHint: true }))), ['diff/annotations:write_file']);
  assert.deepEqual(rules(diffMenus(write({ destructiveHint: false }), write({ destructiveHint: true }))), ['diff/safety-hint:write_file']);
  assert.deepEqual(rules(diffMenus(write({ readOnlyHint: true }), write({}))), ['diff/safety-hint:write_file']);
  // becoming safer is not breaking
  assert.equal(diffMenus(write({}), write({ readOnlyHint: true })).suggestedBump, 'patch');
});

test('description, output schema, annotation and other field changes are notices', () => {
  const before = menu([tool('t', ['a'], { title: 'T' })]);
  const after = menu([tool('t', ['a'], { title: 'Tee', description: 'New words.', outputSchema: schema({ ok: { type: 'boolean' } }), annotations: { openWorldHint: false } })], '1.0.1');
  const d = diffMenus(before, after);
  assert.deepEqual(rules(d), ['diff/annotations:t', 'diff/description:t', 'diff/other:t', 'diff/schema-other:t']);
  assert.equal(d.suggestedBump, 'patch');
  assert.match(d.findings.find((f) => f.rule === 'diff/schema-other').message, /now declares an outputSchema/);
  assert.deepEqual(d.findings.find((f) => f.rule === 'diff/description').detail, ['- t.', '+ New words.']);
});

test('an empty old schema is not read as every parameter being new', () => {
  const before = menu([{ name: 't', description: 'T.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#' } }]);
  const after = menu([tool('t', ['path'])], '1.0.1');
  assert.deepEqual(rules(diffMenus(before, after)), ['diff/description:t', 'diff/schema-other:t']);
});

test('order changes are a notice between releases', () => {
  const d = diffMenus(menu([tool('a'), tool('b')]), menu([tool('b'), tool('a')], '1.0.1'));
  assert.deepEqual(rules(d), ['diff/order']);
  assert.equal(d.findings[0].severity, 'info');
});

test('token change is reported per tool, largest first', () => {
  const d = diffMenus(menu([tool('a')]), menu([tool('a', [], { description: 'A much longer description than before. '.repeat(20) }), tool('b')], '1.1.0'));
  assert.ok(d.tokens.delta > 0);
  assert.equal(d.tokens.tools[0].name, 'a');
  assert.equal(d.tokens.tools.reduce((s, t) => s + t.delta, 0), d.tokens.delta);
});

// One block repeated in a tool's schema, inline, then moved into $defs: the refactor
// from the review that prompted this (content_generateMessageHtml, −899 tokens).
const block = { type: 'object', properties: { text: { type: 'string' }, size: { type: 'string', enum: ['s', 'm', 'l'] } }, required: ['text'] };
const inlined = (b = block) => ({ type: 'object', properties: { header: b, footer: b, body: b }, required: ['body'] });
const referenced = (b = block) => ({ type: 'object', $defs: { Block: b }, properties: { header: { $ref: '#/$defs/Block' }, footer: { $ref: '#/$defs/Block', description: 'Shown last.' }, body: { $ref: '#/$defs/Block' } }, required: ['body'] });
const gen = (inputSchema, description = 'Generate.') => menu([{ name: 'gen', description, inputSchema }]);

test('a $ref refactor that accepts the same input is one notice with its token change, not a widened type', () => {
  const after = referenced();
  delete after.properties.footer.description;
  const d = diffMenus(gen(inlined()), gen(after), { release: { before: '1.0.0', after: '1.0.1' } });
  assert.deepEqual(rules(d), ['diff/schema-equivalent:gen']);
  assert.match(d.findings[0].message, /accepts the same input: ~\d+ tokens fewer/);
  assert.equal(d.suggestedBump, 'patch');
  assert.ok(d.tokens.delta < 0);
});

test('breaking changes inside $defs and inside nested objects are breaking, with their path', () => {
  const narrower = { type: 'object', properties: { text: { type: 'integer' }, size: { type: 'string', enum: ['s'] }, lang: { type: 'string' } }, required: ['text', 'lang'] };
  for (const [label, before, after] of [
    ['$defs', referenced(), referenced(narrower)],
    ['inline', inlined(), inlined(narrower)],
  ]) {
    const d = diffMenus(gen(before), gen(after));
    assert.equal(d.suggestedBump, 'major', label);
    // The block is used three times (header, footer, body): each change is one
    // finding that lists the three places.
    const places = (rule) => d.findings.filter((f) => f.rule === rule).flatMap((f) => f.places ?? []);
    for (const [rule, field] of [['diff/param-type', 'text'], ['diff/enum-narrowed', 'size'], ['diff/param-required', 'lang']]) {
      assert.equal(d.findings.filter((f) => f.rule === rule).length, 1, `${label}: ${rule}`);
      assert.deepEqual(places(rule), ['header', 'footer', 'body'].map((b) => `gen.${b}.${field}`), `${label}: ${rule}`);
    }
    assert.ok(!d.findings.some((f) => f.rule === 'diff/type-widened'), label);
  }
});

test('one change to a definition five block types share: one error, every place, however deep (field report)', async () => {
  const { documentSchema } = await import('./fixtures/shared-defs.mjs');
  const tool = (s) => menu([{ name: 'content_create', inputSchema: s }]);
  const d = diffMenus(tool(documentSchema()), tool(documentSchema(['bold', 'italic', 'code'])));
  assert.deepEqual(d.findings.map((f) => `${f.severity} ${f.rule}`), ['error diff/enum-narrowed'], d.findings.map((f) => f.message).join('\n'));
  assert.equal(d.suggestedBump, 'major');
  const places = d.findings[0].places.map((p) => p.match(/\(type="(\w+)"\)/)[1]);
  assert.deepEqual(places, ['paragraph', 'heading', 'bulletList', 'orderedList', 'table', 'blockquote']);
  // The deepest place, as a path that says how it's reached.
  assert.ok(d.findings[0].places.includes('content_create.blocks[](type="table").rows[].cells[].content[].content[](type="text").marks[]'));
  // A change in one place only stays one finding at that place.
  const one = documentSchema();
  one.$defs.block.oneOf[1].properties.level = { type: 'string' };
  const e = diffMenus(tool(documentSchema()), tool(one));
  assert.deepEqual(e.findings.map((f) => plain(f.message).split(' ')[0]), ['content_create.blocks[](type="heading").level']);
});

test('different parameters with the same kind of change are separate findings (exa-mcp-server 3.1.9 → 3.2.0)', () => {
  const before = { type: 'object', properties: { query: { type: 'string' }, livecrawl: { type: 'string', enum: ['always', 'never'] }, category: { type: 'string' }, contextMaxCharacters: { type: 'number' } }, required: ['query', 'livecrawl', 'category', 'contextMaxCharacters'] };
  const after = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  const d = diffMenus(gen(before), gen(after));
  assert.deepEqual(d.findings.map((f) => plain(f.message).split(' ')[0]).sort(), ['gen.category', 'gen.contextMaxCharacters', 'gen.livecrawl']);
  assert.ok(d.findings.every((f) => !/more place/.test(f.message)));
  // Same schema, different names: still two changes, not one shared one.
  const two = diffMenus(gen({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }), gen({ type: 'object', properties: {} }));
  assert.equal(two.findings.length, 2);
});

test('independent fields with the same name and change, in different objects, stay two findings (review of #15)', () => {
  const limit = { type: 'integer' };
  const obj = (extra, withLimit) => ({ type: 'object', properties: { ...extra, ...(withLimit ? { limit } : {}) }, ...(withLimit ? { required: ['limit'] } : {}) });
  const s = (withLimit) => ({ type: 'object', properties: { search: obj({ q: { type: 'string' } }, withLimit), export: obj({ fmt: { type: 'string' } }, withLimit) } });
  const d = diffMenus(gen(s(true)), gen(s(false)));
  assert.deepEqual(d.findings.map((f) => plain(f.message).split(' ')[0]), ['gen.search.limit', 'gen.export.limit']);
  assert.ok(d.findings.every((f) => !f.places && !/more place/.test(f.message)));
});

test('union options without a discriminator: reorder is no change, adding in front is one addition (review of #15)', () => {
  const url = { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] };
  const path = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const data = { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] };
  const src = (options) => ({ type: 'object', properties: { src: { anyOf: options } } });
  assert.deepEqual(diffMenus(gen(src([url, path])), gen(src([path, url]))).findings, []);
  const front = diffMenus(gen(src([url, path])), gen(src([data, url, path])));
  assert.deepEqual(rules(front), ['diff/type-widened:gen']);
  assert.match(plain(front.findings[0].message), /now also accepts an object\{data\} option/);
  assert.equal(front.suggestedBump, 'minor');
  const removed = diffMenus(gen(src([url, path, data])), gen(src([url, data])));
  assert.deepEqual(removed.findings.map((f) => plain(f.message)), ['gen.src: no longer accepts the object{path} option. Calls that send it fail validation.']);
  // Reshaped and moved: paired by the property names it keeps, compared inside.
  const timeout = { type: 'object', properties: { url: { type: 'string' }, timeout: { type: 'integer' } }, required: ['url', 'timeout'] };
  const reshaped = diffMenus(gen(src([url, path])), gen(src([path, timeout])));
  assert.deepEqual(reshaped.findings.map((f) => `${f.rule} ${plain(f.message).split(' ')[0]}`), ['diff/param-required gen.src(object{timeout,url}).timeout']);
});

test('an option removed from a union that objects of different shapes share is one finding (review of #15, 3rd round)', () => {
  const inline = { oneOf: [
    { type: 'object', properties: { type: { const: 'text' }, text: { type: 'string' } }, required: ['type'] },
    { type: 'object', properties: { type: { const: 'hashtag' }, tag: { type: 'string' } }, required: ['type'] },
  ] };
  const s = (u) => ({ type: 'object', $defs: { inline: u }, properties: {
    heading: { type: 'object', properties: { level: { type: 'integer' }, content: { type: 'array', items: { $ref: '#/$defs/inline' } } } },
    cell: { type: 'object', properties: { header: { type: 'boolean' }, content: { type: 'array', items: { $ref: '#/$defs/inline' } } } },
  } });
  const d = diffMenus(gen(s(inline)), gen(s({ oneOf: [inline.oneOf[0]] })));
  assert.deepEqual(d.findings.map((f) => f.rule), ['diff/param-type']);
  assert.deepEqual(d.findings[0].places, ['gen.heading.content[]', 'gen.cell.content[]']);
});

test('a description inside a nullable type option is compared, and moving it to the node is no change (sentry-mcp)', () => {
  const nullable = (desc) => ({ type: 'object', properties: { query: { default: null, anyOf: [{ type: 'string', description: desc }, { type: 'null' }] } } });
  const d = diffMenus(gen(nullable('Search query.')), gen(nullable('Search query to filter results.')));
  assert.deepEqual(d.findings.map((f) => plain(f.message).split(':')[0] + ': ' + f.rule), ['gen.query: diff/description']);
  // zod versions differ on where the description goes: same text, no change.
  const onNode = { type: 'object', properties: { query: { default: null, description: 'Search query.', anyOf: [{ type: 'string' }, { type: 'null' }] } } };
  assert.deepEqual(diffMenus(gen(nullable('Search query.')), gen(onNode)).findings, []);
});

test('zod 3 → 4 spellings are the same schema (chrome-devtools-mcp 1.9.0 → 1.10.1: 61 "review it")', () => {
  const v3 = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: true, properties: { pageSize: { type: 'integer', exclusiveMinimum: 0 } } };
  const v4 = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: {}, properties: { pageSize: { type: 'integer', exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER } } };
  assert.deepEqual(rules(diffMenus(gen(v3), gen(v4))), ['diff/schema-dialect:gen']);
  // A real maximum is still a change.
  const capped = { ...v4, properties: { pageSize: { type: 'integer', exclusiveMinimum: 0, maximum: 100 } } };
  assert.ok(diffMenus(gen(v3), gen(capped)).findings.some((f) => f.rule === 'diff/schema-other' && plain(f.message).startsWith('gen.pageSize')));
});

test('a zod 3 → 4 upgrade of an MCP SDK server: the real changes, and nothing else (review of #15)', async () => {
  const [v3, v4] = await Promise.all(['zod3', 'zod4'].map((f) => loadMenu(join(FIXTURES, 'zod', `${f}.json`))));
  const d = diffMenus(v3, v4);
  assert.deepEqual(d.findings.map((f) => `${f.rule} ${f.tool ?? '(menu)'}`).sort(), [
    // z.any() / z.unknown() keys become required in zod 4: breaking.
    // The same change in two tools: one finding that lists them.
    'diff/param-required (menu)',
    // additionalProperties: false dropped from every object: one line for the menu.
    'diff/properties-opened (menu)',
    // Real changes toolmenu doesn't classify: patterns zod 4 adds, a tuple's bounds dropped.
    'diff/schema-other zod_datetime',
    'diff/schema-other zod_email',
    'diff/schema-other zod_tuple',
    'diff/schema-other zod_uuid',
  ]);
  const opened = d.findings.find((f) => f.rule === 'diff/properties-opened');
  assert.match(opened.message, /^27 tools now accept properties they don't list/);
  assert.equal(opened.places.length, 35);
  assert.equal(d.suggestedBump, 'major');
});

test('additionalProperties absent, true and {} are one spelling; false removed or added is its own change', () => {
  const s = (ap) => ({ type: 'object', properties: { a: { type: 'string' } }, ...(ap === undefined ? {} : { additionalProperties: ap }) });
  for (const [x, y] of [[undefined, {}], [undefined, true], [{}, true]]) {
    assert.deepEqual(diffMenus(gen(s(x)), gen(s(y))).findings.filter((f) => f.rule !== 'diff/schema-equivalent'), [], `${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  }
  assert.deepEqual(rules(diffMenus(gen(s(false)), gen(s(undefined)))), ['diff/properties-opened:gen']);
  const closed = diffMenus(gen(s(undefined)), gen(s(false)));
  assert.deepEqual(rules(closed), ['diff/properties-closed:gen']);
  assert.equal(closed.suggestedBump, 'major');
  // propertyNames: {type: "string"} (zod 4's z.record) accepts the same.
  const rec = (extra) => ({ type: 'object', properties: { r: { type: 'object', additionalProperties: { type: 'number' }, ...extra } } });
  assert.deepEqual(diffMenus(gen(rec({})), gen(rec({ propertyNames: { type: 'string' } }))).findings.filter((f) => f.rule !== 'diff/schema-equivalent'), []);
});

test('an option\'s description is compared even when the field has its own (review of #15, sentry-both)', () => {
  const s = (option) => ({ type: 'object', properties: { query: { description: 'The query.', anyOf: [{ type: 'string', description: option }, { type: 'null' }] } } });
  assert.deepEqual(rules(diffMenus(gen(s('Search text.')), gen(s('Search text, by name or slug.')))), ['diff/description:gen']);
});

test('union options: a replaced option (different fields, none shared) is one gone and one new', () => {
  const opt = (field) => ({ type: 'object', properties: { [field]: { type: 'string' } }, required: [field] });
  const s = (o) => ({ type: 'object', properties: { src: { anyOf: [opt('url'), o] } } });
  const d = diffMenus(gen(s(opt('path'))), gen(s(opt('data'))));
  assert.deepEqual(d.findings.map((f) => plain(f.message)), [
    'gen.src: no longer accepts the object{path} option. Calls that send it fail validation.',
    'gen.src now also accepts an object{data} option.',
  ]);
});

test('a union option that is an unexpanded $ref doesn\'t hide the others\' discriminator (a document schema\'s list path)', () => {
  // A recursive definition: its second level stays a $ref.
  const s = (enumValues) => ({ type: 'object', $defs: { node: { oneOf: [
    { type: 'object', properties: { type: { const: 'paragraph' }, text: { type: 'string', enum: enumValues } } },
    { type: 'object', properties: { type: { const: 'list' }, items: { type: 'array', items: { $ref: '#/$defs/node' } } } },
  ] } }, properties: { doc: { $ref: '#/$defs/node' } } });
  const d = diffMenus(gen(s(['a', 'b'])), gen(s(['a'])));
  assert.deepEqual(d.findings.map((f) => plain(f.message).split(':')[0]), ['gen.doc(type="paragraph").text']);
  // An option that is itself a $ref left as written (another document here; a
  // recursive definition past its unrolled level in a real one): the other options
  // still pair by their discriminator, not by position (was object{…} #1).
  const withRef = (enumValues) => ({ type: 'object', properties: { doc: { oneOf: [
    { type: 'object', properties: { type: { const: 'paragraph' }, text: { type: 'string', enum: enumValues } } },
    { type: 'object', properties: { type: { const: 'quote' }, text: { type: 'string' } } },
    { $ref: 'https://example.com/block.json' },
  ] } } });
  const e = diffMenus(gen(withRef(['a', 'b'])), gen(withRef(['a'])));
  assert.deepEqual(e.findings.map((f) => plain(f.message).split(':')[0]), ['gen.doc(type="paragraph").text']);
});

test('a wide union where every option changed stays fast (review of #15: 36 s at 1,500)', () => {
  const u = (last) => ({ type: 'object', properties: { v: { anyOf: Array.from({ length: 1500 }, (_, i) => ({ type: 'object', properties: { [`f${i}`]: { type: 'string' }, [`g${i}`]: { type: 'integer', enum: last } } })) } } });
  // The diff alone (about 1 s here), not building the menus: counting their tokens took
  // most of the time and none of the regression. And CPU time, not wall time: on a
  // busy machine the wall clock also counts the wait for a CPU (12–20 s with three
  // suites running at once).
  const [before, after] = [gen(u([1, 2, 3])), gen(u([1, 2]))];
  const cpu = process.cpuUsage();
  const d = diffMenus(before, after);
  const { user, system } = process.cpuUsage(cpu);
  assert.ok((user + system) / 1000 < 10_000, `${Math.round((user + system) / 1000)} ms of CPU`);
  assert.equal(d.suggestedBump, 'major');
});

test('a schema too large to expand on one side is compared as written, and says so (review of #15)', () => {
  const big = (n) => {
    const $defs = { [`D${n}`]: { type: 'string' } };
    for (let i = 0; i < n; i++) $defs[`D${i}`] = { type: 'object', properties: { x: { $ref: `#/$defs/D${i + 1}` }, y: { $ref: `#/$defs/D${i + 1}` } } };
    return { type: 'object', $defs, properties: { root: { $ref: '#/$defs/D0' } } };
  };
  const d = diffMenus(gen(big(10)), gen(big(17)));
  const cap = d.findings.find((f) => /expands past/.test(f.message));
  assert.match(cap.message, /the new input schema expands past 50,000 nodes through its \$refs, so both are compared as written, \$defs entries by name/);
  assert.ok(!d.findings.some((f) => f.rule === 'diff/type-widened'), 'no "object → any"');
  // $defs compared by name: D10 was the string leaf and is now an object (breaking),
  // and D11…D17 are new, said in one line.
  assert.ok(d.findings.some((f) => f.rule === 'diff/param-type' && plain(f.message).startsWith('gen.$defs.D10 changed type: string → object')));
  assert.deepEqual(d.findings.filter((f) => /entries added/.test(f.message)).map((f) => f.message), ['`gen`: $defs entries added (D11, D12, D13, D14, D15, D16, D17).']);
  assert.deepEqual(diffMenus(gen(big(17)), gen(big(17))).findings, []);
  // Both sides too large, and an enum narrowed inside a definition: still breaking (review of #15).
  const narrow = (n, values) => {
    const s = big(n);
    s.$defs[`D${n}`] = { type: 'string', enum: values };
    return s;
  };
  const both = diffMenus(gen(narrow(17, ['a', 'b'])), gen(narrow(17, ['a'])));
  assert.equal(both.suggestedBump, 'major');
  assert.ok(both.findings.some((f) => f.rule === 'diff/enum-narrowed' && plain(f.message).startsWith('gen.$defs.D17')));
  assert.match(both.findings.find((f) => /expand past/.test(f.message)).message, /the old and new input schemas expand past 50,000 nodes through their \$refs/);
});

test('a change past the depth limit says so, and is still caught', () => {
  const nest = (levels, leaf) => {
    let s = { type: 'string', enum: leaf };
    for (let i = 0; i < levels; i++) s = { type: 'object', properties: { n: s } };
    return { type: 'object', properties: { root: s } };
  };
  const deep = diffMenus(gen(nest(70, ['a', 'b'])), gen(nest(70, ['a'])));
  assert.deepEqual(rules(deep), ['diff/schema-other:gen']);
  assert.match(deep.findings[0].message, /changed more than 64 levels deep, below where toolmenu compares field by field\./);
  const shallow = diffMenus(gen(nest(40, ['a', 'b'])), gen(nest(40, ['a'])));
  assert.deepEqual(rules(shallow), ['diff/enum-narrowed:gen']);
});

test('arrays of objects are compared item field by item field', () => {
  const rows = (id) => ({ type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { id }, required: ['id'] } } } });
  const d = diffMenus(gen(rows({ type: 'string' })), gen(rows({ type: 'integer' })));
  assert.deepEqual(d.findings.map((f) => `${f.rule}: ${plain(f.message).split(' ')[0]}`), ['diff/param-type: gen.rows[].id']);
});

test('a recursive $ref neither hangs nor hides a change', () => {
  const tree = (label) => ({ type: 'object', $defs: { Node: { type: 'object', properties: { label, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } }, properties: { root: { $ref: '#/$defs/Node' } } });
  assert.deepEqual(diffMenus(gen(tree({ type: 'string' })), gen(tree({ type: 'string' }))).findings, []);
  const d = diffMenus(gen(tree({ type: 'string' })), gen(tree({ type: 'integer' })));
  assert.ok(d.findings.some((f) => f.rule === 'diff/param-type' && plain(f.message).startsWith('gen.root.label')), d.findings.map((f) => f.message).join('; '));
  assert.equal(d.suggestedBump, 'major');
});

// zod: .nullable() on an array, and z.discriminatedUnion, become anyOf/oneOf.
const marks = (values) => ({ anyOf: [{ type: 'array', items: { type: 'string', enum: values } }, { type: 'null' }] });
const shared = (values) => ({ type: 'object', $defs: { Text: { type: 'object', properties: { text: { type: 'string' }, marks: marks(values) } } }, properties: { title: { $ref: '#/$defs/Text' }, body: { $ref: '#/$defs/Text' } } });

test('an enum narrowed inside a union, behind a shared $ref, is breaking (the reporter\'s marks)', () => {
  const d = diffMenus(gen(shared(['bold', 'italic', 'code'])), gen(shared(['bold', 'italic'])));
  assert.equal(d.suggestedBump, 'major');
  // One change to a shared definition: one finding, both places listed.
  assert.deepEqual(d.findings.map((f) => `${f.severity} ${f.rule}`), ['error diff/enum-narrowed']);
  assert.deepEqual(d.findings[0].places, ['gen.title.marks(array)[]', 'gen.body.marks(array)[]']);
  // The headline names the first place, the detail the others: no place twice.
  assert.deepEqual(d.findings[0].detail, ['also at body.marks(array)[]']);
  // Widened, it's minor; nothing but the enum changed, so nothing else is said.
  assert.equal(diffMenus(gen(shared(['bold'])), gen(shared(['bold', 'code']))).suggestedBump, 'minor');
});

test('union options: removed is breaking, added is minor, matched by discriminator and compared inside', () => {
  const text = { type: 'object', properties: { kind: { const: 'text' }, value: { type: 'string' } }, required: ['kind'] };
  const image = (format) => ({ type: 'object', properties: { kind: { const: 'image' }, url: { type: 'string', format } }, required: ['kind'] });
  const block = (options) => ({ type: 'object', properties: { block: { oneOf: options } } });
  const gone = diffMenus(gen(block([text, image('uri')])), gen(block([text])));
  assert.deepEqual(rules(gone), ['diff/param-type:gen']);
  assert.match(plain(gone.findings[0].message), /gen\.block: no longer accepts the kind="image" option/);
  assert.equal(gone.suggestedBump, 'major');
  const added = diffMenus(gen(block([text])), gen(block([text, image('uri')])));
  assert.deepEqual(rules(added), ['diff/type-widened:gen']);
  // Options in another order are matched by kind, not position; a change inside one is found.
  const inside = diffMenus(gen(block([text, image('uri')])), gen(block([{ ...image('uri'), required: ['kind', 'url'] }, text])));
  assert.deepEqual(inside.findings.map((f) => plain(f.message).split(' ')[0]), ['gen.block(kind="image").url']);
  assert.equal(inside.findings[0].rule, 'diff/param-required');
  // Nullable added to a plain type widens; taken away, it breaks.
  const bare = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
  const nullable = { type: 'object', properties: { tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] } } };
  assert.equal(diffMenus(gen(bare), gen(nullable)).suggestedBump, 'minor');
  assert.equal(diffMenus(gen(nullable), gen(bare)).suggestedBump, 'major');
});

test('a recursive schema refactored into $defs is equivalent; a change in the recursive definition is found once', () => {
  const node = (label) => ({ type: 'object', properties: { label: { type: label }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } });
  const b = { type: 'object', properties: { text: { type: 'string' }, size: { type: 'string', enum: ['s', 'm'] } } };
  const before = { type: 'object', $defs: { Node: node('string') }, properties: { tree: { $ref: '#/$defs/Node' }, header: b, footer: b } };
  const after = { type: 'object', $defs: { Node: node('string'), B: b }, properties: { tree: { $ref: '#/$defs/Node' }, header: { $ref: '#/$defs/B' }, footer: { $ref: '#/$defs/B' } } };
  // Before: no findings at all, not even this notice.
  assert.deepEqual(rules(diffMenus(gen(before), gen(after))), ['diff/schema-equivalent:gen']);
  const changed = diffMenus(gen({ ...before, $defs: { Node: node('string') } }), gen({ ...before, $defs: { Node: node('integer') } }));
  assert.deepEqual(changed.findings.map((f) => plain(f.message).split(' ')[0]), ['gen.tree.label']);
});

test('a schema change no rule classifies is never silent', () => {
  // A keyword toolmenu doesn't compare, deep in a union option: still a "review it".
  const s = (min) => ({ type: 'object', properties: { v: { anyOf: [{ type: 'object', properties: { n: { type: 'integer', minimum: min } } }, { type: 'null' }] } } });
  const d = diffMenus(gen(s(0)), gen(s(1)));
  assert.ok(d.findings.length > 0 && d.findings.every((f) => f.rule === 'diff/schema-other'), JSON.stringify(d.findings));
});

test('only the $schema dialect changing, in several tools, is one notice naming them (mongodb-mcp-server 3.0.0)', () => {
  const s = (dialect, extra = {}) => ({ $schema: dialect, type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false, ...extra });
  const [d7, d20] = ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema'];
  const names = ['connect', 'find', 'count'];
  const d = diffMenus(menu(names.map((n) => ({ name: n, inputSchema: s(d7) }))), menu(names.map((n) => ({ name: n, inputSchema: s(d20) }))));
  assert.deepEqual(rules(d), ['diff/schema-dialect']);
  assert.match(d.findings[0].message, /^3 tools declare a different JSON Schema dialect/);
  assert.deepEqual(d.findings[0].tools, ['connect', 'find', 'count']);
  assert.match(d.findings[0].message, /connect, find, count\.$/);
  // One tool: said for it. With another change outside the parameters: still a review.
  assert.deepEqual(rules(diffMenus(menu([{ name: 'find', inputSchema: s(d7) }]), menu([{ name: 'find', inputSchema: s(d20) }]))), ['diff/schema-dialect:find']);
  assert.deepEqual(rules(diffMenus(menu([{ name: 'find', inputSchema: s(d7) }]), menu([{ name: 'find', inputSchema: s(d20, { minProperties: 1 }) }]))), ['diff/schema-other:find']);
});

test('a $ref to another document is left as it is', () => {
  const remote = { type: 'object', properties: { cfg: { $ref: 'https://example.com/schema.json' } } };
  assert.deepEqual(diffMenus(gen(remote), gen(structuredClone(remote))).findings, []);
});

test('a const is a one-value enum: changing it breaks callers, adding one narrows', () => {
  const withMode = (mode) => menu([{ name: 'run_query', inputSchema: schema({ mode }) }]);
  const changed = diffMenus(withMode({ type: 'string', const: 'fast' }), withMode({ type: 'string', const: 'safe' }));
  assert.deepEqual(rules(changed), ['diff/enum-narrowed:run_query']);
  assert.equal(changed.suggestedBump, 'major');
  assert.deepEqual(rules(diffMenus(withMode(str), withMode({ type: 'string', const: 'fast' }))), ['diff/enum-narrowed:run_query']);
  assert.deepEqual(rules(diffMenus(withMode({ type: 'string', const: 'fast' }), withMode({ type: 'string', enum: ['fast', 'safe'] }))), ['diff/enum-widened:run_query']);
});

test('version bump checks, including 0.x and calendar versions', () => {
  assert.equal(versionBump('1.2.3', '1.2.3foo'), undefined, 'not semver: trailing junk');
  assert.equal(versionBump('v1.2.3', '1.3.0+build.5'), 'minor', 'a v prefix and build metadata still parse');
  assert.equal(versionBump('1.2.3', '1.2.4'), 'patch');
  assert.equal(versionBump('1.2.3', '2.0.0'), 'major');
  assert.equal(versionBump('1.2.3', '1.2.3'), 'none');
  assert.equal(versionBump('2026.1.14', '2026.8.31'), undefined);
  const breaking = (from, to) => diffMenus(menu([tool('a', ['x'])]), menu([]), { release: { before: from, after: to } }).findings.filter((f) => f.rule === 'diff/version-bump');
  assert.equal(breaking('1.2.3', '1.3.0').length, 1, 'breaking change in a minor release');
  assert.equal(breaking('1.2.3', '2.0.0').length, 0);
  assert.equal(breaking('0.2.0', '0.3.0').length, 0, 'under 1.0, a minor bump may break');
  assert.equal(breaking('0.2.0', '0.2.0').length, 1);
});

test('token budget and config', () => {
  const before = menu([tool('a')]);
  const after = menu([tool('a'), tool('b')], '1.1.0');
  assert.ok(rules(diffMenus(before, after, { tokenBudget: 1 })).includes('diff/token-budget'));
  assert.deepEqual(rules(diffMenus(before, after, { rules: { 'diff/tool-added': 'off' } })), []);
  assert.deepEqual(rules(diffMenus(before, after, { ignore: ['b'] })), []);
});

test('ignored tools leave the token change and the budget too', () => {
  const before = menu([tool('a'), tool('debug_dump')]);
  const after = menu([tool('a'), tool('debug_dump', [], { description: 'Dump everything. '.repeat(400) })]);
  const d = diffMenus(before, after, { ignore: ['debug_*'], tokenBudget: 1000 });
  assert.equal(d.tokens.delta, 0);
  assert.deepEqual(d.tokens.tools, []);
  assert.deepEqual(rules(d), []);
  assert.ok(rules(diffMenus(before, after, { tokenBudget: 1000 })).includes('diff/token-budget'));
});

test('real data: server-filesystem 2026.1.14 → 2026.8.31', async () => {
  const before = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2026.1.14.json'));
  const after = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2026.8.31.json'));
  const d = diffMenus(before, after);
  assert.deepEqual(d.findings.filter((f) => f.class === 'breaking').map((f) => f.tool), ['move_file']);
  const hints = d.findings.filter((f) => f.rule === 'diff/annotations');
  // The same annotation change in 13 tools: one finding that lists them.
  assert.equal(hints.length, 1);
  assert.equal(hints[0].tools.length, 13, 'openWorldHint added to every other tool');
  assert.match(hints[0].message, /^Annotations changed the same way \(openWorldHint \(unset\) → false\) in 13 of 14 tools: /);
  assert.ok(d.tokens.delta > 0);
});

test('real data: an empty-schema menu (2025.7.1 installed today) does not produce false breaking changes', async () => {
  const before = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2025.7.1.json'));
  const after = await loadMenu(join(FIXTURES, 'menus/server-filesystem-2025.11.25.json'));
  const d = diffMenus(before, after);
  assert.deepEqual(d.findings.filter((f) => f.class === 'breaking'), []);
  assert.equal(d.suggestedBump, 'minor');
});

test('cli: diff exit codes and formats', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'old.json'), JSON.stringify(menu([tool('a', ['x']), tool('b')])));
  writeFileSync(join(dir, 'new.json'), JSON.stringify(menu([tool('b')], '1.0.1')));
  writeFileSync(join(dir, 'same.json'), JSON.stringify(menu([tool('a', ['x']), tool('b')])));
  writeFileSync(join(dir, 'junk.json'), '{"hello": 1}');

  const breaking = await run(['diff', 'old.json', 'new.json'], { cwd: dir });
  assert.equal(breaking.code, 1);
  assert.match(breaking.stdout, /ERROR  diff\/tool-removed/);
  assert.match(breaking.stdout, /1\.0\.0 → 1\.0\.1 \(server-reported\)/);
  assert.match(breaking.stdout, /suggested bump: major · not checked \(pass --release old\.\.new\)/);
  assert.doesNotMatch(breaking.stdout, /diff\/version-bump/, 'serverInfo.version is not the release version');

  const released = await run(['diff', '--release', '2.3.0..2.3.1', 'old.json', 'new.json'], { cwd: dir });
  assert.match(released.stdout, /2\.3\.0 → 2\.3\.1\n/);
  assert.match(released.stdout, /suggested bump: major · 2\.3\.0 → 2\.3\.1 is a patch bump: too small, release 3\.0\.0/);
  assert.match(released.stdout, /WARN   diff\/version-bump/);
  const server = await run(['diff', '--server-version-is-release', 'old.json', 'new.json'], { cwd: dir });
  assert.match(server.stdout, /1\.0\.0 → 1\.0\.1 \(server-reported\)/, 'the label stays when the check uses it');
  assert.match(server.stdout, /suggested bump: major · 1\.0\.0 → 1\.0\.1 is a patch bump: too small/);
  assert.match(server.stdout, /WARN   diff\/version-bump\n\s+1\.0\.0 → 1\.0\.1 is a patch bump, but the menu has breaking changes/);
  const calendar = await run(['diff', '--release', '2026.1.1..2026.2.1', 'old.json', 'new.json'], { cwd: dir });
  assert.match(calendar.stdout, /not checked \(calendar version\)/);
  assert.doesNotMatch(calendar.stdout, /diff\/version-bump/);
  assert.equal((await run(['diff', '--release', '2.3.0', 'old.json', 'new.json'], { cwd: dir })).code, 2);

  const same = await run(['diff', 'old.json', 'same.json'], { cwd: dir });
  assert.equal(same.code, 0);
  assert.match(same.stdout, /No findings/);

  const json = JSON.parse((await run(['diff', '--json', 'old.json', 'new.json'], { cwd: dir })).stdout);
  assert.equal(json.suggestedBump, 'major');
  assert.ok(json.tokens.delta < 0);

  const gh = await run(['diff', '--format', 'github', 'old.json', 'new.json'], { cwd: dir });
  assert.match(gh.stdout, /^::error title=toolmenu diff\/tool-removed::/m);
  assert.match(gh.stdout, /^::notice title=toolmenu diff::/m);

  assert.equal((await run(['diff', 'old.json'], { cwd: dir })).code, 2);
  const junk = await run(['diff', 'old.json', 'junk.json'], { cwd: dir });
  assert.equal(junk.code, 2);
  assert.match(junk.stderr, /isn't a toolmenu menu file/);
});

test('cli: snapshot then diff, the CI flow', async () => {
  const dir = tempDir();
  const server = ['--', process.execPath, join(FIXTURES, 'sdk-server.mjs')];
  assert.equal((await run(['snapshot', '--out', 'baseline.json', ...server], { cwd: dir })).code, 0);
  assert.equal((await run(['snapshot', '--out', 'current.json', ...server], { cwd: dir })).code, 0);
  const r = await run(['diff', 'baseline.json', 'current.json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /No findings/);
});

test('type changes: widening is minor, narrowing is breaking (real cases)', () => {
  const t = (prop) => menu([{ name: 't', description: 'T.', inputSchema: { type: 'object', properties: { p: prop }, required: ['p'] } }], '1.0.0');
  const rulesOf = (a, b) => diffMenus(t(a), t(b)).findings.filter((f) => f.rule !== 'diff/version-bump').map((f) => f.rule);
  assert.deepEqual(rulesOf({ type: 'boolean' }, { type: ['boolean', 'string'] }), ['diff/type-widened'], 'sequential-thinking 2026.8.31');
  assert.deepEqual(rulesOf({ type: 'object' }, {}), ['diff/type-widened'], 'notion 2.3.1: object → any');
  assert.deepEqual(rulesOf({ type: 'integer' }, { type: 'number' }), ['diff/type-widened']);
  assert.deepEqual(rulesOf({ type: 'number' }, { type: 'integer' }), ['diff/param-type'], 'firecrawl 3.25.0');
  assert.deepEqual(rulesOf({ type: 'string' }, { type: 'number' }), ['diff/param-type']);
  assert.deepEqual(rulesOf({}, { type: 'string' }), ['diff/param-type'], 'any → string narrows');
});

test('0.0.x versions promise nothing, so any bump is fine', () => {
  const bump = (from, to) => diffMenus(menu([tool('a', ['x'])]), menu([]), { release: { before: from, after: to } }).findings.filter((f) => f.rule === 'diff/version-bump');
  assert.equal(bump('0.0.76', '0.0.77').length, 0, 'playwright-mcp');
  assert.equal(bump('0.33.0', '0.34.0').length, 0, 'sentry: 0.x minor may break');
  assert.equal(bump('1.5.0', '1.6.0').length, 1, 'chrome-devtools: 1.x minor may not');
});

test('removing an optional parameter only breaks callers when extra properties are rejected (notion 2.3.1)', () => {
  const t = (props, required, extra = {}) => menu([{ name: 't', description: 'T.', inputSchema: { type: 'object', properties: props, required, ...extra } }], '1.0.0');
  const rulesOf = (a, b) => diffMenus(a, b).findings.filter((f) => f.rule !== 'diff/version-bump').map((f) => f.rule);
  const withVersion = { user_id: { type: 'string' }, 'Notion-Version': { type: 'string', default: '2025-09-03' } };
  assert.deepEqual(rulesOf(t(withVersion, ['user_id']), t({ user_id: { type: 'string' } }, ['user_id'])), ['diff/param-dropped']);
  assert.deepEqual(rulesOf(t(withVersion, ['user_id']), t({ user_id: { type: 'string' } }, ['user_id'], { additionalProperties: false })), ['diff/properties-closed', 'diff/param-removed'], 'closing the schema is itself reported, as breaking');
  assert.deepEqual(rulesOf(t(withVersion, ['user_id', 'Notion-Version']), t({ user_id: { type: 'string' } }, ['user_id'])), ['diff/param-removed']);
});

test('tokens count what the model reads: name, description, inputSchema', () => {
  const plain = tool('get_form', ['form_id']);
  const dressed = {
    ...plain,
    title: 'Get form',
    icons: [{ src: 'data:image/png;base64,' + 'A'.repeat(4000) }],
    outputSchema: { type: 'object', properties: { form: { type: 'object', description: 'The form. '.repeat(50) } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { 'x/y': 'z'.repeat(500) },
  };
  const [a, b] = [buildMenu([plain], {}), buildMenu([dressed], {})];
  assert.equal(b.totalTokens, a.totalTokens);
  assert.equal(diffMenus(a, b).tokens.delta, 0);
});

test('loadMenu recounts tokens a baseline file carries (older toolmenu counted every field)', async () => {
  const fresh = buildMenu([tool('a', ['x'])], {});
  const path = join(tempDir(), 'menu.json');
  writeFileSync(path, JSON.stringify({ ...fresh, tools: fresh.tools.map((t) => ({ ...t, tokens: 9999 })), totalTokens: 9999 }));
  const loaded = await loadMenu(path);
  assert.equal(loaded.totalTokens, fresh.totalTokens);
  assert.equal(loaded.tools[0].tokens, fresh.tools[0].tokens);
});

test('a type written as anyOf alternatives is the same type (zod switched between the two)', () => {
  const desc = { description: 'Sort field.' };
  const before = menu([{ name: 't', inputSchema: schema({ sort: { anyOf: [{ type: 'string' }, { type: 'null' }], ...desc } }, []) }]);
  const after = menu([{ name: 't', inputSchema: schema({ sort: { type: ['string', 'null'], ...desc } }, []) }]);
  assert.deepEqual(rules(diffMenus(before, after)), []);
  // A real narrowing written either way is still caught.
  const narrow = menu([{ name: 't', inputSchema: schema({ sort: { type: 'string', ...desc } }, []) }]);
  assert.deepEqual(rules(diffMenus(before, narrow)), ['diff/param-type:t']);
});

test('a new required parameter with a default says so', () => {
  const before = menu([{ name: 'shot', inputSchema: schema({ type: str }) }]);
  const after = menu([{ name: 'shot', inputSchema: schema({ type: str, scale: { type: 'string', enum: ['css', 'device'], default: 'css' } }) }]);
  const f = diffMenus(before, after).findings.find((f) => f.rule === 'diff/param-required');
  assert.match(f.message, /has a default \("css"\)/);
});

// chrome-devtools-mcp 1.7.0 → 1.8.0, in miniature: `pageId` became required in
// most tools, and upload_file's `filePath` became `filePaths` (an array).
const pageId = { type: 'number', description: 'The page to act on.' };
const browserTool = (name, extra = {}, withPage = true, required = []) => ({
  name,
  description: `${name}.`,
  inputSchema: { type: 'object', properties: { ...extra, ...(withPage ? { pageId } : {}) }, required: [...required, ...(withPage ? ['pageId'] : [])], additionalProperties: false },
});
const names = ['click', 'drag', 'emulate', 'fill', 'hover', 'press_key', 'type_text', 'wait_for'];
const browser = (after) =>
  menu(
    [
      ...names.map((n) => browserTool(n, { uid: str }, after, ['uid'])),
      after ? browserTool('upload_file', { filePaths: { type: 'array', items: str } }, true, ['filePaths']) : browserTool('upload_file', { filePath: str }, false, ['filePath']),
      browserTool('list_pages', {}, false),
    ],
    after ? '1.8.0' : '1.7.0',
  );

test('the same change in many tools is one finding that lists them; counts are per change', () => {
  const d = diffMenus(browser(false), browser(true), { release: { before: '1.7.0', after: '1.8.0' } });
  const required = d.findings.filter((f) => f.rule === 'diff/param-required');
  // pageId in 9 tools (one finding), filePaths in upload_file (another).
  assert.equal(required.length, 2);
  const grouped = required.find((f) => f.tools);
  assert.deepEqual(grouped.tools, [...names, 'upload_file']);
  assert.equal(grouped.tool, undefined);
  assert.equal(grouped.message, "`pageId` is new and required in 9 of 10 tools: click, drag, emulate, fill, hover, press_key, … (+3). Existing calls don't send it, so they fail validation.");
  assert.deepEqual(grouped.detail, [`tools: ${[...names, 'upload_file'].join(', ')}`]);
  assert.deepEqual(grouped.places, [...names, 'upload_file'].map((n) => `${n}.pageId`));
  assert.match(grouped.fix, /^Make `pageId` optional and fall back to a default when it's missing, or release it as 2\.0\.0\.$/);
  // Counts: 3 breaking changes (pageId, filePath removed, filePaths required), in 9 tools.
  assert.deepEqual(d.classes.breaking, { changes: 3, tools: 9 });
  assert.equal(d.suggestedBump, 'major');
  assert.equal(d.releaseAs, '2.0.0');
  assert.match(d.findings.find((f) => f.rule === 'diff/version-bump').message, /^1\.7\.0 → 1\.8\.0 is a minor bump, but the menu has breaking changes \(3 changes in 9 tools\)\. They need a major bump\.$/);
  // Grouping never hides a tool from --ignore: an ignored tool leaves the list.
  const ignored = diffMenus(browser(false), browser(true), { ignore: ['click'] });
  assert.ok(!ignored.findings.some((f) => f.tools?.includes('click') || f.tool === 'click'));
  assert.equal(ignored.findings.find((f) => f.tools)?.tools.length, 8);
});

test('the same path with a different change stays separate findings', () => {
  const t = (name, type) => ({ name, inputSchema: schema({ id: { type } }) });
  const d = diffMenus(menu([t('a', 'string'), t('b', 'string')]), menu([t('a', 'integer'), t('b', 'boolean')]));
  assert.deepEqual(rules(d), ['diff/param-type:a', 'diff/param-type:b']);
});

test('a parameter removed while a close name became required: one unsure rename hint, still breaking', () => {
  const d = diffMenus(browser(false), browser(true));
  const hint = d.findings.find((f) => f.rule === 'diff/param-renamed');
  assert.equal(hint.confidence, 'unsure');
  assert.equal(hint.severity, 'warn');
  assert.equal(hint.class, undefined, 'a hint, not a change: it adds nothing to the bump');
  assert.equal(hint.tool, 'upload_file');
  assert.match(hint.message, /^`upload_file\.filePath` → `filePaths` looks like a rename\. `filePath` was removed and `filePaths` is new and required \(string → array of string\)\./);
  assert.match(hint.fix, /accept `filePath` for one more release/);
  assert.ok(d.findings.some((f) => f.rule === 'diff/param-removed' && f.tool === 'upload_file'));
  // Names that aren't close, or types that don't fit, aren't guessed at.
  const pair = (from, fromType, to, toType) => diffMenus(menu([{ name: 't', inputSchema: schema({ [from]: { type: fromType } }) }]), menu([{ name: 't', inputSchema: schema({ [to]: { type: toType } }) }]));
  assert.ok(pair('user_id', 'string', 'userId', 'string').findings.some((f) => f.rule === 'diff/param-renamed'));
  assert.ok(pair('query', 'string', 'queries', 'string').findings.some((f) => f.rule === 'diff/param-renamed'));
  assert.ok(!pair('query', 'string', 'limit', 'string').findings.some((f) => f.rule === 'diff/param-renamed'));
  assert.ok(!pair('user_id', 'string', 'userId', 'boolean').findings.some((f) => f.rule === 'diff/param-renamed'));
});

test('under 1.0.0 both steps shift: a feature in a patch is fine, breaking needs a minor (npm caret)', () => {
  const before = menu([tool('search', ['q'])], '0.2.16');
  const feature = menu([tool('search', ['q']), tool('extract', ['url'])], '0.2.17');
  const f = diffMenus(before, feature, { release: { before: '0.2.16', after: '0.2.17' } });
  assert.equal(f.suggestedBump, 'minor');
  assert.equal(f.requiredBump, 'patch');
  assert.ok(!f.findings.some((x) => x.rule === 'diff/version-bump'), 'Tavily 0.2.16 → 0.2.17: no warning');
  const breaking = menu([], '0.2.17');
  const b = diffMenus(before, breaking, { release: { before: '0.2.16', after: '0.2.17' } });
  const warn = b.findings.find((x) => x.rule === 'diff/version-bump');
  assert.match(warn.message, /They need a minor bump\. Under 1\.0\.0 each step is one lower: npm's \^0\.2\.16 accepts any 0\.2\.x/);
  assert.equal(warn.fix, 'Release it as 0.3.0, or make the breaking changes compatible (each one\'s next step says how).');
  assert.ok(!diffMenus(before, breaking, { release: { before: '0.2.16', after: '0.3.0' } }).findings.some((x) => x.rule === 'diff/version-bump'));
  // From 1.0.0, a feature in a patch still warns.
  assert.ok(diffMenus(before, feature, { release: { before: '1.2.0', after: '1.2.1' } }).findings.some((x) => x.rule === 'diff/version-bump'));
});

test('long description changes show where they changed, on one line each', () => {
  const long = (word) => `Take a text snapshot of the ${word} page based on the a11y tree.\nThe snapshot lists page elements along with a unique identifier. Always use the latest snapshot and prefer it over a screenshot.`;
  const d = diffMenus(menu([tool('snap', [], { description: long('currently selected') })]), menu([tool('snap', [], { description: long('target') })]));
  assert.deepEqual(d.findings[0].detail, ['- …text snapshot of the currently selected page based on the…', '+ …text snapshot of the target page based on the…']);
});

test('cli: diff markdown groups by class, folds notices and long tool lists', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'old.json'), JSON.stringify(browser(false)));
  writeFileSync(join(dir, 'new.json'), JSON.stringify(browser(true)));
  const r = await run(['diff', '--release', '1.7.0..1.8.0', '--format', 'markdown', 'old.json', 'new.json'], { cwd: dir });
  assert.match(r.stdout, /\*\*3 breaking changes\*\* in 9 tools/);
  assert.match(r.stdout, /> \*\*Version:\*\* suggested bump: \*\*major\*\* · 1\.7\.0 → 1\.8\.0 is a minor bump: \*\*too small, release 2\.0\.0\*\*/);
  assert.match(r.stdout, /#### Breaking \(3\)/);
  assert.match(r.stdout, /#### To check \(2\)/);
  assert.match(r.stdout, /<details><summary>all 9 tools<\/summary>/);
  const text = await run(['diff', '--release', '1.7.0..1.8.0', 'old.json', 'new.json'], { cwd: dir });
  assert.match(text.stdout, /changes {2}3 breaking \(9 tools\) · 0 minor · 0 notice/);
  assert.match(text.stdout, /WARN   diff\/param-renamed · unsure/);
});

test('grouped removals count against the old menu: 3 of 6 tools, not "all 3"', () => {
  const six = ['a', 'b', 'c', 'x', 'y', 'z'].map((n) => tool(n, ['q']));
  const removed = (d) => plain(d.findings.find((f) => f.rule === 'diff/tool-removed').message);
  assert.equal(removed(diffMenus(menu(six), menu(six.slice(3), '2.0.0'))), '3 of 6 tools were removed: a, b, c. Calls to them now fail with an unknown-tool error.');
  assert.match(removed(diffMenus(menu(six), menu([tool('n', ['r', 's'])], '2.0.0'))), /^all 6 tools were removed: /);
  const added = diffMenus(menu(six.slice(3)), menu(six, '1.1.0')).findings.find((f) => f.rule === 'diff/tool-added');
  assert.match(plain(added.message), /^3 of 6 tools are new /);
});

test('cli: diff markdown sections follow severity: a notice raised to error is shown, a breaking rule lowered to info is folded', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'old.json'), JSON.stringify(menu([tool('a', ['x'], { description: 'Old words.' }), tool('b', ['y'])])));
  writeFileSync(join(dir, 'new.json'), JSON.stringify(menu([tool('a', ['x'], { description: 'New words.' })], '2.0.0')));
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ rules: { 'diff/description': 'error', 'diff/tool-removed': 'info' } }));
  const r = await run(['diff', '--format', 'markdown', 'old.json', 'new.json'], { cwd: dir });
  assert.doesNotMatch(r.stdout, /#### Breaking/);
  assert.match(r.stdout, /#### To check \(1\)\n\n\| \| Rule \| Change \|\n\|---\|---\|---\|\n\| \*\*error\*\* \| `diff\/description`/);
  assert.match(r.stdout, /<details><summary>Notices \(1\)<\/summary>\n\n\| \| Rule \| Change \|\n\|---\|---\|---\|\n\| info \| `diff\/tool-removed`/);
});

test('diff: a changed default is its own notice, with both values', () => {
  const t = (end) => ({ name: 'list_transactions', description: 'List transactions.', inputSchema: { type: 'object', properties: { end_date: { type: 'string', default: end } } } });
  const d = diffMenus(buildMenu([t('2026-09-29T22:11:21.528Z')], { name: 's' }), buildMenu([t('2026-10-01T11:54:51.571Z')], { name: 's' }));
  const f = d.findings.find((x) => x.rule === 'diff/param-default');
  assert.ok(f, d.findings.map((x) => x.rule).join(', '));
  assert.equal(f.severity, 'info');
  assert.match(f.message, /list_transactions\.end_date.*default changed: "2026-09-29T22:11:21\.528Z" → "2026-10-01T11:54:51\.571Z"/);
  assert.ok(!d.findings.some((x) => x.rule === 'diff/schema-other'), 'no longer "keywords toolmenu doesn\'t classify"');
  assert.equal(d.suggestedBump, 'patch');
  const added = diffMenus(buildMenu([t(undefined)], { name: 's' }), buildMenu([t('now')], { name: 's' })).findings.find((x) => x.rule === 'diff/param-default');
  assert.match(added.message, /default changed: \(none\) → "now"/);
});

test('diff: a session union menu has no order to compare, so no diff/order notice', () => {
  const t = (name) => ({ name, description: `${name}.`, inputSchema: { type: 'object', properties: {} } });
  const listed = buildMenu([t('a'), t('b'), t('c')], { name: 's' });
  const union = { ...buildMenu([t('b'), t('a'), t('c')], { name: 's' }), from: 'session' };
  assert.ok(diffMenus(listed, buildMenu([t('b'), t('a'), t('c')], { name: 's' })).findings.some((f) => f.rule === 'diff/order'), 'two snapshots: order compared');
  assert.ok(!diffMenus(listed, union).findings.some((f) => f.rule === 'diff/order'));
  assert.ok(!diffMenus(union, listed).findings.some((f) => f.rule === 'diff/order'));
});

test('session --union-out marks the menu as a session union', async () => {
  const dir = tempDir();
  await run(['session', '--auto', '--union-out', 'union.json', '--', process.execPath, join(FIXTURES, 'session-server.mjs')], { cwd: dir });
  assert.equal(JSON.parse(readFileSync(join(dir, 'union.json'), 'utf8')).from, 'session');
});

test('a schema too large to expand: definitions → $defs with a new $schema is the dialect, not a removed option', () => {
  const D07 = 'http://json-schema.org/draft-07/schema#';
  const D2020 = 'https://json-schema.org/draft/2020-12/schema';
  const big = (n, pool, dialect, remove = false) => {
    const prefix = `#/${pool}/`;
    const defs = { [`D${n}`]: { type: 'string' } };
    for (let i = 0; i < n; i++) defs[`D${i}`] = { type: 'object', properties: { x: { $ref: `${prefix}D${i + 1}` }, y: { $ref: `${prefix}D${i + 1}` } } };
    const options = [{ type: 'object', properties: { kind: { const: 'a' } } }, { type: 'object', properties: { kind: { const: 'b' } } }, { $ref: `${prefix}D0` }];
    return { $schema: dialect, type: 'object', [pool]: defs, properties: { v: { anyOf: remove ? options.slice(1) : options } } };
  };
  const moved = diffMenus(gen(big(17, 'definitions', D07)), gen(big(17, '$defs', D2020)));
  assert.deepEqual(rules(moved), ['diff/schema-dialect:gen']);
  assert.equal(moved.suggestedBump, 'patch', 'a dialect notice, as for a small schema');
  // The same rename with the dialect unchanged is still read as moved refs: conservative.
  const same = diffMenus(gen(big(17, 'definitions', D2020)), gen(big(17, '$defs', D2020)));
  assert.ok(same.findings.some((f) => /\$defs entries added/.test(f.message)), 'no dialect change: still reported');
  // A really removed option under a changed dialect is still breaking.
  const removed = diffMenus(gen(big(17, 'definitions', D07)), gen(big(17, '$defs', D2020, true)));
  assert.ok(removed.findings.some((f) => f.rule === 'diff/param-type' && /no longer accepts/.test(f.message)));
  assert.equal(removed.suggestedBump, 'major');
});

test('a recursive schema whose definitions → $defs moved with the dialect is the dialect, not a removed option', () => {
  const D07 = 'http://json-schema.org/draft-07/schema#';
  const D2020 = 'https://json-schema.org/draft/2020-12/schema';
  const tree = (pool, dialect, extra = []) => {
    const ref = `#/${pool}/node`;
    return {
      $schema: dialect, type: 'object',
      properties: { blocks: { type: 'array', items: { anyOf: [{ type: 'object', properties: { type: { const: 'list' }, content: { type: 'array', items: { $ref: ref } } } }, ...extra] } } },
      [pool]: { node: { anyOf: [{ type: 'string' }, { type: 'object', properties: { type: { const: 'item' }, content: { type: 'array', items: { $ref: ref } } } }] } },
    };
  };
  const moved = diffMenus(gen(tree('definitions', D07)), gen(tree('$defs', D2020)));
  assert.deepEqual(rules(moved), ['diff/schema-dialect:gen']);
  assert.equal(moved.suggestedBump, 'patch');
  // A really removed option under the same dialect change is still breaking.
  const removed = diffMenus(gen(tree('definitions', D07, [{ type: 'object', properties: { type: { const: 'quote' } } }])), gen(tree('$defs', D2020)));
  assert.ok(removed.findings.some((f) => f.rule === 'diff/param-type' && /no longer accepts/.test(f.message)));
});
