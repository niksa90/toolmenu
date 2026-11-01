// Multi round-trip requests (2026-07-28), end to end: a fixture server whose tools
// ask for input in every way that matters, the CLI's session --auto, and toolmenu's
// own connection checked against what the server received.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, run } from './helpers.mjs';
import { connect } from '../dist/connect.js';
import { callWithInput } from '../dist/mrtr.js';
import { classifyFailure } from '../dist/failures.js';

const server = join(FIXTURES, 'mrtr-server.mjs');
const stdio = (extra = {}) => ({ kind: 'stdio', command: process.execPath, args: [server], ...extra });
const textOf = (result) => result.content.map((c) => c.text).join(' ');

async function autoRun(extra = []) {
  const r = await run(['session', '--auto', '--json', ...extra, '--', process.execPath, server]);
  const out = JSON.parse(r.stdout);
  const step = (tool) => out.steps.find((s) => s.label === `call ${tool}`);
  const findings = (rule) => out.findings.filter((f) => f.rule === rule);
  return { out, step, findings };
}

test('session --auto on 2026-07-28: every request is declined, and what each tool did with it is its own finding', async () => {
  const { out, step, findings } = await autoRun();
  assert.equal(out.server.protocolVersion, '2026-07-28');

  // Tools that take the decline and answer: no warning, a note on the step.
  for (const [tool, note] of [
    ['ask_confirm', 'asked for a form; declined once, then answered'],
    ['ask_url', 'asked for a URL to open; declined once, then answered'],
    ['ask_twice', 'asked for a form; declined twice, then answered'],
    ['ask_with_state', 'asked for a form; declined once, then answered'],
  ]) {
    assert.equal(step(tool).outcome, 'answered', tool);
    assert.equal(step(tool).note, note, tool);
  }
  // A tool error answering a decline is how a tool should say no: no tool-error finding.
  assert.equal(step('ask_then_error').outcome, 'tool-error');
  assert.equal(step('ask_then_error').note, 'asked for a form; declined once, then answered, with a tool error: Not done: the user declined.');
  assert.ok(!out.findings.some((f) => f.rule === 'session/tool-error'), 'no tool-error finding for a declined request');

  const [info] = findings('session/input-required');
  assert.equal(info.severity, 'info');
  assert.match(info.message, /^8 tools asked for input mid-call \(input_required, 2026-07-28\)\. toolmenu declined every request, the same way every run, and called again: 5 of 8 then answered/);
  assert.equal(info.detail.length, 8);

  const [loop] = findings('session/input-loop');
  assert.equal(loop.tool, 'ask_forever');
  assert.equal(loop.severity, 'warn');
  assert.match(loop.message, /asks the same thing again after a decline, every time.*toolmenu stopped after 3 rounds/);
  assert.match(loop.fix, /Treat a decline as an answer: return a result that says the user declined/);
  assert.equal(step('ask_forever').outcome, 'needs-input');

  const [declineFails] = findings('session/decline-fails');
  assert.equal(declineFails.tool, 'ask_then_refuse');
  assert.match(declineFails.message, /fails with a protocol error when the user declines its request \(“Invalid or expired requestState”\)/);

  const [undeclared] = findings('session/undeclared-input');
  assert.equal(undeclared.tool, 'ask_roots_anyway');
  assert.match(undeclared.message, /asked for roots, which the request didn't declare.*MissingRequiredClientCapabilityError \(-32021\).*deprecates roots and sampling/);
  assert.match(undeclared.fix, /For roots, take the directory as a tool parameter instead\./);

  const [resultType] = findings('session/result-type');
  assert.equal(resultType.tool, 'no_result_type');
  assert.equal(resultType.severity, 'error');
  assert.match(resultType.message, /the official SDK client rejects a result without it/);
  assert.equal(step('no_result_type').outcome, 'answered');

  // An SDK server that refuses to ask for what wasn't declared answers -32021: a setup gap, not the server's fault.
  assert.match(step('ask_roots').note, /\(needs the client to support roots\)$/);
  assert.equal(step('ask_roots').failure, 'client');
  assert.ok(!out.findings.some((f) => f.rule === 'session/step-failed'), 'nothing here is a failed step');

  // A tool that asks for nothing is untouched.
  assert.equal(step('plain_tool').outcome, 'answered');
  assert.equal(step('plain_tool').note, undefined);
});

test('--elicitation cancel: every request is cancelled instead, and the findings say so', async () => {
  const { step, findings } = await autoRun(['--elicitation', 'cancel']);
  assert.equal(step('ask_confirm').note, 'asked for a form; cancelled once, then answered');
  assert.match(findings('session/input-required')[0].message, /toolmenu cancelled every request/);
  assert.match(findings('session/input-loop')[0].message, /after a cancel/);
  assert.match(findings('session/input-loop')[0].fix, /says the user dismissed it/);
});

test('the server gets the decline (or cancel) and its requestState back byte for byte', async () => {
  for (const answer of ['decline', 'cancel']) {
    const conn = await connect(stdio(answer === 'cancel' ? { elicitation: 'cancel' } : {}));
    try {
      assert.equal(conn.era, 'modern');
      const confirm = await callWithInput(conn, { name: 'ask_confirm', arguments: {} }, { elicitation: answer });
      assert.equal(textOf(confirm.result), `stopped: the user chose ${answer}`);
      assert.deepEqual(confirm.input, { rounds: 1, kinds: ['form'], outcome: 'completed' });
      const state = await callWithInput(conn, { name: 'ask_with_state', arguments: {} }, { elicitation: answer });
      assert.equal(textOf(state.result), 'state came back intact');
    } finally {
      await conn.close();
    }
  }
});

test('on a 2025 server the old elicitation/create request gets the same decline, and no 2026 finding is made', async () => {
  const r = await run(['session', '--auto', '--json', '--env', 'LEGACY=1', '--', process.execPath, server]);
  const out = JSON.parse(r.stdout);
  assert.ok(out.server.protocolVersion < '2026-07-28');
  assert.equal(out.steps.find((s) => s.label === 'call ask_confirm').outcome, 'answered');
  assert.ok(!out.findings.some((f) => /^session\/(input-|decline-|undeclared-|result-type)/.test(f.rule)));
  const conn = await connect(stdio({ env: { LEGACY: '1' } }));
  try {
    const { result } = await callWithInput(conn, { name: 'ask_confirm', arguments: {} }, {});
    assert.equal(textOf(result), 'stopped: the user chose decline');
  } finally {
    await conn.close();
  }
});

test('-32021 is a setup failure by its code; --elicitation is checked', async () => {
  assert.equal(classifyFailure('Missing required client capability', { code: -32021 }), 'client');
  const bad = await run(['session', '--auto', '--elicitation', 'accept', '--', process.execPath, server]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--elicitation must be decline or cancel/);
  const elsewhere = await run(['snapshot', '--elicitation', 'cancel', '--', process.execPath, server]);
  assert.match(elsewhere.stderr, /--elicitation goes with session: only session calls tools\./);
});
