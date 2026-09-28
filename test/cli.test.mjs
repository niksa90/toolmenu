import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, ROOT, run, tempDir } from './helpers.mjs';
import { start } from './fixtures/http-server.mjs';

const sdkServer = ['--', process.execPath, join(FIXTURES, 'sdk-server.mjs')];
const raw = (fixture) => ['--env', `FIXTURE=${fixture}`, '--', process.execPath, join(FIXTURES, 'raw-server.mjs')];

test('snapshot of a 2026-07-28 stdio server writes menu.json and exits 0', async () => {
  const r = await run(['snapshot', ...sdkServer]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /protocol 2026-07-28 · 3 tools/);
  const menu = JSON.parse(readFileSync(join(r.cwd, 'menu.json'), 'utf8'));
  assert.equal(menu.toolmenu, 1);
  assert.deepEqual(menu.tools.map((t) => t.name), ['search_forms', 'get_form', 'delete_form']);
  assert.equal(menu.server.era, 'modern');
  assert.equal(menu.listMeta.cacheScope, 'private');
  assert.ok(menu.tools.every((t) => t.tokens > 0));
  assert.equal(menu.totalTokens, menu.tools.reduce((s, t) => s + t.tokens, 0));
});

test('a 2025-era server is reported, and 2026 rules are skipped', async () => {
  const r = await run(['snapshot', '--no-write', '--json', '--env', 'LEGACY=1', ...sdkServer]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.server.protocolVersion, '2025-11-25');
  assert.deepEqual(out.findings.map((f) => f.rule), ['spec/discover']);
  assert.ok(!existsSync(join(r.cwd, 'menu.json')));
});

test('snapshot over Streamable HTTP, with a header', async () => {
  const server = await start();
  try {
    const r = await run(['snapshot', '--no-write', '--json', '--header', 'Authorization: Bearer t0ken', server.url]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.server.protocolVersion, '2026-07-28');
    assert.equal(out.tools, 3);
    assert.ok(server.seen.authorization.includes('Bearer t0ken'));
  } finally {
    await server.close();
  }
});

test('an unstable order fails the run', async () => {
  const r = await run(['snapshot', '--no-write', ...raw('shuffle')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERROR  menu\/nondeterministic/);
  assert.match(r.stdout, /different order/);
});

test('a description that changes between calls fails the run', async () => {
  const r = await run(['snapshot', '--no-write', ...raw('drift')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /description changed: get_time/);
});

test('a result the SDK rejects is still read and reported against the schema', async () => {
  const r = await run(['snapshot', '--no-write', ...raw('badschema')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERROR  spec\/schema/);
  assert.match(r.stdout, /required property 'inputSchema'/);
  assert.match(r.stdout, /official MCP SDK client rejects/);
});

test('warnings pass by default and fail with --fail-on warn', async () => {
  const r = await run(['snapshot', '--no-write', ...raw('smells')]);
  assert.equal(r.code, 0, r.stderr);
  for (const rule of ['naming/vague-id', 'ids/authored', 'write/unannotated', 'write/no-dry-run', 'naming/shared-word']) {
    assert.match(r.stdout, new RegExp(rule));
  }
  const strict = await run(['snapshot', '--no-write', '--fail-on', 'warn', ...raw('smells')]);
  assert.equal(strict.code, 1);
});

test('routes.yml pins the audit collision', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'routes.yml'), 'audit:\n  must_match: [list_team_audits]\n  must_not_match: [get_audit_trail]\n');
  const r = await run(['snapshot', '--no-write', '--routes', 'routes.yml', ...raw('smells')], { cwd });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERROR  naming\/route/);
  assert.match(r.stdout, /"audit" matches get_audit_trail/);
});

test('config file changes severities', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ rules: { 'naming/vague-id': 'error' } }));
  const r = await run(['snapshot', '--no-write', ...raw('smells')], { cwd });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERROR  naming\/vague-id/);
});

test('github format prints workflow annotations', async () => {
  const r = await run(['snapshot', '--no-write', '--format', 'github', ...raw('shuffle')]);
  assert.match(r.stdout, /^::error title=toolmenu menu\/nondeterministic::/m);
});

test('usage errors exit 2', async () => {
  assert.equal((await run(['snapshot'])).code, 2);
  assert.equal((await run(['snapshot', 'not-a-url'])).code, 2);
  assert.equal((await run(['session', 'x'])).code, 2, 'session without --scenario');
  assert.equal((await run(['snapshot', '--format', 'xml', 'http://x'])).code, 2);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['--help'])).code, 0);
});

test('a server that fails to start exits 2 with a message', async () => {
  const r = await run(['snapshot', '--no-write', '--timeout', '5000', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: /);
});

test('cli: a broken config file is named in the error', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), '{"rules": {');
  const r = await run(['diff', 'a.json', 'b.json'], { cwd });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /toolmenu\.config\.json: /);
});

test('cli: --version is package.json\'s version', async () => {
  const r = await run(['--version']);
  assert.equal(r.stdout.trim(), JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
});
