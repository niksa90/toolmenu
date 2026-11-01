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
