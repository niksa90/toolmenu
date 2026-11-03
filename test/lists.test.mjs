// snapshot --lists: prompts/list, resources/list and resources/templates/list,
// end to end through the CLI with a fixture server, checked like tools/list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, run, tempDir } from './helpers.mjs';

const server = join(FIXTURES, 'lists-server.mjs');
const snap = (args, opts) => run(['snapshot', ...args, '--', process.execPath, server], opts);
const findings = async (args) => JSON.parse((await snap(['--no-write', '--json', ...args])).stdout).findings.filter((f) => f.rule.startsWith('lists/'));

test('--lists prompts,resources: read, counted, saved beside the tools; a clean server has no findings', async () => {
  const dir = tempDir();
  const out = join(dir, 'menu.json');
  const text = await snap(['--out', out, '--lists', 'prompts,resources']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /\n {2}also listed: 2 prompts · 2 resources · 1 resource template\n/);
  assert.match(text.stdout, /No findings\./);
  const menu = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(menu.toolmenu, 1, 'the file format is unchanged: the lists are additive keys');
  assert.deepEqual(menu.prompts.map((p) => p.name), ['summarize', 'review']);
  assert.deepEqual(menu.resources.map((r) => r.uri), ['file:///a.txt', 'file:///b.txt']);
  assert.deepEqual(menu.resourceTemplates.map((r) => r.uriTemplate), ['file:///{path}']);
  const json = JSON.parse((await snap(['--no-write', '--json', '--lists', 'prompts,resources'])).stdout);
  assert.deepEqual([json.prompts, json.resources, json.resourceTemplates], [2, 2, 1]);
});

test('without --lists, nothing but tools is read or saved', async () => {
  const dir = tempDir();
  const out = join(dir, 'menu.json');
  const r = await snap(['--out', out]);
  assert.doesNotMatch(r.stdout, /also listed/);
  const menu = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(menu.prompts, undefined);
  assert.equal(menu.resources, undefined);
});

test('lists/variance: a list that changes between two calls on one connection', async () => {
  const [f] = await findings(['--lists', 'resources', '--env', 'VARY=1']);
  assert.equal(f.rule, 'lists/variance');
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /^resources\/list differs between two calls on one connection: 1 change\./);
  assert.deepEqual(f.detail, ['same items, different order']);
});

test('lists/variance: a list that differs from a second process; off with --processes 1', async () => {
  const [f] = await findings(['--lists', 'prompts', '--env', 'PER_PROCESS=1']);
  assert.equal(f.rule, 'lists/variance');
  assert.match(f.message, /^prompts\/list from a second process differs from the first: 1 change\. 2026-07-28 lists no longer vary per connection/);
  assert.deepEqual(await findings(['--lists', 'prompts', '--env', 'PER_PROCESS=1', '--processes', '1']), []);
});

test('lists/schema: a result without the cache hints 2026-07-28 requires; a list that fails to answer', async () => {
  const [hints] = await findings(['--lists', 'resources', '--env', 'NO_HINTS=1']);
  assert.equal(hints.rule, 'lists/schema');
  assert.equal(hints.severity, 'error');
  assert.match(hints.message, /^The resources\/templates\/list result doesn't match the official 2026-07-28 schema/);
  assert.match(hints.fix, /^Add cacheScope, ttlMs to the resources\/templates\/list result \(2026-07-28 requires cache hints on it, SEP-2549\)\.$/);
  const [broken] = await findings(['--lists', 'prompts', '--env', 'BROKEN=1']);
  assert.equal(broken.rule, 'lists/schema');
  assert.equal(broken.severity, 'warn');
  assert.match(broken.message, /^The server declares prompts, but prompts\/list failed: .*prompts are not configured/);
});

test('a list the server doesn\'t offer is a note on the snapshot, not a finding', async () => {
  assert.deepEqual(await findings(['--lists', 'prompts,resources', '--env', 'NO_RESOURCES=1']), []);
  const text = await snap(['--no-write', '--lists', 'prompts,resources', '--env', 'NO_RESOURCES=1']);
  assert.match(text.stdout, /\n {2}also listed: 2 prompts · no resources offered \(not declared\)\n/);
  const json = JSON.parse((await snap(['--no-write', '--json', '--lists', 'prompts,resources', '--env', 'NO_RESOURCES=1'])).stdout);
  assert.deepEqual(json.notOffered, ['resources', 'resourceTemplates']);
});

test('lists/schema: Method not found for a declared list is info; a setup failure (credentials) is info that says so', async () => {
  const [missing] = await findings(['--lists', 'resources', '--env', 'NO_TEMPLATES=1']);
  assert.equal(missing.severity, 'info');
  assert.match(missing.message, /^The server declares resources but answers resources\/templates\/list with Method not found \(-32601\), so a client that asks for resource templates gets an error, not an empty list\.$/);
  const [setup] = await findings(['--lists', 'resources', '--env', 'NO_KEY=1']);
  assert.equal(setup.severity, 'info');
  assert.match(setup.message, /^resources\/list couldn't be read here \(.*Not authenticated: set LISTS_API_KEY\), so it wasn't checked: a setup problem, not the server's\.$/);
});

test('--lists on a 2025 server: checked against that version\'s schema, with no cache hints required', async () => {
  const r = JSON.parse((await snap(['--no-write', '--json', '--lists', 'prompts,resources', '--env', 'LEGACY=1'])).stdout);
  assert.ok(r.server.protocolVersion < '2026-07-28');
  assert.deepEqual(r.findings.filter((f) => f.rule.startsWith('lists/')), []);
  assert.equal(r.prompts, 2);
});

test('--lists: usage errors and the config key', async () => {
  const bad = await snap(['--lists', 'prompts,tasks']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--lists takes tools, prompts, resources, comma-separated; not "tasks"/);
  const session = await run(['session', '--auto', '--lists', 'prompts', '--', process.execPath, server]);
  assert.equal(session.code, 2);
  assert.match(session.stderr, /--lists goes with snapshot/);
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ lists: ['prompts'] }));
  const fromConfig = JSON.parse((await snap(['--no-write', '--json'], { cwd: dir })).stdout);
  assert.equal(fromConfig.prompts, 2);
  assert.equal(fromConfig.resources, undefined);
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ lists: ['everything'] }));
  const badConfig = await snap(['--no-write'], { cwd: dir });
  assert.equal(badConfig.code, 2);
  assert.match(badConfig.stderr, /lists must be a list of tools, prompts, resources/);
});

// 0.20, from the review of 0.19.
test('a list longer than the page cap is read up to it, and the snapshot says the checks cover those pages only', async () => {
  const [f] = await findings(['--lists', 'resources', '--env', 'PAGED=1', '--processes', '1']);
  assert.equal(f.severity, 'info');
  assert.match(f.message, /^resources\/list has more than 50 pages; toolmenu read the first 50 \(50 items\), so the checks and the menu file cover those only\.$/);
});

test('--format markdown names the other lists too', async () => {
  const md = await snap(['--no-write', '--format', 'markdown', '--lists', 'prompts,resources']);
  assert.match(md.stdout, /\nAlso listed: 2 prompts · 2 resources · 1 resource template\n/);
});

test('diff: prompts and resource templates compare like tools; resources as data; a list one side didn\'t read isn\'t compared', async () => {
  const dir = tempDir();
  const old = join(dir, 'old.json');
  const next = join(dir, 'new.json');
  const bare = join(dir, 'bare.json');
  await snap(['--out', old, '--lists', 'prompts,resources']);
  await snap(['--out', next, '--lists', 'prompts,resources', '--env', 'NEXT=1']);
  await snap(['--out', bare]);
  const d = JSON.parse((await run(['diff', '--json', old, next])).stdout);
  const by = (rule) => d.findings.filter((f) => f.rule === rule);
  assert.match(by('diff/prompt-removed')[0].message, /^Prompt `review` was removed\./);
  assert.equal(by('diff/prompt-removed')[0].class, 'breaking');
  assert.match(by('diff/prompt-argument-required')[0].message, /^Prompt `summarize` now requires `topic`\./);
  assert.match(by('diff/prompt-added')[0].message, /^Prompt `translate` is new\.$/);
  assert.match(by('diff/resource-template-added')[0].message, /^Resource template `db:\/\/\{table\}` is new\.$/);
  const [res] = by('diff/resources');
  assert.equal(res.class, 'notice');
  assert.deepEqual(res.detail, ['gone: file:///b.txt', 'new: file:///c.txt']);
  assert.equal(d.suggestedBump, 'major', 'a removed prompt is breaking');
  // The reverse: a template removed is breaking too.
  const back = JSON.parse((await run(['diff', '--json', next, old])).stdout);
  assert.equal(back.findings.find((f) => f.rule === 'diff/resource-template-removed').class, 'breaking');
  // Only one side read the lists: said, not compared.
  const half = JSON.parse((await run(['diff', '--json', bare, next])).stdout);
  assert.deepEqual(half.findings.filter((f) => /prompt|resource/.test(f.rule) && f.rule !== 'diff/lists-unread'), []);
  assert.match(half.findings.find((f) => f.rule === 'diff/lists-unread').message, /^Not compared: prompts \(the new menu has them, the old one wasn't read with --lists\)/);
  // The same release twice: nothing.
  const same = JSON.parse((await run(['diff', '--json', old, old])).stdout);
  assert.deepEqual(same.findings.filter((f) => /prompt|resource|lists/.test(f.rule)), []);
});

// 0.20.1, from scanning hosted servers: "Method not supported" (-32600) is Method not found in other words.
test('lists/schema: a declared list answered with "Method not supported" is info, like Method not found', async () => {
  const [f] = await findings(['--lists', 'resources', '--env', 'UNSUPPORTED=1']);
  assert.equal(f.severity, 'info');
  assert.match(f.message, /answers resources\/templates\/list with Method not found/);
});
