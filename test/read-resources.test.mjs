// snapshot --read-resources: resources/read on each listed resource, end to end through
// the CLI with a fixture server (test/fixtures/read-server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, run, tempDir } from './helpers.mjs';
import { spread } from '../dist/resource-read.js';

const server = join(FIXTURES, 'read-server.mjs');
const MARKER = 'TOOLMENU-BODY-MARKER-7f3a';
const snap = (args, opts) => run(['snapshot', '--no-write', ...args, '--', process.execPath, server], opts);
const env = (pairs) => Object.entries(pairs).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
/** The run as JSON, with its lists/resource-* findings by rule. */
async function read(pairs = {}, args = [], opts) {
  const r = await snap(['--json', '--lists', 'resources', '--read-resources', ...args, ...env(pairs)], opts);
  const json = JSON.parse(r.stdout);
  const of = (rule) => json.findings.filter((f) => f.rule === `lists/${rule}`);
  return { json, raw: r.stdout, unreadable: of('resource-unreadable'), schema: of('resource-read-schema'), unread: of('resource-unread'), all: json.findings.filter((f) => f.rule.startsWith('lists/resource-')) };
}

test('every listed resource reads: no finding, and the report says how many were read', async () => {
  const r = await read();
  assert.deepEqual(r.all, []);
  assert.deepEqual(r.json.resourcesRead, { read: 2, listed: 2 });
  const text = await snap(['--lists', 'resources', '--read-resources']);
  assert.match(text.stdout, /\n {2}resources\/read: 2 of 2 listed resources read\n/);
});

test('quiet: an empty file, a directory of sub-resources, a URI that comes back encoded, an error field among data', async () => {
  const r = await read({ LIST: 'empty://e,dir://d,enc://a%20b,errorfield://e' });
  assert.deepEqual(r.all, []);
  assert.equal(r.json.resourcesRead.read, 4);
});

test('lists/resource-unreadable: a listed resource the server then says is missing (-32602, and -32002 before 2026-07-28)', async () => {
  const modern = await read({ LIST: 'ok://a,missing://x' });
  assert.equal(modern.unreadable.length, 1);
  const [f] = modern.unreadable;
  assert.equal(f.severity, 'warn');
  assert.equal(f.confidence, undefined);
  assert.equal(f.message, 'resources/list names missing://x, but resources/read of it failed: Resource missing://x not found (-32602). A client that offers the list gets an error when this one is picked.');
  assert.equal(f.fix, "Make resources/read answer every URI resources/list returns, or leave the ones it can't serve out of the list.");
  const legacy = await read({ LIST: 'ok://a,missing://x', LEGACY: 1 });
  assert.match(legacy.unreadable[0].message, /not found \(-32002\)\. A client/);
  assert.equal(legacy.json.server.protocolVersion, '2025-11-25');
});

test('lists/resource-unreadable: several failures are one finding; ENOENT is the server naming a file it lacks, not this machine', async () => {
  const r = await read({ LIST: 'ok://a,enoent://y,broken://z,missing://x' });
  assert.equal(r.unreadable.length, 1);
  const [f] = r.unreadable;
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /^resources\/list names 3 resources that resources\/read fails on \(of 4 read\)\./);
  assert.deepEqual(f.detail, [
    'broken://z: the index is corrupt (-32603)',
    "enoent://y: ENOENT: no such file or directory, open '/data/y.json' (-32603)",
    'missing://x: Resource missing://x not found (-32602)',
  ]);
  assert.deepEqual(r.unread, []);
});

test('lists/resource-unreadable: a read that succeeds with only an error for a body (tdmcp 0.13.2), marked unsure, with none of the body in the output', async () => {
  const r = await read({ LIST: 'ok://a,soft://error-dat' });
  assert.equal(r.unreadable.length, 1);
  const [f] = r.unreadable;
  assert.equal(f.severity, 'warn');
  assert.equal(f.confidence, 'unsure');
  assert.match(f.message, /^resources\/read of soft:\/\/error-dat succeeds, but its content is only a JSON object saying an error \(keys: error\)\. A client takes that for the resource/);
  assert.match(f.fix, /^If the read failed, answer with a JSON-RPC error \(-32602 for a resource that doesn't exist\)/);
  assert.ok(!r.raw.includes(MARKER), 'the body is never quoted');
  const legacy = await read({ LIST: 'soft://a,soft://b', LEGACY: 1 });
  assert.match(legacy.unreadable[0].message, /^resources\/read succeeds for 2 listed resources \(of 2 read\) whose content is only/);
  assert.deepEqual(legacy.unreadable[0].detail, ['soft://a', 'soft://b']);
  assert.match(legacy.unreadable[0].fix, /\(-32002 for a resource/);
});

test('lists/resource-unreadable: an empty contents array is info', async () => {
  const r = await read({ LIST: 'ok://a,none://n' });
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].severity, 'info');
  assert.match(r.unreadable[0].message, /^resources\/read of none:\/\/n returns an empty contents array\. A client can't tell/);
});

test('lists/resource-read-schema: 2026-07-28 results without cache hints are one finding however many resources; fine on 2025-11-25', async () => {
  const r = await read({ LIST: 'ok://a,ok://b,ok://c', NO_HINTS: 1 });
  assert.equal(r.schema.length, 1);
  const [f] = r.schema;
  assert.equal(f.severity, 'error');
  assert.match(f.message, /^The resources\/read result doesn't match for 3 resources of 3 read: they don't match the official 2026-07-28 schema, so a strict client may refuse them\.$/);
  assert.deepEqual(f.detail, ["(result) must have required property 'cacheScope'", "(result) must have required property 'ttlMs'", 'e.g. ok://a']);
  assert.equal(f.fix, 'Add cacheScope, ttlMs to the resources/read result (2026-07-28 requires cache hints on it, SEP-2549).');
  assert.deepEqual(r.unreadable, []);
  // The version negotiated decides what's required: 2025-11-25 has no cache hints.
  assert.deepEqual((await read({ LIST: 'ok://a,ok://b', NO_HINTS: 1, LEGACY: 1 })).all, []);
});

test('lists/resource-read-schema: an item with neither text nor blob', async () => {
  for (const pairs of [{ LIST: 'ok://a,bare://b' }, { LIST: 'ok://a,bare://b', LEGACY: 1 }]) {
    const r = await read(pairs);
    assert.equal(r.schema.length, 1);
    assert.equal(r.schema[0].severity, 'error');
    assert.match(r.schema[0].message, /^The resources\/read result for bare:\/\/b doesn't match the official 20\d\d-\d\d-\d\d schema/);
    assert.deepEqual(r.schema[0].detail, ['/contents/0 must have text or blob']);
    assert.equal(r.schema[0].fix, 'Fix /contents/0 first (must have text or blob), then rerun.');
  }
});

test('lists/resource-read-schema: a result the schema accepts and the official SDK client refuses', async () => {
  const r = await read({ LIST: 'ok://a', RESULT_TYPE: 'done' });
  assert.equal(r.schema.length, 1);
  assert.equal(r.schema[0].severity, 'error');
  assert.match(r.schema[0].message, /^The official MCP SDK client rejected the resources\/read result for ok:\/\/a, so clients built on it can't read it\. The result does match the 2026-07-28 schema; the SDK said: /);
  assert.equal(r.schema[0].fix, 'Fix what the SDK names above, then read the resource with the official client to confirm.');
  assert.deepEqual(r.unreadable, []);
});

test("lists/resource-unread: failures that are the run's (credentials, in an error or in a body) are info, never unreadable", async () => {
  const r = await read({ LIST: 'ok://a,auth://a,softkey://k' });
  assert.deepEqual(r.unreadable, []);
  assert.equal(r.unread.length, 1);
  const [f] = r.unread;
  assert.equal(f.severity, 'info');
  assert.equal(f.message, "resources/read wasn't checked for 2 of 3 listed resources (1 checked), so no finding about them doesn't mean they can be read.");
  assert.deepEqual(f.detail, ['2: need credentials this run lacks (auth://a and softkey://k)']);
  assert.equal(f.fix, 'Rerun with the credentials the resources need (--header, --env) to check them.');
});

test('lists/resource-unread: a rate limit stops the reads; the rest are counted, not asked for', async () => {
  const dir = tempDir();
  const seen = join(dir, 'reads.txt');
  const r = await read({ LIST: 'ok://a,rate://r,slow://s', COUNT_FILE: seen });
  assert.deepEqual(r.unreadable, []);
  assert.deepEqual(r.unread[0].detail, ['2: the server refused for too many requests, so toolmenu stopped reading (rate://r and slow://s)']);
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['ok://a', 'rate://r']);
});

test('lists/resource-unread: a read that times out, and the time for the reads running out', async () => {
  const r = await read({ LIST: 'ok://a,slow://s,slow://t,slow://u' }, ['--timeout', '1000'], { env: { TOOLMENU_READ_BUDGET_MS: '1500' } });
  assert.deepEqual(r.unreadable, []);
  assert.deepEqual(r.json.resourcesRead, { read: 3, listed: 4 });
  assert.equal(r.unread[0].message, "resources/read wasn't checked for 3 of 4 listed resources (1 checked), so no finding about them doesn't mean they can be read.");
  assert.deepEqual(r.unread[0].detail, ["2: didn't answer in time (slow://s and slow://t)", '1: the time for the reads ran out (slow://u)']);
});

test('lists/resource-unread: an InputRequiredResult, a web URL, a declared size, a resource gone from the second list', async () => {
  const r = await read({ LIST: 'ok://a,input://i,https://example.com/x,ok://big,ok://gone', SIZE: 'ok://big', GONE: 'ok://gone' });
  assert.deepEqual(r.unreadable, []);
  assert.deepEqual(r.schema, []);
  assert.deepEqual(r.unread[0].detail.sort(), [
    '1: gone from the list by its second reading (ok://gone)',
    '1: http(s) URLs, which a client fetches itself (https://example.com/x)',
    '1: the listing declares a size too large to read (ok://big)',
    '1: the server asked for input first (InputRequiredResult) (input://i)',
  ]);
  assert.equal(r.unread[0].fix, 'Nothing to change on the server for this.');
});

test('--max-reads: that many, spread over the sorted list, and the rest counted', async () => {
  assert.deepEqual(spread([...'abcdefghijkl'], 5), [...'acfil']);
  assert.deepEqual(spread([...'abcdefghijkl'], 1), ['f']);
  assert.deepEqual(spread([...'abc'], 2), ['a', 'c']);
  assert.deepEqual(spread([...'abc'], 7), [...'abc']);
  const dir = tempDir();
  const seen = join(dir, 'reads.txt');
  const list = [...'lkjihgfedcba'].map((c) => `ok://${c}`).join(',');
  const r = await read({ LIST: list, COUNT_FILE: seen }, ['--max-reads', '5']);
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['ok://a', 'ok://c', 'ok://f', 'ok://i', 'ok://l']);
  assert.deepEqual(r.json.resourcesRead, { read: 5, listed: 12 });
  assert.deepEqual(r.unread[0].detail, ['7: over --max-reads (ok://b, ok://d, ok://e and 4 more)']);
  writeFileSync(seen, '');
  await read({ LIST: list, COUNT_FILE: seen }, ['--max-reads', '1']);
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['ok://f']);
});

test('a URI listed twice is read once', async () => {
  const dir = tempDir();
  const seen = join(dir, 'reads.txt');
  const r = await read({ LIST: 'ok://a,ok://b,ok://a', COUNT_FILE: seen });
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['ok://a', 'ok://b']);
  assert.deepEqual(r.json.resourcesRead, { read: 2, listed: 2 });
});

test('ui:// resources: one a tool names is apps/resource\'s (read once); one no tool names, or any with apps/resource off, is read here', async () => {
  const dir = tempDir();
  const seen = join(dir, 'reads.txt');
  const r = await read({ LIST: 'ok://a,ui://app/named,ui://app/free', NAMED: 'ui://app/named', COUNT_FILE: seen });
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n').sort(), ['ok://a', 'ui://app/free', 'ui://app/named']);
  assert.deepEqual(r.json.resourcesRead, { read: 2, listed: 2, byApps: 1 });
  assert.deepEqual(r.all, []);
  const text = await snap(['--lists', 'resources', '--read-resources', ...env({ LIST: 'ok://a,ui://app/named,ui://app/free', NAMED: 'ui://app/named' })]);
  assert.match(text.stdout, /\n {2}resources\/read: 2 of 2 listed resources read \(1 more by the MCP Apps check\)\n/);
  // A named one that can't be read: one finding, apps/resource's.
  const broken = await read({ LIST: 'ok://a,ui://missing/app', NAMED: 'ui://missing/app' });
  assert.deepEqual(broken.all, []);
  assert.equal(broken.json.findings.filter((f) => f.rule === 'apps/resource').length, 1);
  // apps/resource off: nothing else reads it, so this pass does.
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ rules: { 'apps/resource': 'off' } }));
  const off = await read({ LIST: 'ok://a,ui://missing/app', NAMED: 'ui://missing/app' }, [], { cwd: dir });
  assert.equal(off.unreadable.length, 1);
  assert.match(off.unreadable[0].message, /^resources\/list names ui:\/\/missing\/app, but resources\/read of it failed/);
});

test('no body text reaches any output or the menu file', async () => {
  const dir = tempDir();
  const out = join(dir, 'menu.json');
  const args = ['--lists', 'resources', '--read-resources', ...env({ LIST: 'secret://s,soft://x,ok://a' })];
  for (const format of ['text', 'json', 'markdown', 'sarif', 'junit']) {
    const r = await run(['snapshot', '--out', out, '--format', format, '--html', join(dir, 'r.html'), ...args, '--', process.execPath, server], { cwd: dir });
    assert.ok(!(r.stdout + r.stderr).includes(MARKER), format);
  }
  assert.ok(!readFileSync(out, 'utf8').includes(MARKER));
  assert.ok(!readFileSync(join(dir, 'r.html'), 'utf8').includes(MARKER));
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).resourceReads, undefined, 'the reads are not part of the menu file');
});

test('nothing is read without the flag, when the three rules are off, or when resources/list failed', async () => {
  const dir = tempDir();
  const seen = join(dir, 'reads.txt');
  await snap(['--json', '--lists', 'resources', ...env({ COUNT_FILE: seen })]);
  assert.ok(!existsSync(seen), 'no --read-resources, no read');
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ rules: { 'lists/resource-unreadable': 'off', 'lists/resource-read-schema': 'off', 'lists/resource-unread': 'off' } }));
  const off = await read({ LIST: 'ok://a,missing://x', COUNT_FILE: seen }, [], { cwd: dir });
  assert.ok(!existsSync(seen), 'all three rules off, no read');
  assert.deepEqual(off.all, []);
  assert.equal(off.json.resourcesRead, undefined);
  // The list couldn't be read: there's nothing to read from, and lists/schema says why.
  const failed = await read({ FAIL_LIST: 1, COUNT_FILE: seen });
  assert.ok(!existsSync(seen), 'resources/list failed, no read');
  assert.deepEqual(failed.all, []);
  assert.equal(failed.json.resourcesRead, undefined);
  assert.equal(failed.json.findings.filter((f) => f.rule === 'lists/schema' && f.severity === 'warn').length, 1);
  // One rule on is enough to read.
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ rules: { 'lists/resource-unreadable': 'off', 'lists/resource-unread': 'off' } }));
  await read({ COUNT_FILE: seen }, [], { cwd: dir });
  assert.equal(readFileSync(seen, 'utf8').trim().split('\n').length, 2);
});

test('a server that lists no resources: quiet', async () => {
  const r = await read({ LIST: '' });
  assert.deepEqual(r.all, []);
  assert.deepEqual(r.json.resourcesRead, { read: 0, listed: 0 });
});

test('usage: --read-resources needs resources in --lists; --max-reads needs --read-resources; the config can set both', async () => {
  const none = await snap(['--read-resources']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^toolmenu: --read-resources reads what resources\/list names, so it needs that list\.\n {2}→ Next: add --lists resources \(or "lists": \["resources"\] in the config\)\./);
  assert.equal((await snap(['--lists', 'prompts', '--read-resources'])).code, 2);
  const max = await snap(['--lists', 'resources', '--max-reads', '3']);
  assert.equal(max.code, 2);
  assert.match(max.stderr, /--max-reads goes with --read-resources\./);
  assert.match((await snap(['--lists', 'resources', '--read-resources', '--max-reads', '0'])).stderr, /--max-reads must be a whole number, 1 or more/);
  const other = await run(['diff', 'a.json', 'b.json', '--read-resources']);
  assert.equal(other.code, 2);
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ lists: ['resources'], readResources: true, maxReads: 1 }));
  const fromConfig = JSON.parse((await snap(['--json'], { cwd: dir })).stdout);
  assert.deepEqual(fromConfig.resourcesRead, { read: 1, listed: 2 });
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ readResources: true }));
  const bad = await snap(['--json'], { cwd: dir });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /readResources \(in the config\) reads what resources\/list names/);
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ maxReads: 0 }));
  assert.match((await snap(['--json'], { cwd: dir })).stderr, /maxReads must be a whole number, 1 or more/);
});
