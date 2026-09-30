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
  assert.deepEqual(menu.catalog.operations.map((o) => o.name), ['files.files_copy', 'files.files_delete', 'files.files_list', 'vault.vault_secret_get', 'vault.vault_secret_set']);
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
  assert.deepEqual(catalog.operations.map((o) => o.name), ['files.files_copy', 'files.files_delete', 'files.files_list']);
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
  assert.deepEqual(catalog.operations.map((o) => o.name), ['vault.vault_secret_get', 'vault.vault_secret_set']);

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

test('an oddly shaped router is skipped, or stops the run only when the config named it; nothing is sent', async () => {
  // Required params named like a command or its arguments are never filled in,
  // whatever their type.
  const odd = { name: 'odd', inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'string' }, help: { type: 'boolean' } }, required: ['args'] } };
  assert.match(routerShape(odd, true).reason, /its args parameter is required/);
  const twin = routerTool('twin', undefined, ['intent', 'subcommand']);
  twin.inputSchema.properties.subcommand = { type: 'string' };
  assert.match(routerShape(twin).reason, /its subcommand parameter is required/);

  const cwd = tempDir();
  const log = join(cwd, 'calls.jsonl');
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0 } }));
  const a = await run(['snapshot', '--catalog', '--json', '--out', 'm.json', ...routerServer({ ODD: '1', CALL_LOG: log })], { cwd });
  assert.equal(a.code, 0, a.stderr);
  const catalog = JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).catalog;
  assert.deepEqual(catalog.skipped.map((s) => s.tool), ['locked', 'twin']);
  assert.match(catalog.skipped[1].reason, /subcommand parameter is required/);
  assert.ok(!readFileSync(log, 'utf8').includes('"twin"'));

  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0, routers: ['odd'] } }));
  const named = await run(['snapshot', '--catalog', '--out', 'm.json', ...routerServer({ ODD: '1', CALL_LOG: log })], { cwd });
  assert.equal(named.code, 2);
  assert.match(named.stderr, /won't call it: its args parameter is required/);
  assert.doesNotMatch(named.stderr, /toolmenu bug/);
  assert.ok(!readFileSync(log, 'utf8').includes('"odd"'));
});

test('router operation names stay the same when another router fails', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0 } }));
  await run(['snapshot', '--catalog', '--out', 'v1.json', ...routerServer({ ANSWER: 'files:shared,vault:shared' })], { cwd });
  await run(['snapshot', '--catalog', '--out', 'v2.json', ...routerServer({ ANSWER: 'files:shared,vault:error' })], { cwd });
  const names = (f) => JSON.parse(readFileSync(join(cwd, f), 'utf8')).catalog.operations.map((o) => o.name);
  assert.ok(names('v1.json').includes('files.list') && names('v1.json').includes('vault.list'));
  assert.deepEqual(names('v2.json'), names('v1.json').filter((n) => n.startsWith('files.')));
  const d = JSON.parse((await run(['diff', '--json', 'v1.json', 'v2.json'], { cwd })).stdout).findings;
  assert.ok(!d.some((f) => /\bfiles\./.test(f.message)), JSON.stringify(d.map((f) => f.message)));
});

test('same-named commands in one router are all kept, keyed by command, and said so', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0, routers: ['vault'] } }));
  const a = await run(['snapshot', '--catalog', '--json', '--out', 'm.json', ...routerServer({ DUPES: '1' })], { cwd });
  assert.equal(a.code, 0, a.stderr);
  const catalog = JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).catalog;
  assert.deepEqual(catalog.operations.map((o) => o.name), [
    'vault.vault key list',
    'vault.vault secret list',
    'vault.vault_purge',
    'vault.vault_rotate',
    'vault.vault_rotate#2',
    'vault.vault_secret_get',
    'vault.vault_secret_set',
  ]);
  assert.equal(catalog.operations.find((o) => o.name === 'vault.vault_rotate#2').description, 'Rotate a key.');
  const read = JSON.parse(a.stdout).findings.find((f) => f.rule === 'catalog/read');
  assert.ok(read.detail.some((d) => /vault listed vault_rotate twice.*vault\.vault_rotate#2/.test(d)), JSON.stringify(read.detail));
});

test('an unreadable answer is told apart from an error, and an empty list is not a failure', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0 } }));
  const a = await run(['snapshot', '--catalog', '--json', '--out', 'm.json', ...routerServer({ ANSWER: 'files:garbled,vault:error,empty:empty' })], { cwd });
  assert.equal(a.code, 0, a.stderr);
  const catalog = JSON.parse(readFileSync(join(cwd, 'm.json'), 'utf8')).catalog;
  assert.deepEqual(catalog.failed.map((f) => f.query), ['files', 'vault']);
  assert.equal(catalog.routers.find((r) => r.tool === 'empty').operations, 0);
  const failed = JSON.parse(a.stdout).findings.filter((f) => f.rule === 'catalog/failed');
  assert.equal(failed.length, 2);
  const [unreadable, error] = [failed.find((f) => f.tool === 'files'), failed.find((f) => f.tool === 'vault')];
  assert.match(unreadable.message, /^1 router answered, but not with a command list toolmenu could read: files\./);
  assert.match(unreadable.fix, /another format/);
  assert.match(error.message, /^1 router answered the listing call with an error: vault\./);

  // Only an empty list: nothing failed.
  const b = await run(['snapshot', '--catalog', '--json', '--out', 'e.json', ...routerServer({ ANSWER: 'empty:empty' })], { cwd });
  const eCatalog = JSON.parse(readFileSync(join(cwd, 'e.json'), 'utf8')).catalog;
  assert.equal(eCatalog.failed, undefined);
  assert.ok(!JSON.parse(b.stdout).findings.some((f) => f.rule === 'catalog/failed'));
});
