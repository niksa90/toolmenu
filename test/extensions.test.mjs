// MCP extensions (SEP-2133) and MCP Apps (ext-apps) in diff, and the identifiers a server declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffMenus } from '../dist/diff.js';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { menuOf, tool } from './helpers.mjs';

const ui = (resourceUri, extra = {}) => ({ _meta: { ui: { ...(resourceUri ? { resourceUri } : {}), ...extra } } });
const rules = (d, prefix) => d.findings.filter((f) => f.rule.startsWith(prefix));

test('diff/apps-visibility: a tool that loses "model" is gone for the agent (breaking); one that gains it is new to the agent', () => {
  const before = menuOf([tool('show_chart', [], ui('ui://a/chart')), tool('refresh', [], ui('ui://a/chart', { visibility: ['app'] }))]);
  const after = menuOf([tool('show_chart', [], ui('ui://a/chart', { visibility: ['app'] })), tool('refresh', [], ui('ui://a/chart', { visibility: ['model', 'app'] }))]);
  const d = diffMenus(before, after);
  const [gone] = rules(d, 'diff/apps-visibility');
  assert.equal(gone.tool, 'show_chart');
  assert.equal(gone.severity, 'error');
  assert.equal(gone.class, 'breaking');
  assert.equal(gone.message, '`show_chart` is no longer shown to the agent (MCP Apps visibility ["model","app"] → ["app"]). An Apps host leaves it out of the agent\'s tool list, so agents, saved prompts and evals that call it now fail there.');
  assert.match(gone.fix, /^Keep "model" in `show_chart`'s visibility for one release, or /);
  const [seen] = rules(d, 'diff/apps-visible');
  assert.equal(seen.tool, 'refresh');
  assert.equal(seen.class, 'minor');
  assert.equal(d.suggestedBump, 'major');
  // _meta.ui is said by these rules, not again as an unclassified field.
  assert.equal(rules(d, 'diff/other').length, 0);
});

test('diff/apps-ui: a UI added, moved or removed is a notice; the rest of _meta still compares as before', () => {
  const before = menuOf([tool('a', [], ui('ui://s/a')), tool('b', []), tool('c', [], { _meta: { 'ui/resourceUri': 'ui://s/c', 'com.example/tag': 1 } })]);
  const after = menuOf([tool('a', [], ui('ui://s/a2')), tool('b', [], ui('ui://s/b')), tool('c', [], { _meta: { 'com.example/tag': 2 } })]);
  const d = diffMenus(before, after);
  const msgs = rules(d, 'diff/apps-ui').map((f) => f.message).sort();
  assert.deepEqual(msgs, [
    "`a` names another UI (ui://s/a → ui://s/a2). What an MCP Apps host renders for it changes; calls don't.",
    "`b` now names a UI (ui://s/b). What an MCP Apps host renders for it changes; calls don't.",
    "`c` no longer names a UI (was ui://s/c). What an MCP Apps host renders for it changes; calls don't.",
  ]);
  assert.ok(rules(d, 'diff/apps-ui').every((f) => f.class === 'notice'));
  const [other] = rules(d, 'diff/other');
  assert.equal(other.tool, 'c');
  assert.match(other.message, /_meta \{"com\.example\/tag":1\} → \{"com\.example\/tag":2\} changed/);
  assert.equal(d.suggestedBump, 'patch');
});

test('diff/extension-*: removed warns (breaking), added is minor, settings a notice; older menu files are not compared', () => {
  const m = (extensions) => menuOf([tool('a', [])], extensions === undefined ? {} : { extensions });
  const d = diffMenus(m({ 'io.modelcontextprotocol/ui': {}, 'com.example/x': { v: 1 } }), m({ 'com.example/x': { v: 2 }, 'io.modelcontextprotocol/tasks': {} }));
  const by = Object.fromEntries(rules(d, 'diff/extension').map((f) => [f.rule, f]));
  assert.equal(by['diff/extension-removed'].severity, 'warn');
  assert.equal(by['diff/extension-removed'].class, 'breaking');
  assert.equal(by['diff/extension-removed'].message, 'The server no longer declares the `io.modelcontextprotocol/ui` extension. Clients stop using what it adds (MCP Apps: the UI of tools that name one); core requests go on working.');
  assert.match(by['diff/extension-removed'].fix, /declare `io\.modelcontextprotocol\/ui` again/);
  assert.equal(by['diff/extension-added'].message, 'The server now declares the `io.modelcontextprotocol/tasks` extension.');
  assert.equal(by['diff/extension-settings'].message, 'The `com.example/x` extension\'s settings changed ({"v":1} → {"v":2}).');
  // A menu file from before 0.23 has no extensions field: unknown, not "all added".
  assert.equal(rules(diffMenus(m(undefined), m({ 'io.modelcontextprotocol/ui': {} })), 'diff/extension').length, 0);
  assert.equal(rules(diffMenus(m({}), m({})), 'diff/extension').length, 0);
});

test('spec/extension-id: identifiers need a vendor prefix and a settings object; good ones are quiet', () => {
  const lint = (extensions) =>
    runRules(MENU_RULES, { menu: menuOf([tool('a', [])]), pages: [], capabilities: { tools: {}, extensions }, usedAuth: false, protocolVersion: '2026-07-28', era: 'modern' }).filter((f) => f.rule === 'spec/extension-id');
  assert.deepEqual(lint({ 'io.modelcontextprotocol/ui': {}, 'io.modelcontextprotocol/tasks': {}, 'com.example-co/my_feature.v2': { on: true } }), []);
  assert.deepEqual(lint(undefined), []);
  const [one] = lint({ ui: {} });
  assert.equal(one.severity, 'warn');
  assert.equal(one.message, 'An extension the server declares is not identified as the spec says, so a client that looks it up by identifier finds it not declared: "ui": no vendor prefix (the spec makes one mandatory: io.modelcontextprotocol/ui, com.example/feature).');
  assert.match(one.fix, /io\.modelcontextprotocol\/ui for MCP Apps/);
  const [two] = lint({ '1bad/x': {}, 'com.example/ok': true });
  assert.match(two.message, /^2 extensions the server declares are not identified/);
  assert.deepEqual(two.detail, ['"1bad/x": not in vendor-prefix/name form (labels start with a letter; the name starts and ends alphanumeric)', '"com.example/ok": its settings are true, not an object ({} for none)']);
  const [list] = lint(['io.modelcontextprotocol/ui']);
  assert.match(list.message, /^capabilities\.extensions is a list, not an object/);
});
