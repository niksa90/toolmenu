// spec/ref, end to end: a 2026-07-28 fixture server with hand-written schemas, the
// CLI, and the official SDK client as the referee for what an unresolved $ref does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FIXTURES, run } from './helpers.mjs';
import { BROKEN, VALID } from './fixtures/ref-server.mjs';
import { unresolvedRefs } from '../dist/rules/refs.js';
import { breakdown } from '../dist/breakdown.js';
import { buildMenu } from '../dist/menu.js';

const server = join(FIXTURES, 'ref-server.mjs');
const RULE = 'spec/ref';
const findingsOf = (stdout) => JSON.parse(stdout).findings.filter((f) => f.rule === RULE);

test('spec/ref: each unresolved $ref is a finding at the severity what clients do warrants; resolvable ones are quiet', async () => {
  const r = await run(['snapshot', '--no-write', '--json', '--', process.execPath, server]);
  const by = Object.fromEntries(findingsOf(r.stdout).map((f) => [f.tool, f]));
  assert.deepEqual(Object.keys(by).sort(), Object.keys(BROKEN).sort(), 'one finding per broken tool, none for $defs, #anchor, $id or # refs');
  assert.deepEqual(
    Object.fromEntries(Object.entries(by).map(([t, f]) => [t, f.severity])),
    { ref_input_missing: 'error', ref_input_network: 'warn', ref_output_missing: 'error', ref_output_network: 'error' },
  );
  assert.match(by.ref_output_missing.message, /the official SDK client fails every call to it \("has an invalid outputSchema: can't resolve reference"\)/);
  assert.deepEqual(by.ref_output_missing.detail, ['outputSchema result: $ref "#/$defs/Result" points to nothing in the schema']);
  assert.deepEqual(by.ref_output_network.detail, ['outputSchema result: $ref "https://example.com/schemas/result.json" is a network URI, which clients must not fetch']);
  assert.match(by.ref_input_missing.message, /points to nothing in the schema \("#\/\$defs\/Missing"\), so the schema isn't valid/);
  assert.deepEqual(by.ref_input_network.detail, ['inputSchema filter.region: $ref "https://example.com/schemas/region.json" is a network URI, which clients must not fetch']);
  assert.match(by.ref_input_network.message, /Clients must not fetch it and should reject the schema/);
  for (const f of Object.values(by)) assert.match(f.fix, /in the (input|output)Schema's own \$defs and point the \$ref there \(#\/\$defs\/…\)/);
  // Definitions named by $anchor or $id are used: no "unused $defs" note for them.
  const text = await run(['snapshot', '--no-write', '--', process.execPath, server]);
  assert.doesNotMatch(text.stdout, /unused \$defs/);
});

test('spec/ref: the official SDK client fails every call to a tool whose outputSchema has an unresolved $ref, and only those', async () => {
  const client = new Client({ name: 'referee', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
  try {
    // A client learns each tool's outputSchema from tools/list, as an agent's client does before calling.
    const listed = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(listed.length, Object.keys(VALID).length + Object.keys(BROKEN).length, 'every tool is listed: the failure comes at call time');
    const outcome = {};
    for (const name of [...Object.keys(VALID), ...Object.keys(BROKEN)]) {
      try {
        await client.callTool({ name, arguments: {} });
        outcome[name] = 'ok';
      } catch (e) {
        outcome[name] = /invalid outputSchema: can't resolve reference/.test(e.message) ? 'unresolved' : e.message;
      }
    }
    const failing = Object.entries(outcome).filter(([, o]) => o !== 'ok').map(([n]) => n).sort();
    assert.deepEqual(failing, ['ref_output_missing', 'ref_output_network']);
    assert.ok(failing.every((n) => outcome[n] === 'unresolved'));
  } finally {
    await client.close();
  }
});

test('spec/ref: a 2025 server and a server whose refs all resolve get no finding', async () => {
  const legacy = await run(['snapshot', '--no-write', '--json', '--env', 'LEGACY=1', '--', process.execPath, server]);
  assert.ok(JSON.parse(legacy.stdout).server.protocolVersion < '2026-07-28');
  assert.deepEqual(findingsOf(legacy.stdout), []);
  const valid = await run(['snapshot', '--no-write', '--json', '--env', 'REFS=valid', '--', process.execPath, server]);
  assert.deepEqual(findingsOf(valid.stdout), []);
});

test('unresolvedRefs: escaped pointers resolve; a "$ref" inside enum, const or default is data, not a reference', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { $ref: '#/$defs/a~1b' },
      b: { $dynamicRef: '#node' },
      c: { type: 'string', enum: [{ $ref: '#/nowhere' }], default: { $ref: '#/nowhere' } },
    },
    $defs: { 'a/b': { type: 'string' }, N: { $dynamicAnchor: 'node' } },
  };
  assert.deepEqual(unresolvedRefs(schema, 'inputSchema'), []);
  assert.deepEqual(unresolvedRefs({ type: 'object', properties: { x: { items: { $ref: '#/$defs/X' } } } }, 'inputSchema').map((f) => f.path), ['x.<items>']);
});

test('breakdown: a definition named by $anchor or $id is used; one nothing names is not', () => {
  const tool = (defs, props) => ({ name: 't', description: 'T.', inputSchema: { type: 'object', properties: props, $defs: defs } });
  const used = buildMenu([tool({ A: { $anchor: 'amount', type: 'number' }, B: { $id: 'https://x.test/b.json', type: 'string' } }, { a: { $ref: '#amount' }, b: { $ref: 'https://x.test/b.json' } })], {});
  assert.equal(breakdown(used).unusedDefs.tokens, 0);
  const unused = buildMenu([tool({ A: { $anchor: 'amount', type: 'number' } }, { a: { type: 'string' } })], {});
  assert.ok(breakdown(unused).unusedDefs.tokens > 0);
});

// 0.16.1: cases the review of 0.16.0 found.
test('unresolvedRefs: a malformed percent-escape is a missing ref, never a crash', () => {
  const faults = unresolvedRefs({ type: 'object', properties: { a: { $ref: '#/$defs/100%' } } }, 'inputSchema');
  assert.deepEqual(faults.map((f) => [f.path, f.ref, f.kind]), [['a', '#/$defs/100%', 'missing']]);
});

test('unresolvedRefs: parameters named like data keywords are checked, and anchors under them count', () => {
  const missing = unresolvedRefs({ type: 'object', properties: { default: { $ref: '#/$defs/Missing' } } }, 'inputSchema');
  assert.deepEqual(missing.map((f) => f.path), ['default']);
  const anchored = { type: 'object', properties: { a: { $ref: '#money' }, examples: { $anchor: 'money', type: 'number' } } };
  assert.deepEqual(unresolvedRefs(anchored, 'inputSchema'), []);
});

test('unresolvedRefs: a pointer inside an embedded $id resource resolves there; draft-07 "#name" ids and "" refs resolve', () => {
  const embedded = { type: 'object', properties: { a: { $id: 'https://x.test/a.json', $defs: { B: { type: 'string' } }, properties: { b: { $ref: '#/$defs/B' } } } } };
  assert.deepEqual(unresolvedRefs(embedded, 'inputSchema'), []);
  const draft07 = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { n: { $ref: '#node' } }, definitions: { N: { $id: '#node', type: 'string' } } };
  assert.deepEqual(unresolvedRefs(draft07, 'inputSchema'), []);
  assert.deepEqual(unresolvedRefs({ type: 'object', properties: { self: { $ref: '' } } }, 'inputSchema'), []);
  // A relative ref against an absolute $id is a network URI, which clients won't fetch.
  const relative = unresolvedRefs({ $id: 'https://x.test/root.json', type: 'object', properties: { a: { $ref: 'other.json' } } }, 'inputSchema');
  assert.deepEqual(relative.map((f) => f.kind), ['network']);
});

test('breakdown: $dynamicAnchor and anchors nested inside a definition count as used; a bad escape does not crash it', () => {
  const tool = (schema) => ({ name: 't', description: 'T.', inputSchema: schema });
  const dynamic = buildMenu([tool({ type: 'object', properties: { n: { $dynamicRef: '#node' } }, $defs: { node: { $dynamicAnchor: 'node', type: 'object' } } })], {});
  assert.equal(breakdown(dynamic).unusedDefs.tokens, 0);
  const nested = buildMenu([tool({ type: 'object', properties: { n: { $ref: '#inner' } }, $defs: { Outer: { type: 'object', properties: { x: { $anchor: 'inner', type: 'string' } } } } })], {});
  assert.equal(breakdown(nested).unusedDefs.tokens, 0);
  const bad = buildMenu([tool({ type: 'object', properties: { a: { $ref: '#/$defs/100%' } }, $defs: { A: { type: 'string' } } })], {});
  assert.ok(breakdown(bad).unusedDefs.tokens > 0, 'A is unused, and nothing threw');
});

// 0.16.1, second review: the shared resolver's own regressions.
test('unresolvedRefs: a broken local fragment is missing even under an absolute $id, never "network"', () => {
  const faults = unresolvedRefs({ $id: 'https://x.test/root.json', type: 'object', properties: { a: { $ref: '#/$defs/Typo' }, b: { $ref: '#nowhere' } } }, 'inputSchema');
  assert.deepEqual(faults.map((f) => [f.path, f.kind]), [['a', 'missing'], ['b', 'missing']]);
});

test('unresolvedRefs: a ref to a boolean schema resolves', () => {
  assert.deepEqual(unresolvedRefs({ type: 'object', properties: { a: { $ref: '#/$defs/Any' } }, $defs: { Any: true } }, 'inputSchema'), []);
  assert.deepEqual(unresolvedRefs({ type: 'object', additionalProperties: false, properties: { a: { $ref: '#/additionalProperties' } } }, 'inputSchema'), []);
});

test('unresolvedRefs: draft-07 dependencies and contentSchema are walked; branches keep their index', () => {
  const draft07 = { type: 'object', properties: { cc: { type: 'string' } }, dependencies: { cc: { $ref: '#/definitions/Nope' }, names: ['cc'] } };
  assert.deepEqual(unresolvedRefs(draft07, 'inputSchema').map((f) => f.path), ['<dependencies>.cc']);
  assert.deepEqual(unresolvedRefs({ type: 'object', properties: { a: { anyOf: [{ $ref: '#/$defs/X' }, { $ref: '#/$defs/Y' }] } } }, 'inputSchema').map((f) => f.path), ['a.<anyOf>.0', 'a.<anyOf>.1']);
});

test('breakdown: entries reached through dependencies, a boolean entry, and both refs on one node count as used', () => {
  const tool = (schema) => ({ name: 't', description: 'T.', inputSchema: schema });
  const deps = buildMenu([tool({ type: 'object', properties: { cc: { type: 'string' } }, dependencies: { cc: { $ref: '#/definitions/billing' } }, definitions: { billing: { type: 'object', properties: { address: { type: 'string' } } } } })], {});
  assert.equal(breakdown(deps).unusedDefs.tokens, 0);
  const bool = buildMenu([tool({ type: 'object', properties: { a: { $ref: '#/$defs/Any' } }, $defs: { Any: true } })], {});
  assert.equal(breakdown(bool).unusedDefs.tokens, 0);
  const both = buildMenu([tool({ type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { $ref: '#/$defs/B', $dynamicRef: '#c' }, B: { type: 'string' }, C: { $dynamicAnchor: 'c', type: 'object' } } })], {});
  assert.equal(breakdown(both).unusedDefs.tokens, 0);
});

// 0.16.2: the resolver's remaining edge cases.
test('unresolvedRefs: relative $ids join against the resource they sit in, even with no absolute $id at the root', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { $id: 'dir/a.json', properties: { inner: { $id: 'b.json', type: 'string' }, x: { $ref: 'b.json' } } },
      y: { $ref: 'dir/b.json' },
    },
  };
  assert.deepEqual(unresolvedRefs(schema, 'inputSchema'), []);
  // "b.json" at the root is not "dir/b.json": it points to nothing, and it is not a network URI.
  const wrong = unresolvedRefs({ type: 'object', properties: { a: { $id: 'dir/b.json', type: 'string' }, y: { $ref: 'b.json' } } }, 'inputSchema');
  assert.deepEqual(wrong.map((f) => [f.path, f.kind]), [['y', 'missing']]);
});

test('unresolvedRefs: two spellings of one URI are one resource', () => {
  const schema = { $id: 'https://X.test/schemas/root.json', type: 'object', properties: { a: { $ref: 'https://x.test/schemas/./sub/../root.json#/$defs/A' } }, $defs: { A: { type: 'string' } } };
  assert.deepEqual(unresolvedRefs(schema, 'inputSchema'), []);
});

test('unresolvedRefs: a draft-06/07 $id with a name ("other.json#node") names the resource and the node', () => {
  const schema = { type: 'object', properties: { a: { $ref: 'other.json#node' }, b: { $ref: 'other.json' } }, definitions: { N: { $id: 'other.json#node', type: 'string' } } };
  assert.deepEqual(unresolvedRefs(schema, 'inputSchema'), []);
});

test('breakdown: a ref into an entry through a list the walk does not enter still marks the entry used', () => {
  const tool = (schema) => ({ name: 't', description: 'T.', inputSchema: schema });
  const menu = buildMenu([tool({ type: 'object', properties: { a: { $ref: '#/$defs/A/examples/0' } }, $defs: { A: { type: 'object', examples: [{ type: 'string' }] } } })], {});
  assert.equal(breakdown(menu).unusedDefs.tokens, 0);
});
