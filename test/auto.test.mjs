import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthesize, synthesizeArgs } from '../dist/args.js';
import { autoScenario } from '../dist/auto.js';
import { FIXTURES, menuOf, run, tempDir, tool } from './helpers.mjs';

test('synthesize: only values the schema vouches for', () => {
  const v = (schema, name) => synthesize(schema, name);
  assert.deepEqual(v({ type: 'string', const: 'x' }), { ok: true, value: 'x' });
  assert.deepEqual(v({ type: 'string', default: 'css' }), { ok: true, value: 'css' });
  assert.deepEqual(v({ type: 'string', examples: ['ex'] }), { ok: true, value: 'ex' });
  assert.deepEqual(v({ type: 'string', enum: ['a', 'b'] }), { ok: true, value: 'a' });
  assert.deepEqual(v({ type: 'integer', minimum: 5 }), { ok: true, value: 5 });
  assert.deepEqual(v({ type: 'boolean' }), { ok: true, value: false });
  assert.deepEqual(v({ type: 'string', format: 'date-time' }), { ok: true, value: '2026-01-01T00:00:00Z' });
  assert.deepEqual(v({ type: 'string' }, 'query'), { ok: true, value: 'test' });
  assert.deepEqual(v({ type: ['string', 'null'] }, 'q'), { ok: true, value: 'test' });
  assert.deepEqual(v({ anyOf: [{ type: 'string', pattern: '^x' }, { type: 'integer' }] }), { ok: true, value: 1 });
  // Never an ID, a pattern, or a free-text field it can't name.
  assert.equal(v({ type: 'string' }, 'owner').ok, false);
  assert.equal(v({ type: 'string', pattern: '^[a-f0-9]+$' }, 'query').ok, false);
  assert.equal(v({ type: 'array', items: { type: 'string' }, minItems: 1 }, 'ids').ok, false);
  assert.deepEqual(v({ type: 'array', items: { type: 'string' } }, 'labels'), { ok: true, value: [] });
  assert.deepEqual(synthesizeArgs({ type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] }), { ok: false, missing: ['owner', 'repo'] });
});

test('autoScenario: read-only tools only, open world opt-in, cheapest first, a repeat at the end', () => {
  const closed = { readOnlyHint: true, openWorldHint: false };
  const menu = menuOf([
    tool('delete_repo', [], { annotations: { destructiveHint: true } }),
    tool('get_issue', ['issue_key'], { annotations: closed }),
    tool('search_code', [], { annotations: closed, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }),
    tool('get_me', [], { annotations: closed }),
    tool('list_mine', [], { annotations: { readOnlyHint: true } }),
    tool('web_fetch', [], { annotations: { readOnlyHint: true, openWorldHint: true }, inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } }),
  ]);
  const plan = autoScenario(menu);
  // Unmarked (list_mine) is called; marked openWorldHint: true (web_fetch) is opt-in.
  assert.deepEqual(plan.called, ['get_me', 'list_mine', 'search_code']);
  assert.deepEqual(plan.scenario.steps.map((s) => (s.kind === 'call' ? s.tool : s.kind)), ['list', 'get_me', 'list_mine', 'search_code', 'get_me']);
  assert.equal(plan.scenario.allowWrites, false);
  const why = Object.fromEntries(plan.skipped.map((s) => [s.tool, s.reason]));
  assert.deepEqual(why, { delete_repo: 'not read-only', get_issue: 'needs values', web_fetch: 'open world' });
  assert.deepEqual(autoScenario(menu, { openWorld: true }).called, ['get_me', 'list_mine', 'search_code', 'web_fetch']);
  assert.deepEqual(autoScenario(menu, { maxCalls: 1 }).called, ['get_me']);
});

test('cli: session --auto runs, reports what it skipped, and saves its steps', async () => {
  const cwd = tempDir();
  const server = ['--', process.execPath, join(FIXTURES, 'session-server.mjs')];
  const r = await run(['session', '--auto', '--open-world', '--save-scenario', 'auto.yml', ...server], { cwd });
  assert.ok([0, 1].includes(r.code), r.stderr);
  assert.match(r.stdout, /toolmenu session {2}auto/);
  assert.match(r.stdout, /auto: called \d+ tools?/);
  assert.ok(existsSync(join(cwd, 'auto.yml')));
  assert.match(readFileSync(join(cwd, 'auto.yml'), 'utf8'), /^allow_writes: false$/m);
  const again = await run(['session', '--auto', '--save-scenario', 'auto.yml', ...server], { cwd });
  assert.equal(again.code, 2);
  const both = await run(['session', '--auto', '--scenario', 'x.yml', ...server], { cwd });
  assert.equal(both.code, 2);
});
