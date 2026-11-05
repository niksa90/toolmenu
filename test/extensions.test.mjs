// MCP extensions (SEP-2133) and MCP Apps (ext-apps) in diff, and the identifiers a server declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffMenus } from '../dist/diff.js';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { menuOf, tool } from './helpers.mjs';
import { readAppResources, resourceUriOf } from '../dist/apps.js';
import { listingsDiffer } from '../dist/rules/capabilities.js';

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
  // A bad identifier and bad settings are two findings, each counting extensions.
  const [named, unset] = lint({ '1bad/x': {}, 'com.example/ok': true, ui: true });
  assert.match(named.message, /^2 extensions the server declares are not identified/);
  assert.deepEqual(named.detail, ['"1bad/x": not in vendor-prefix/name form (labels start with a letter; the name starts and ends alphanumeric)', '"ui": no vendor prefix (the spec makes one mandatory: io.modelcontextprotocol/ui, com.example/feature)']);
  assert.equal(unset.message, 'An extension the server declares has settings that aren\'t an object, which the 2026-07-28 schema requires (a settings object per extension, {} for none), so a client that reads its settings may reject or ignore it: "com.example/ok": its settings are true, not an object ({} for none).');
  assert.equal(unset.fix, 'Give each extension an object as its value: {} when it has no settings.');
  const [list] = lint(['io.modelcontextprotocol/ui']);
  assert.match(list.message, /^capabilities\.extensions is a list, not an object/);
});

test('spec/task-required: a 2025-11-25 tool that runs only as a task; on 2026-07-28 the field means nothing', () => {
  const tools = [tool('simulate_research', [], { execution: { taskSupport: 'required' } }), tool('quick', [], { execution: { taskSupport: 'optional' } }), tool('plain', [])];
  const lint = (era, protocolVersion) => runRules(MENU_RULES, { menu: menuOf(tools), pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion, era }).filter((f) => f.rule === 'spec/task-required');
  const [legacy] = lint('legacy', '2025-11-25');
  assert.equal(legacy.severity, 'info');
  assert.equal(legacy.tool, 'simulate_research');
  assert.equal(legacy.message, 'simulate_research runs only as a task (execution.taskSupport: "required"), so a client without Tasks support can\'t call it: the call is refused, not run. Most clients don\'t support Tasks yet.');
  assert.match(legacy.fix, /mark it "optional"/);
  const [modern] = lint('modern', '2026-07-28');
  assert.match(modern.message, /a 2025-11-25 field\. 2026-07-28 moved Tasks to the io\.modelcontextprotocol\/tasks extension/);
  assert.match(modern.fix, /^Drop execution from the tool definitions/);
  assert.deepEqual(runRules(MENU_RULES, { menu: menuOf([tools[1], tools[2]]), pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2025-11-25', era: 'legacy' }).filter((f) => f.rule === 'spec/task-required'), []);
});

test('diff: the rest of _meta.ui (csp, permissions) still compares; tokens count what the agent is shown', () => {
  const csp = (domains) => ui('ui://a/v', { csp: { connectDomains: domains } });
  const d = diffMenus(menuOf([tool('show', [], csp(['https://api.a.test']))]), menuOf([tool('show', [], csp(['https://api.a.test', 'https://evil.test']))]));
  const [other] = rules(d, 'diff/other');
  assert.equal(other.tool, 'show');
  assert.match(other.message, /^`show`: _meta changed/);
  assert.equal(rules(d, 'diff/apps-ui').length, 0);
  // An app-only tool added: not tokens the agent pays.
  const appOnly = tool('refresh', ['series'], ui('ui://a/v', { visibility: ['app'] }));
  const t = diffMenus(menuOf([tool('show', [])]), menuOf([tool('show', []), appOnly]));
  assert.equal(t.tokens.delta, 0);
});

test('apps: an empty _meta.ui.resourceUri falls back to the deprecated key', () => {
  assert.equal(resourceUriOf({ _meta: { ui: { resourceUri: '' }, 'ui/resourceUri': 'ui://x/v' } }), 'ui://x/v');
  assert.equal(resourceUriOf({ _meta: { ui: { resourceUri: 'ui://x/new' }, 'ui/resourceUri': 'ui://x/old' } }), 'ui://x/new');
  assert.equal(resourceUriOf({ _meta: { ui: { resourceUri: '' } } }), undefined);
});

test('apps: UI resources are read 4 at a time within one deadline, not one timeout each', async () => {
  let open = 0;
  let most = 0;
  const conn = {
    client: {
      readResource: ({ uri }, { timeout }) => {
        open++;
        most = Math.max(most, open);
        return new Promise((resolve, reject) => setTimeout(() => (open--, uri.endsWith('ok') ? resolve({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: 'x' }] }) : reject(new Error('Request timed out'))), uri.endsWith('ok') ? 5 : timeout));
      },
    },
  };
  const tools = [...Array(12)].map((_, i) => tool(`t${i}`, [], ui(`ui://s/${i}${i === 0 ? 'ok' : ''}`)));
  const started = Date.now();
  const out = await readAppResources(conn, tools, 100);
  assert.ok(Date.now() - started < 400, `all 12 within the 2 × 100 ms deadline (took ${Date.now() - started} ms)`);
  assert.equal(most, 4);
  assert.equal(out.length, 12);
  assert.deepEqual(out[0].mimeTypes, ['text/html;profile=mcp-app']);
  assert.ok(out.slice(1).every((r) => r.error));
  // 11 hang for the whole 100 ms timeout, 4 at a time: the third batch is past the 200 ms deadline.
  assert.ok(out.some((r) => /^not read: the reads took longer than/.test(r.error ?? '')));
});

test('menu/capability-dependent: the third listing is made only when the rule has something to say', () => {
  const appOnly = tool('refresh', [], ui('ui://a/v', { visibility: ['app'] }));
  const show = { ...tool('show', []), tokens: 20 };
  // Only an app-only tool more, and a token estimate apart: nothing to say.
  assert.equal(listingsDiffer([show, appOnly], [{ ...show, tokens: show.tokens + 7 }]), false);
  assert.equal(listingsDiffer([show, tool('extra', [])], [show]), true);
  assert.equal(listingsDiffer([tool('show', [], ui('ui://a/v'))], [show]), true);
});

test('spec/server-card: no protocol contradiction when this connection fell back to 2025 and a later one got 2026-07-28', () => {
  const card = { $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json', name: 'io.example/x', description: 'X.', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp', supportedProtocolVersions: ['2026-07-28'] }] };
  const lint = (more) => runRules(MENU_RULES, { menu: menuOf([tool('a', [])], { serverInfo: { name: 'x', version: '1.0.0' } }), pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2025-11-25', era: 'legacy', serverInfo: { name: 'x', version: '1.0.0' }, serverUrl: 'https://x.test/mcp', serverCard: { url: 'https://x.test/mcp/server-card', status: 200, contentType: 'application/mcp-server-card+json', card }, ...more }).filter((f) => f.rule === 'spec/server-card');
  assert.match(lint({})[0].message, /protocol: the card lists 2026-07-28 for https:\/\/x\.test\/mcp, the server negotiated 2025-11-25/);
  assert.deepEqual(lint({ laterModern: true }), []);
});
