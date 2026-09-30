import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { embeddedJson, findRouters, LISTING_PHRASE, operationsIn, routerShape } from '../dist/catalog.js';
import { FIXTURES, run, tempDir, tool } from './helpers.mjs';

const routerServer = (env = {}) => [...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', process.execPath, join(FIXTURES, 'router-server.mjs')];
const routerTool = (name, description = 'This tool is a hierarchical MCP command router. Set "learn=true" to discover available sub commands.', required = ['intent']) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { intent: { type: 'string' }, command: { type: 'string' }, parameters: { type: 'object' }, learn: { type: 'boolean', default: false } }, required },
});

test('routerShape and findRouters: shape plus wording, and only a call that names no command', () => {
  const { usable, skipped } = findRouters([
    routerTool('files'),
    routerTool('plain', 'Manage plain things.'),
    routerTool('locked', undefined, ['intent', 'command']),
    tool('search_issues', ['query']),
  ]);
  assert.deepEqual(usable.map((u) => u.tool.name), ['files']);
  assert.deepEqual(usable[0].arguments, { learn: true, intent: LISTING_PHRASE });
  assert.deepEqual(skipped.map((s) => s.tool), ['locked']);
  assert.match(skipped[0].reason, /command parameter is required/);
  // Named in the config, the wording isn't needed; the shape and the safety still are.
  assert.ok('call' in routerShape(routerTool('plain', 'Manage plain things.'), true));
  assert.match(routerShape(tool('get_issue', ['id']), true).reason, /no boolean listing flag/);
  const picky = routerTool('picky');
  picky.inputSchema.properties.region = { type: 'string', enum: ['eu', 'us'] };
  picky.inputSchema.required = ['intent', 'region'];
  assert.match(routerShape(picky).reason, /won't guess/);
});

test('embeddedJson and operationsIn: prose, then the command list (Azure-style)', () => {
  const text = 'Here are the available commands.\nRun again with "command".\n\n[{"command":"files_list","description":"List.","inputSchema":{"type":"object","properties":{}}}]';
  assert.deepEqual(embeddedJson(text), [{ command: 'files_list', description: 'List.', inputSchema: { type: 'object', properties: {} } }]);
  assert.deepEqual(operationsIn({ content: [{ type: 'text', text }] }, { nameKeys: ['name', 'command'], embedded: true }).map((o) => o.name), ['files_list']);
  assert.deepEqual(operationsIn({ content: [{ type: 'text', text }] }), [], 'the search crawl reads leading JSON only, as before');
});

test('cli: snapshot --catalog lists the commands behind routers without running one, and diff compares them', async () => {
  const cwd = tempDir();
  const log = join(cwd, 'calls.jsonl');
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0 } }));
  const a = await run(['snapshot', '--catalog', '--json', '--out', 'v1.json', ...routerServer({ CALL_LOG: log })], { cwd });
  assert.equal(a.code, 0, a.stderr);
  const menu = JSON.parse(readFileSync(join(cwd, 'v1.json'), 'utf8'));
  assert.equal(menu.toolmenu, 1);
  assert.equal(menu.catalog.tool, 'the command routers');
  assert.deepEqual(menu.catalog.queries, []);
  assert.deepEqual(menu.catalog.operations.map((o) => o.name), ['files_copy', 'files_delete', 'files_list', 'vault_secret_get', 'vault_secret_set']);
  assert.deepEqual(menu.catalog.routers.map((r) => [r.tool, r.operations]), [['files', 3], ['vault', 2]]);
  assert.deepEqual(menu.catalog.skipped.map((s) => s.tool), ['locked']);

  // Every call was a listing call: learn: true, no command, no parameters; the
  // router whose command is required was never called.
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.name).sort(), ['files', 'vault']);
  for (const c of calls) {
    assert.equal(c.arguments.learn, true);
    assert.ok(!('command' in c.arguments) && !('parameters' in c.arguments), JSON.stringify(c));
    assert.equal(c.executed, false);
  }

  const findings = JSON.parse(a.stdout).findings;
  const read = findings.find((f) => f.rule === 'catalog/read');
  assert.match(read.message, /5 operations behind 2 command routers.*never with a command/);
  assert.match(read.detail[0], /"learn":true/);
  const skipped = findings.find((f) => f.rule === 'catalog/skipped');
  assert.equal(skipped.confidence, 'unsure');
  assert.ok(skipped.fix);

  await run(['snapshot', '--catalog', '--out', 'v2.json', ...routerServer({ ROUTER_VERSION: '2' })], { cwd });
  const d = await run(['diff', '--json', 'v1.json', 'v2.json'], { cwd });
  const diff = JSON.parse(d.stdout).findings;
  const breaking = diff.find((f) => f.rule === 'diff/param-required');
  assert.match(breaking.message, /files_delete\.force .*behind the command routers/);
  assert.ok(diff.some((f) => f.rule === 'diff/catalog-missing' && /files_copy/.test(f.message)));
  assert.equal(d.code, 1);

  // The same server twice: the same catalog, and diff reports nothing.
  await run(['snapshot', '--catalog', '--out', 'v1b.json', ...routerServer()], { cwd });
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'v1b.json'), 'utf8')).catalog, menu.catalog);
  const same = await run(['diff', '--json', 'v1.json', 'v1b.json'], { cwd });
  assert.deepEqual(JSON.parse(same.stdout).findings, []);
});

test('cli: a router that wants credentials leaves its part out, with a next step', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0 } }));
  const a = await run(['snapshot', '--catalog', '--json', '--out', 'm.json', ...routerServer({ AUTH_FAIL: '1' })], { cwd });
  assert.equal(a.code, 0, a.stderr);
  const catalog = JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).catalog;
  assert.deepEqual(catalog.failed.map((f) => f.query), ['vault']);
  assert.deepEqual(catalog.operations.map((o) => o.name), ['files_copy', 'files_delete', 'files_list']);
  const failed = JSON.parse(a.stdout).findings.find((f) => f.rule === 'catalog/failed');
  assert.match(failed.message, /^1 router wanted credentials before it would list its commands: vault\./);
  assert.equal(failed.confidence, 'unsure');
  assert.match(failed.fix, /credentials/);
});

test('cli: catalog.routers names routers detection misses; a bad name stops with a next step', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0 } }));
  const missed = await run(['snapshot', '--catalog', '--out', 'm.json', ...routerServer({ PLAIN_WORDS: '1' })], { cwd });
  assert.equal(missed.code, 2);
  assert.match(missed.stderr, /nothing to read in this menu of 4 tools/);
  assert.match(missed.stderr, /→ Next: .*"routers"/);

  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0, routers: ['vault'] } }));
  const named = await run(['snapshot', '--catalog', '--out', 'm.json', ...routerServer({ PLAIN_WORDS: '1' })], { cwd });
  assert.equal(named.code, 0, named.stderr);
  const catalog = JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).catalog;
  assert.equal(catalog.tool, 'vault');
  assert.deepEqual(catalog.operations.map((o) => o.name), ['vault_secret_get', 'vault_secret_set']);

  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { routers: ['Vault'] } }));
  const typo = await run(['snapshot', '--catalog', '--out', 'm.json', ...routerServer()], { cwd });
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /no tool by that name .*Did you mean vault\?/);

  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { routers: ['locked'] } }));
  const unsafe = await run(['snapshot', '--catalog', '--out', 'm.json', ...routerServer()], { cwd });
  assert.equal(unsafe.code, 2);
  assert.match(unsafe.stderr, /won't call it: its command parameter is required/);

  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { routers: 'vault' } }));
  const shape = await run(['snapshot', '--catalog', '--out', 'm.json', ...routerServer()], { cwd });
  assert.match(shape.stderr, /catalog\.routers must be a list of tool names/);
});
