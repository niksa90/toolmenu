// session/output-schema and --call-everything, on test/fixtures/output-server.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invent, synthesizeArgs, INVENTED } from '../dist/args.js';
import { autoScenario } from '../dist/auto.js';
import { outputCheck, outputProblem } from '../dist/rules/output.js';
import { FIXTURES, menuOf, run, tempDir } from './helpers.mjs';

const SERVER = ['--', process.execPath, join(FIXTURES, 'output-server.mjs')];

test('invent: the schema\'s own value first, then a made-up one of the right type', () => {
  assert.equal(invent({ type: 'string', enum: ['a', 'b'] }), 'a');
  assert.equal(invent({ type: 'string', pattern: '^rec_[0-9]+$' }), INVENTED);
  assert.equal(invent({ type: 'integer' }), 1);
  assert.deepEqual(invent({ type: 'array', items: { type: 'string' } }), [INVENTED]);
  assert.deepEqual(invent({ type: 'object', properties: { id: { type: 'string' }, n: { type: 'number' } }, required: ['id'] }), { id: INVENTED });
  assert.deepEqual(synthesizeArgs({ type: 'object', properties: { record_id: { type: 'string' } }, required: ['record_id'] }), { ok: false, missing: ['record_id'] });
  assert.deepEqual(synthesizeArgs({ type: 'object', properties: { record_id: { type: 'string' } }, required: ['record_id'] }, {}, { invent: true }).args, { record_id: INVENTED });
});

test('autoScenario with everything: every tool, writes included, and the scenario allows writes', () => {
  const tools = [
    { name: 'read_x', description: 'Read.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'delete_x', description: 'Delete.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { destructiveHint: true } },
    { name: 'unmarked', description: 'Something.', inputSchema: { type: 'object' } },
  ];
  const plain = autoScenario(menuOf(tools));
  assert.deepEqual(plain.called, ['read_x']);
  const all = autoScenario(menuOf(tools), { everything: true });
  assert.deepEqual([...all.called].sort(), ['delete_x', 'read_x', 'unmarked']);
  assert.deepEqual(all.skipped, []);
  assert.equal(all.scenario.allowWrites, true);
});

test('outputProblem: no structuredContent, or one that breaks the schema; a conforming one is fine', () => {
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
  assert.equal(outputProblem(schema, { structuredContent: { n: 1 } }), undefined);
  assert.match(outputProblem(schema, { structuredContent: { n: 'one' } }), /\/n must be number/);
  assert.match(outputProblem(schema, {}), /no structuredContent/);
});

test('session/output-schema on a real session; --call-everything reaches the write and the tool needing an ID', async () => {
  const plain = await run(['session', '--auto', '--format', 'json', '--processes', '1', ...SERVER]);
  const r = JSON.parse(plain.stdout);
  const f = r.findings.find((x) => x.rule === 'session/output-schema');
  assert.ok(f, plain.stdout);
  assert.deepEqual(f.detail.map((d) => d.split(' ')[0]), ['bad_shape', 'no_structured']);
  assert.ok(!r.auto.called.includes('delete_all'));

  const log = join(tempDir(), 'calls.log');
  const all = await run(['session', '--auto', '--call-everything', '--format', 'json', '--processes', '1', '--env', `CALL_LOG=${log}`, ...SERVER]);
  const e = JSON.parse(all.stdout);
  assert.deepEqual([...e.auto.called].sort(), ['bad_shape', 'delete_all', 'get_record', 'good_shape', 'no_structured']);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.find((c) => c.name === 'get_record').arguments, { record_id: INVENTED });
  // Its "Record not found" is the right answer to a made-up ID: info, not a warning.
  const refused = e.findings.find((x) => x.rule === 'session/tool-error');
  assert.equal(refused.severity, 'info');
  assert.match(refused.message, /answered the made-up values with a tool error the model can read/);
});

test('--call-everything is refused over HTTP: a hosted server\'s tools act on real accounts', async () => {
  const r = await run(['session', '--auto', '--call-everything', 'https://example.com/mcp']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only runs a local stdio server/);
});

test('--call-everything: a failed call or an untested run is info, not an error (made-up values, no network)', async () => {
  const { session, parseScenario } = await import('../dist/session.js');
  const r = await session(
    { kind: 'stdio', command: process.execPath, args: [join(FIXTURES, 'output-server.mjs')] },
    parseScenario({ allow_writes: true, steps: ['list', { call: 'no_such_tool' }] }),
    { timeoutMs: 30000, processes: 1, auto: { called: [], skipped: [], everything: true } },
  );
  for (const f of r.findings.filter((x) => x.rule === 'session/step-failed' || x.rule === 'session/untested')) assert.equal(f.severity, 'info', f.message);
});

test('outputCheck: a result failing only format checks is marked formatOnly (many validators skip format)', () => {
  const schema = { type: 'object', properties: { url: { type: 'string', format: 'uri' }, n: { type: 'number' } }, required: ['url'] };
  assert.equal(outputCheck(schema, { structuredContent: { url: 'not a uri' } }).formatOnly, true);
  assert.equal(outputCheck(schema, { structuredContent: { url: 'not a uri', n: 'x' } }).formatOnly, false);
});
