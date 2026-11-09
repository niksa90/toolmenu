// --client: client profiles from each client's own docs, end to end through the CLI
// with a 2026-07-28 fixture server, and the parts underneath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, menuOf, run, tempDir, tool } from './helpers.mjs';
import { CLIENTS, clientCost, nameProblem } from '../dist/clients.js';
import { buildIndex } from '../dist/search.js';
import { MENU_RULES, runRules } from '../dist/rules/index.js';

const server = join(FIXTURES, 'client-server.mjs');
const snap = (args) => run(['snapshot', '--no-write', ...args, '--', process.execPath, server]);
const json = async (args) => JSON.parse((await snap(['--json', ...args])).stdout);

test('every profile value says where it was read and when', () => {
  for (const [name, profile] of Object.entries(CLIENTS)) {
    for (const [key, v] of Object.entries(profile)) {
      if (key === 'label') continue;
      assert.ok(/^https?:\/\//.test(v.source), `${name}.${key} has a source URL`);
      assert.match(v.read, /^\d{4}-\d{2}-\d{2}$/, `${name}.${key} has a read date`);
    }
  }
  // What OpenAI's guide says the model sees before a search; not sourced, so not there: how many results come back.
  assert.equal(CLIENTS.openai.beforeSearch.value, 'name-and-description');
  assert.equal(CLIENTS.openai.searchLimit, undefined);
});

test('--client claude-code: names up front, full definitions on demand, tools marked to load up front in full', async () => {
  const r = await snap(['--client', 'claude-code']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\n {2}as Claude Code: up front ~\d+ tokens \(names, and 1 tool loaded in full\) · on demand ~\d+ per tool a search loads \(largest: list_entries, ~\d+\)\n/);
  assert.match(r.stdout, /Claude Code defers MCP tools and shows their names until a search loads one; the server's instructions load up front too and aren't counted here \(https:\/\/code\.claude\.com\/docs\/en\/mcp, read \d{4}-\d{2}-\d{2}\)/);
  const out = await json(['--client', 'claude-code']);
  assert.deepEqual(out.client.loaded, ['search_records']);
  assert.ok(out.client.upfront < out.totalTokens / 5, 'names cost a fraction of the definitions');
});

test('--client claude-api-search: nothing up front with every tool deferred; openai: names and descriptions up front, schemas on demand', async () => {
  const api = await json(['--client', 'claude-api-search']);
  assert.equal(api.client.upfront, 0);
  assert.match(api.client.basis, /docs advise keeping the 3–5 tools used most loaded/);
  const openai = await json(['--client', 'openai']);
  assert.ok(openai.client.upfront > 0 && openai.client.upfront < openai.totalTokens, 'names and descriptions are up front, schemas are not');
  // On demand is what the names and descriptions leave out: less than the whole tool.
  const api2 = await json(['--client', 'claude-api-search']);
  assert.ok(openai.client.perTool < api2.client.perTool);
  assert.match(openai.client.basis, /each tool's name and description stay up front and its schema loads on demand; deferred as one MCP server, the model sees only the server's name and description .*\(https:\/\/developers\.openai\.com\/api\/docs\/guides\/tools-tool-search, read 2026-11-03\)$/);
});

test('naming/client-name: names the client\'s API refuses, with the source; quiet without --client', async () => {
  for (const client of ['claude-code', 'claude-api-search', 'openai']) {
    const [f] = (await json(['--client', client])).findings.filter((x) => x.rule === 'naming/client-name');
    assert.equal(f.severity, 'warn', client);
    assert.match(f.message, /^2 tool names don't fit the tool name format of /, client);
    assert.deepEqual(f.detail.slice(0, 2), ['files.read: has ".", outside letters, digits, _ and -', 'get user: has a space, outside letters, digits, _ and -'], client);
    assert.match(f.detail.at(-1), /^Source: https?:\/\/.+ \(read \d{4}-\d{2}-\d{2}\)\.$/, client);
  }
  const none = await json([]);
  assert.equal(none.findings.filter((x) => x.rule === 'naming/client-name').length, 0);
  assert.equal(none.client, undefined);
});

test('nameProblem: length and characters', () => {
  assert.equal(nameProblem('get_user-v2', CLIENTS['claude-code']), undefined);
  assert.equal(nameProblem('a'.repeat(129), CLIENTS.openai), '129 characters, over 128');
  assert.equal(nameProblem('ns/tool.x', CLIENTS.openai), 'has "/", ".", outside letters, digits, _ and -');
});

test('search: Claude Code\'s search reads a description only up to character 4,096', () => {
  const late = tool('list_entries', [], { description: `${'Lists the records. '.repeat(250)}Ledger entries too.` });
  const other = tool('get_ledger', [], { description: 'Gets the ledger.' });
  assert.ok(buildIndex([late, other]).rank('ledger').some((r) => r.tool === 'list_entries'));
  assert.ok(!buildIndex([late, other], { descriptionChars: 4096 }).rank('ledger').some((r) => r.tool === 'list_entries'));
});

test('search/findable: runs at any size for a client that defers; not for a client whose search limit is undocumented', () => {
  // Three tools, far under the default threshold (10 tools or 10K tokens); one that its own name doesn't find.
  const tools = [
    tool('get_report', [], { description: 'Gets the weekly summary.' }),
    tool('list_reports', [], { description: 'Lists every report, report by report, each report in full.' }),
    tool('export_report', [], { description: 'Exports a report as a report file for the report archive.' }),
    ...Array.from({ length: 4 }, (_, i) => tool(`report_${i}`, [], { description: 'Report report report.' })),
  ];
  const lint = (client) => runRules(MENU_RULES, { menu: menuOf(tools), pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2026-07-28', era: 'modern', ...(client ? { client } : {}) }).filter((f) => f.rule === 'search/findable');
  assert.equal(lint().length, 0, 'under the threshold without a client');
  assert.equal(lint('claude-api-search').length, 1);
  assert.equal(lint('claude-code').length, 1);
  assert.equal(lint('openai').length, 0);
});

test('--client: the description cut follows the profile; a client with no documented cut isn\'t held to Claude Code\'s', async () => {
  const long = `${'Lists the records. '.repeat(900)}Never guess a record ID.`; // past 16,384
  const tools = [tool('get_record', ['record_id'], { description: long })];
  const lint = (client) => runRules(MENU_RULES, { menu: menuOf(tools), pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2026-07-28', era: 'modern', client, descriptionLimit: client === 'claude-code' ? 'claude-code' : Number.POSITIVE_INFINITY }).filter((f) => f.rule.startsWith('description/'));
  assert.deepEqual(lint('claude-code').map((f) => f.rule), ['description/buried']);
  assert.deepEqual(lint('openai'), []);
  // And through the CLI: the snapshot maps the profile to its cut.
  const out = await json(['--client', 'openai']);
  assert.equal(out.findings.filter((f) => f.rule.startsWith('description/')).length, 0);
});

test('--client: usage errors and the config key', async () => {
  const bad = await snap(['--client', 'cursor']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--client must be one of claude-code, claude-api-search, openai/);
  const session = await run(['session', '--auto', '--client', 'openai', '--', process.execPath, server]);
  assert.equal(session.code, 2);
  assert.match(session.stderr, /--client goes with snapshot/);
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ client: 'openai' }));
  const fromConfig = JSON.parse((await run(['snapshot', '--no-write', '--json', '--', process.execPath, server], { cwd: dir })).stdout);
  assert.equal(fromConfig.client.client, 'openai');
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ client: 'cursor' }));
  const badConfig = await run(['snapshot', '--no-write', '--', process.execPath, server], { cwd: dir });
  assert.equal(badConfig.code, 2);
  assert.match(badConfig.stderr, /client must be one of claude-code, claude-api-search, openai/);
});

test('clientCost: a profile that defers nothing has no cost line', () => {
  assert.equal(clientCost('unknown', menuOf([tool('a')])), undefined);
});

// 0.20, from the review of 0.18: a name that's a key of every object is no client.
test('--client and descriptionLimit: "toString" and "constructor" name no client', async () => {
  const cli = await snap(['--client', 'toString']);
  assert.equal(cli.code, 2);
  assert.match(cli.stderr, /--client must be one of/);
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ client: 'constructor' }));
  const cfg = await run(['snapshot', '--no-write', '--', process.execPath, server], { cwd: dir });
  assert.equal(cfg.code, 2);
  assert.match(cfg.stderr, /client must be one of/);
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ descriptionLimit: 'toString' }));
  const limit = await run(['snapshot', '--no-write', '--', process.execPath, server], { cwd: dir });
  assert.equal(limit.code, 2);
  assert.match(limit.stderr, /descriptionLimit must be a positive number or one of/);
});

// The clients added 2026-11-09, each value read from the client's own docs or source.
const lintAs = (client, menu) => runRules(MENU_RULES, { menu, pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2026-07-28', era: 'modern', client });

test('menu/client-limit: VS Code sends at most 128 tools a request; a server over it alone is a warning, at it is fine', () => {
  const many = (n) => menuOf(Array.from({ length: n }, (_, i) => tool(`tool_${i}`)));
  const over = lintAs('vscode', many(129)).filter((f) => f.rule === 'menu/client-limit');
  assert.equal(over.length, 1);
  assert.equal(over[0].severity, 'warn');
  assert.match(over[0].message, /^129 tools, over the 128 VS Code \(GitHub Copilot Chat\) allows in one request/);
  assert.match(over[0].detail.at(-1), /code\.visualstudio\.com\/docs\/agents\/run\/tools \(read 2026-11-09\)/);
  assert.deepEqual(lintAs('vscode', many(128)).filter((f) => f.rule === 'menu/client-limit'), []);
  assert.deepEqual(lintAs('claude-code', many(500)).filter((f) => f.rule === 'menu/client-limit'), [], 'no documented limit, no finding');
});

test('menu/client-features: Copilot cloud agent leaves prompts and resources out; code review also every tool not marked read-only', () => {
  const m = menuOf([tool('get_a', [], { annotations: { readOnlyHint: true } }), tool('set_b')]);
  m.prompts = [{ name: 'p' }];
  m.resources = [{ uri: 'x://1' }, { uri: 'x://2' }];
  const agent = lintAs('copilot-cloud-agent', m).filter((f) => f.rule === 'menu/client-features');
  assert.equal(agent.length, 1);
  assert.match(agent[0].message, /uses only MCP tools, not resources and prompts, so the server's 1 prompt and 2 resources aren't available there/);
  const review = lintAs('copilot-code-review', m).filter((f) => f.rule === 'menu/client-features');
  assert.equal(review.length, 2);
  assert.match(review[1].message, /uses only tools marked readOnlyHint: true, and 1 tool of 2 isn't, so it isn't available there/);
  assert.equal(review[1].detail[0], 'set_b');
  assert.deepEqual(lintAs('copilot-cloud-agent', menuOf([tool('a')])).filter((f) => f.rule === 'menu/client-features'), [], 'tools only: nothing left out');
});

test('naming/client-name: Gemini CLI rewrites names (dots and colons are fine there, 63 characters), the Gemini API allows 128, Codex takes OpenAI\'s rule', () => {
  const names = (client, ...ns) => lintAs(client, menuOf(ns.map((n) => tool(n)))).filter((f) => f.rule === 'naming/client-name');
  assert.deepEqual(names('gemini-cli', 'files.read', 'ns:get'), [], 'dots and colons are kept');
  const cli = names('gemini-cli', 'get user', 'x'.repeat(64));
  assert.equal(cli.length, 1);
  assert.match(cli[0].message, /Gemini CLI keeps as they are .* at most 63 characters\)\. It replaces other characters with underscores and cuts longer names in the middle, so its model sees a name that isn't the server's/);
  assert.match(cli[0].detail.join('\n'), /get user: has a space, outside letters, digits, _, -, \. and :/);
  assert.deepEqual(names('gemini-api', 'x'.repeat(100)), []);
  assert.match(names('codex', 'files.read')[0].message, /OpenAI's Responses API, which Codex sends tools to/);
});

test('--client antigravity: tool names up front, a tool\'s schema when the agent reads it', () => {
  const m = menuOf([tool('alpha', ['a', 'b', 'c'], { description: 'Alpha does a long thing. '.repeat(20) }), tool('beta')]);
  const c = clientCost('antigravity', m);
  assert.ok(c.upfront < m.totalTokens / 4, 'names only up front');
  assert.deepEqual(c.loaded, []);
  assert.match(c.basis, /Antigravity lists each MCP tool's name and loads a tool's schema when the agent reads it/);
  assert.equal(clientCost('vscode', m), undefined, 'VS Code\'s docs don\'t say it defers: no figure');
});
