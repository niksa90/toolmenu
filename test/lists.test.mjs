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

test('lists/undeclared: a list asked for that the server has no capability for is said, not an error', async () => {
  const [f] = await findings(['--lists', 'prompts,resources', '--env', 'NO_RESOURCES=1']);
  assert.equal(f.rule, 'lists/undeclared');
  assert.equal(f.severity, 'info');
  assert.match(f.message, /^The server declares no resources capability, so resources\/list and resources\/templates\/list weren't read\./);
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
