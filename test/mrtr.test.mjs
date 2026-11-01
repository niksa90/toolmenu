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
import { writeFileSync } from 'node:fs';
import { tempDir } from './helpers.mjs';

/** A scenario file that calls the given tools once each. */
function scenarioFile(tools) {
  const file = join(tempDir(), 'scenario.yml');
  writeFileSync(file, ['allow_writes: false', 'steps:', ...tools.map((t) => `  - call: ${t}`)].join('\n') + '\n');
  return file;
}

const server = join(FIXTURES, 'mrtr-server.mjs');
// A session's target: it declares elicitation and says how to answer (snapshot's targets don't).
const stdio = (extra = {}) => ({ kind: 'stdio', command: process.execPath, args: [server], elicitation: 'decline', ...extra });
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
  assert.match(info.message, /^10 tools asked for input mid-call \(input_required, 2026-07-28\)\. toolmenu declined every request, the same way every run, and called again: 6 of 10 then answered/);
  assert.equal(info.detail.length, 10);

  const loops = Object.fromEntries(findings('session/input-loop').map((f) => [f.tool, f]));
  assert.deepEqual(Object.keys(loops).sort(), ['ask_forever', 'ask_forever_reworded', 'work_forever']);
  // The same question under a new key and new wording each time is still the same question.
  assert.match(loops.ask_forever_reworded.message, /asks the same thing again after a decline, every time/);
  // requestState-only rounds: asking for nothing, never finishing.
  assert.match(loops.work_forever.message, /^work_forever kept answering input_required with only its requestState, asking for nothing more, and never returned a result \(toolmenu stopped after 10 rounds/);
  assert.match(loops.work_forever.fix, /Return a result once the work is done/);
  assert.equal(step('work_forever').note, 'asked for nothing, but kept answering input_required with only its requestState (10 rounds), never a result');
  // requestState-only rounds that end in a result are just work: no note, no finding.
  assert.equal(step('keep_working').outcome, 'answered');
  assert.equal(step('keep_working').note, undefined);
  // A tool error answering a decline is the tool's answer, whatever its words: not a credentials problem.
  assert.equal(step('ask_then_auth_error').failure, undefined);
  assert.ok(!findings('session/untested').some((f) => /authentication/.test(f.message)));

  const loop = loops.ask_forever;
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
  const loop = findings('session/input-loop').find((f) => f.tool === 'ask_forever');
  assert.match(loop.message, /after a cancel/);
  assert.match(loop.fix, /says the user dismissed it/);
});

test('the server gets the decline (or cancel) and its requestState back byte for byte', async () => {
  for (const answer of ['decline', 'cancel']) {
    const conn = await connect(stdio({ elicitation: answer }));
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

test('a target without elicitation declares nothing: snapshot sees the menu a client that can\'t be asked sees', async () => {
  const conn = await connect({ kind: 'stdio', command: process.execPath, args: [server] });
  try {
    // The SDK server refuses to ask a client that didn't declare elicitation.
    await assert.rejects(conn.client.callTool({ name: 'ask_confirm', arguments: {} }), /client capabilities do not declare/);
  } finally {
    await conn.close();
  }
});

test('a retry that times out after a decline is a failed step, not the server refusing the decline', async () => {
  const r = await run(['session', '--json', '--timeout', '2000', '--scenario', scenarioFile(['ask_then_hang']), '--env', 'HANG=1', '--', process.execPath, server]);
  const out = JSON.parse(r.stdout);
  const step = out.steps.find((s) => s.label === 'call ask_then_hang');
  assert.equal(step.outcome, 'failed');
  assert.ok(!out.findings.some((f) => f.rule === 'session/decline-fails'), 'a timeout is not the server answering the decline');
});

test('callWithInput: edge cases a fake connection can produce', async () => {
  // A fake 2026 connection whose callTool plays back a script; each entry is what the SDK returns or throws,
  // and what the wire saw.
  const fake = (script) => {
    const wire = { responses: [], since: (mark) => wire.responses.slice(mark) };
    let i = 0;
    return {
      era: 'modern',
      wire,
      client: {
        callTool: async () => {
          const { wire: raw, wireError, returns, throws } = script[i++];
          if (raw !== undefined) wire.responses.push({ method: 'tools/call', result: raw });
          if (wireError !== undefined) wire.responses.push({ method: 'tools/call', error: wireError });
          if (throws) throw throws;
          return returns;
        },
      },
    };
  };
  const ask = { resultType: 'input_required', inputRequests: { c: { method: 'elicitation/create', params: { message: 'Go?', requestedSchema: { type: 'object' } } } } };
  const done = { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] };

  // A non-object result the SDK rejects: its error comes through, not a TypeError from toolmenu.
  const rejected = Object.assign(new Error('Invalid result for tools/call'), { code: -32602 });
  await assert.rejects(callWithInput(fake([{ wire: 'ok', throws: rejected }]), { name: 't', arguments: {} }, {}), /Invalid result for tools\/call/);

  // The SDK throwing after the fact on an input_required answer: the rounds go on from the wire.
  const after = await callWithInput(fake([{ wire: ask, throws: new Error('has an output schema but did not return structured content') }, { wire: done, returns: done }]), { name: 't', arguments: {} }, {});
  assert.equal(after.input.outcome, 'completed');

  // A retry failing with no JSON-RPC code (a timeout, a lost connection) is thrown back, not called a refused decline.
  const timeout = Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' });
  await assert.rejects(callWithInput(fake([{ wire: ask, returns: ask }, { throws: timeout }]), { name: 't', arguments: {} }, {}), /Request timed out/);

  // A refused retry keeps the server's words in JSON, first line only: message and code.
  const refused = Object.assign(new Error('MCP error -32602: Invalid or expired requestState'), { code: -32602 });
  const r = await callWithInput(fake([{ wire: ask, returns: ask }, { wireError: { code: -32602, message: 'Invalid or expired requestState\n  at verify (state.py:12)' }, throws: refused }]), { name: 't', arguments: {} }, {});
  assert.equal(r.input.outcome, 'decline-failed');
  assert.deepEqual(JSON.parse(JSON.stringify(r.input.error)), { message: 'Invalid or expired requestState', code: -32602 });

  // The SDK rejecting a complete result the server did send (an output-schema check) is not the decline refused.
  const local = Object.assign(new Error('Tool t has an output schema but did not return structured content'), { code: -32600 });
  await assert.rejects(callWithInput(fake([{ wire: ask, returns: ask }, { wire: done, throws: local }]), { name: 't', arguments: {} }, {}), /did not return structured content/);

  // A rate limit in JSON-RPC words goes back to session to be waited out.
  const limited = Object.assign(new Error('Rate limit exceeded, retry later'), { code: -32000 });
  await assert.rejects(callWithInput(fake([{ wire: ask, returns: ask }, { wireError: { code: -32000, message: 'Rate limit exceeded, retry later' }, throws: limited }]), { name: 't', arguments: {} }, {}), /Rate limit exceeded/);

  // After requestState-only rounds no decline was sent: a server error then is a failed call.
  const working = { resultType: 'input_required', requestState: 's' };
  const err = Object.assign(new Error('Invalid params'), { code: -32602 });
  await assert.rejects(callWithInput(fake([{ wire: working, returns: working }, { wireError: { code: -32602, message: 'Invalid params' }, throws: err }]), { name: 't', arguments: {} }, {}), /Invalid params/);

  // Different pages to open in turn are different questions: gave-up, not a loop.
  const url = (u) => ({ resultType: 'input_required', inputRequests: { c: { method: 'elicitation/create', params: { mode: 'url', message: 'Open', url: u } } } });
  const pages = await callWithInput(fake(['a', 'b', 'c', 'd'].map((u) => ({ wire: url(`https://x.test/${u}`), returns: url(`https://x.test/${u}`) }))), { name: 't', arguments: {} }, {});
  assert.equal(pages.input.outcome, 'gave-up');

  // Asked once, took the decline, then worked forever: unfinished, with what it asked.
  const forever = [{ wire: ask, returns: ask }, ...Array.from({ length: 11 }, () => ({ wire: working, returns: working }))];
  const unfinished = await callWithInput(fake(forever), { name: 't', arguments: {} }, {});
  assert.deepEqual([unfinished.input.outcome, unfinished.input.kinds, unfinished.input.continuations], ['unfinished', ['form'], 10]);
});

test('an unlock that never finishes its input rounds unlocked nothing: its values are not counted as reached', async () => {
  const file = join(tempDir(), 'unlock.yml');
  writeFileSync(file, 'allow_writes: false\nsteps:\n  - call: enable_toolset\n    args: { toolset: billing }\n');
  const r = await run(['session', '--json', '--union-out', join(tempDir(), 'union.json'), '--scenario', file, '--env', 'UNLOCK=1', '--', process.execPath, server]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.steps.find((s) => s.label.startsWith('call enable_toolset')).outcome, 'needs-input');
  const coverage = out.findings.find((f) => f.rule === 'session/unlock-coverage');
  assert.match(coverage.message, /got through 0 of its 2 toolset values/);
});

test('quietExclusions: overlapping runs share one filter and leave console.warn as it was', async () => {
  const { quietExclusions } = await import('../dist/connect.js');
  const original = console.warn;
  const seen = [];
  console.warn = (...a) => seen.push(a[0]);
  const mine = console.warn;
  try {
    let releaseA;
    const a = quietExclusions(() => new Promise((r) => (releaseA = r)));
    const b = quietExclusions(async () => {
      console.warn('[mcp-sdk] excluding tool x');
      console.warn('kept');
    });
    await b;
    releaseA();
    await a;
    assert.equal(console.warn, mine, 'restored to what it was before either run');
    assert.deepEqual(seen, ['kept']);
  } finally {
    console.warn = original;
  }
});

test('callWithInput: one step stops after 3 × the request timeout of requestState-only rounds', async () => {
  const working = { resultType: 'input_required', requestState: 's' };
  const wire = { responses: [], since: (mark) => wire.responses.slice(mark) };
  const conn = {
    era: 'modern',
    wire,
    client: { callTool: async () => { await new Promise((r) => setTimeout(r, 25)); wire.responses.push({ method: 'tools/call', result: working }); return working; } },
  };
  const r = await callWithInput(conn, { name: 't', arguments: {} }, { timeoutMs: 20 });
  assert.equal(r.input.outcome, 'unfinished');
  assert.ok(r.input.continuations < 10, `stopped on time (${r.input.continuations} rounds), not on the round cap`);
});
