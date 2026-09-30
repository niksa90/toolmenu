import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSnapshot, formatSession } from '../dist/report.js';
import { menuOf, tool } from './helpers.mjs';

const menu = menuOf([tool('get_form', ['form_id'])]);
const sure = { rule: 'menu/process-variance', severity: 'error', message: 'A second server process served a different menu.', detail: ['get_form: inputSchema.properties.fields.default: "a,b" vs "b,a"'], fix: 'Sort the values the default is built from.' };
const unsure = { rule: 'ids/authored', severity: 'info', message: 'get_form needs a form_id, and no tool appears to return one.', confidence: 'unsure' };

test('messages: the next step and an unsure marker in text, markdown, github and json', () => {
  const text = formatSnapshot(menu, [sure, unsure], 'text');
  assert.match(text, /→ Next: Sort the values the default is built from\./);
  assert.match(text, /ids\/authored · unsure/);
  assert.doesNotMatch(text, /process-variance · unsure/);

  const md = formatSnapshot(menu, [sure, unsure], 'markdown');
  assert.match(md, /<br>\*\*→ Next:\*\* Sort the values/);
  assert.match(md, /`ids\/authored` · _unsure_/);

  const gh = formatSnapshot(menu, [sure, unsure], 'github');
  assert.match(gh, /::error title=toolmenu menu\/process-variance::.*%0A→ Next: Sort the values/);
  assert.match(gh, /::notice title=toolmenu ids\/authored · unsure::/);

  const json = JSON.parse(formatSnapshot(menu, [sure, unsure], 'json'));
  const [a, b] = json.findings;
  assert.equal(a.fix, 'Sort the values the default is built from.');
  assert.equal(b.confidence, 'unsure');
});

test('messages: a session finding that names its steps is not prefixed with a step again', () => {
  const s = {
    scenario: 'auto', server: { name: 's', version: '1', protocolVersion: '2026-07-28' }, transport: 'stdio', listening: true,
    baseline: { tools: 1, tokens: 10 }, final: { tools: 1, tokens: 10 }, connectionCheck: 'same', union: menu,
    steps: [{ index: 1, label: 'list', status: 'ok', changed: false }, { index: 2, label: 'call a', status: 'ok', changed: true, listChanged: 1 }],
    findings: [
      { rule: 'session/side-effect', severity: 'warn', step: 2, message: 'Steps 2, 4: A freshly started server doesn\'t show this change.' },
      { rule: 'session/edit', severity: 'error', step: 2, message: 'get_form: description changed mid-session.' },
    ],
  };
  const md = formatSession(s, 'markdown');
  assert.doesNotMatch(md, /Step 2: Steps 2/);
  assert.match(md, /Step 2: get_form: description changed/);
  const gh = formatSession(s, 'github');
  assert.doesNotMatch(gh, /step 2 \(call a\): Steps 2/);
  assert.match(gh, /step 2 \(call a\): get_form/);
});
