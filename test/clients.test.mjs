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
  // Not sourced, so not there: what OpenAI's model sees before a search, and how many results come back.
  assert.equal(CLIENTS.openai.beforeSearch, undefined);
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

test('--client claude-api-search: nothing up front with every tool deferred; openai: no up-front figure, since its spec doesn\'t say', async () => {
  const api = await json(['--client', 'claude-api-search']);
  assert.equal(api.client.upfront, 0);
  assert.match(api.client.basis, /docs advise keeping the 3–5 tools used most loaded/);
  const openai = await json(['--client', 'openai']);
  assert.equal(openai.client.upfront, undefined);
  assert.match(openai.client.basis, /what the model sees before a search isn't in https:\/\/github\.com\/openai\/openai-openapi/);
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
