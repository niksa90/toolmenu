// Server-minted handles (2026-07-28, SEP-2567), end to end: a fixture server, the
// CLI, and what a model gets back for a handle that doesn't exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, menuOf, run, tool } from './helpers.mjs';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { autoScenario } from '../dist/auto.js';

const server = join(FIXTURES, 'handle-server.mjs');
const json = async (args) => JSON.parse((await run([...args, '--', process.execPath, server])).stdout);

test('ids/handle-lifetime: only the creation tool whose handle comes back and whose lifetime goes unsaid', async () => {
  const out = await json(['snapshot', '--no-write', '--json']);
  const found = out.findings.filter((f) => f.rule === 'ids/handle-lifetime');
  // create_cart says carts expire; open_basket's output schema says how long; create_draft
  // makes a record, not a handle; acquire_lock's lock is never taken back.
  assert.deepEqual(found.map((f) => f.tool), ['start_session']);
  const [f] = found;
  assert.equal(f.severity, 'info');
  assert.equal(f.confidence, 'unsure');
  assert.match(f.message, /^start_session creates a session that session_status\.session_id takes back, but its description doesn't say how long the session lasts\. 2026-07-28 asks for a handle's retention/);
  assert.match(f.fix, /sessions expire after 30 minutes of inactivity/);
});

test('ids/handle-lifetime: a 2025 server gets no finding', async () => {
  const out = await json(['snapshot', '--no-write', '--json', '--env', 'LEGACY=1']);
  assert.ok(out.server.protocolVersion < '2026-07-28');
  assert.equal(out.findings.filter((f) => f.rule === 'ids/handle-lifetime').length, 0);
});

test('ids/handle-lifetime: what counts as saying how long, and what counts as a handle', () => {
  const lint = (tools) => runRules(MENU_RULES, { menu: menuOf(tools), pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2026-07-28', era: 'modern' }).filter((f) => f.rule === 'ids/handle-lifetime').map((f) => f.tool);
  const taker = (param) => tool('use_it', [param]);
  for (const said of ['Sessions expire after an hour.', 'A session lasts until you close it.', 'Valid for 15 min.', 'Idle sessions are deleted after a day.', 'Sessions never expire.', 'TTL: 3600 seconds.']) {
    assert.deepEqual(lint([tool('start_session', [], { description: `Starts a session. ${said}` }), taker('session_id')]), [], said);
  }
  // Every way a tool can take the handle back.
  for (const param of ['session_id', 'sessionId', 'session', 'session_token', 'sessionHandle']) {
    assert.deepEqual(lint([tool('start_session', [], { description: 'Starts a session.' }), taker(param)]), ['start_session'], param);
  }
  // Not a handle kind, not a creation verb, or nothing takes it back: quiet.
  assert.deepEqual(lint([tool('create_run', [], { description: 'Starts a CI run.' }), taker('run_id')]), []);
  assert.deepEqual(lint([tool('get_session', [], { description: 'Gets a session.' }), taker('session_id')]), []);
  assert.deepEqual(lint([tool('start_session', [], { description: 'Starts a session.' }), tool('other', ['user_id'])]), []);
  // A creation verb in other spellings: open-cart, beginCheckout.
  assert.deepEqual(lint([tool('open-cart', [], { description: 'Opens a cart.' }), taker('cart_id')]), ['open-cart']);
  assert.deepEqual(lint([tool('beginCheckout', [], { description: 'Begins checkout.' }), taker('checkout_id')]), ['beginCheckout']);
});

test('session/handle-error: a made-up handle answered with a protocol error is the finding; a tool error or an answer is not', async () => {
  const out = await json(['session', '--auto', '--json']);
  const step = (tool) => out.steps.find((s) => s.label.startsWith(`call ${tool} `));
  // Each read-only tool that takes a handle some tool creates is called once with one that can't exist.
  assert.deepEqual(step('session_status').label, 'call session_status {"session_id":"toolmenu-unknown-session"}');
  assert.match(step('session_status').note, /^called with a made-up session; it answered with a protocol error \(-32602\): Unknown session: toolmenu-unknown-session$/);
  assert.match(step('cart_contents').note, /^called with a made-up cart; it answered with a tool error: Cart toolmenu-unknown-cart not found or expired/);
  assert.equal(step('basket_total').note, 'called with a made-up basket; it answered as if that basket existed');
  // send_draft takes a draft, but isn't read-only: never called.
  assert.equal(step('send_draft'), undefined);

  const found = out.findings.filter((f) => f.rule === 'session/handle-error');
  assert.equal(found.length, 1, 'one finding per tool, though the first call is repeated at the end');
  const [f] = found;
  assert.equal(f.tool, 'session_status');
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /answers a session that doesn't exist with a protocol error \(-32602: “Unknown session: toolmenu-unknown-session”\), not a tool error\./);
  assert.match(f.message, /toolmenu passed session_id: "toolmenu-unknown-session", which no session has\./);
  assert.match(f.fix, /isError: true/);
  // A handle's error is not a failed step, a tool error, or the server ending toolmenu's session.
  for (const rule of ['session/step-failed', 'session/tool-error', 'session/session-lost']) {
    assert.equal(out.findings.filter((x) => x.rule === rule).length, 0, rule);
  }
});

test('session/handle-error: a 2025 server is not probed: its handles stay skipped for values', async () => {
  const out = await json(['session', '--auto', '--json', '--env', 'LEGACY=1']);
  assert.ok(!out.steps.some((s) => /toolmenu-unknown/.test(s.label)));
  assert.equal(out.findings.filter((f) => f.rule === 'session/handle-error').length, 0);
});

test('autoScenario: a handle probe only for a read-only tool whose one missing value is a handle the menu creates', () => {
  const menu = (tools) => ({ ...menuOf(tools), server: { name: 's', protocolVersion: '2026-07-28', era: 'modern' } });
  const ro = { annotations: { readOnlyHint: true } };
  const start = tool('start_session', []);
  const calls = (tools) => autoScenario(menu(tools)).scenario.steps.filter((s) => s.kind === 'call').map((s) => [s.tool, s.args, s.probe?.kind]);
  assert.deepEqual(calls([start, tool('status', ['session_id'], ro)]).slice(0, 1), [['status', { session_id: 'toolmenu-unknown-session' }, 'session']]);
  // A uuid handle gets a nil-version UUID; a pattern is never guessed.
  const uuid = tool('status', [], { ...ro, inputSchema: { type: 'object', properties: { session_id: { type: 'string', format: 'uuid' } }, required: ['session_id'] } });
  assert.deepEqual(calls([start, uuid])[0][1], { session_id: '00000000-0000-4000-8000-000000000000' });
  const patterned = tool('status', [], { ...ro, inputSchema: { type: 'object', properties: { session_id: { type: 'string', pattern: '^s-' } }, required: ['session_id'] } });
  assert.deepEqual(calls([start, patterned]), []);
  // No tool creates sessions; another value is missing too; or a 2025 menu: no probe.
  assert.deepEqual(calls([tool('status', ['session_id'], ro)]), []);
  assert.deepEqual(calls([start, tool('status', ['session_id', 'query_text'], ro)]), []);
  assert.deepEqual(autoScenario({ ...menuOf([start, tool('status', ['session_id'], ro)]), server: { protocolVersion: '2025-11-25' } }).scenario.steps.filter((s) => s.kind === 'call'), []);
});
