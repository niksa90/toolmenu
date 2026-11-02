// Menus that vary by credentials (2026-07-28: the tool set MAY vary by authorization),
// end to end: snapshot --as lists a fixture server once per identity (an env var on
// stdio) and compares each menu with the first identity's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, menuOf, run, tempDir, tool } from './helpers.mjs';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { asIdentity } from '../dist/probe.js';

const server = join(FIXTURES, 'identity-server.mjs');
const snap = (args) => run(['snapshot', ...args, '--', process.execPath, server]);
const findings = (r, rule) => JSON.parse(r.stdout).findings.filter((f) => f.rule === rule);

test('snapshot --as: what each identity adds, lacks or defines differently, against the first; the first is the menu saved', async () => {
  const dir = tempDir();
  const out = join(dir, 'menu.json');
  const r = await snap(['--json', '--out', out, '--as', 'reader:ROLE=reader', '--as', 'admin:ROLE=admin']);
  assert.equal(r.code, 0, 'a warning only: exit 0 at the default --fail-on error');
  const [variance] = findings(r, 'menu/auth-variance');
  assert.equal(variance.severity, 'info');
  assert.match(variance.message, /^The menu differs by identity: admin sees a different tool set than reader\. Allowed/);
  assert.deepEqual(variance.detail, ['admin: adds delete_item; 1 tool defined differently (get_item) (102 tokens, +40 against reader)']);
  assert.match(variance.fix, /snapshot --as admin:… --as reader:… --out menu\.admin\.json/);
  // The saved menu is reader's: two tools, no delete_item.
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).tools.map((t) => t.name), ['list_items', 'get_item']);

  const [scope] = findings(r, 'spec/cache-scope-public');
  assert.equal(scope.severity, 'warn');
  assert.match(scope.message, /^tools\/list says cacheScope: "public", but the tool set differs by identity\./);
  assert.match(scope.fix, /cacheScope: "private"/);
});

test('snapshot --as: the main identity decides the menu saved, the others are compared with it', async () => {
  const r = await snap(['--json', '--no-write', '--as', 'admin:ROLE=admin', '--as', 'reader:ROLE=reader']);
  const [variance] = findings(r, 'menu/auth-variance');
  assert.deepEqual(variance.detail, ['reader: lacks delete_item; 1 tool defined differently (get_item) (62 tokens, -40 against admin)']);
});

test('snapshot --as: identical menus are quiet; a private list is not a cache-scope finding; 2025 servers get no cache-scope finding', async () => {
  const same = await snap(['--json', '--no-write', '--as', 'a:ROLE=reader', '--as', 'b:ROLE=reader']);
  assert.deepEqual([...findings(same, 'menu/auth-variance'), ...findings(same, 'spec/cache-scope-public')], []);
  const priv = await snap(['--json', '--no-write', '--env', 'SCOPE=private', '--as', 'reader:ROLE=reader', '--as', 'admin:ROLE=admin']);
  assert.equal(findings(priv, 'menu/auth-variance').length, 1);
  assert.deepEqual(findings(priv, 'spec/cache-scope-public'), []);
  const legacy = await snap(['--json', '--no-write', '--env', 'LEGACY=1', '--as', 'reader:ROLE=reader', '--as', 'admin:ROLE=admin']);
  assert.equal(findings(legacy, 'menu/auth-variance').length, 1, 'menus can vary by credentials on any protocol');
  assert.deepEqual(findings(legacy, 'spec/cache-scope-public'), []);
});

test('snapshot --as: an identity that can\'t be listed is said, and the rest are still compared', async () => {
  const r = await snap(['--json', '--no-write', '--as', 'reader:ROLE=reader', '--as', 'admin:ROLE=admin', '--as', 'banned:ROLE=banned']);
  const all = findings(r, 'menu/auth-variance');
  assert.equal(all.length, 2);
  assert.match(all[1].message, /^banned couldn't be listed, so its menu is not compared \(The server exited with code 1 before it answered initialize\)\.$/);
  assert.deepEqual(all[0].detail, ['admin: adds delete_item; 1 tool defined differently (get_item) (102 tokens, +40 against reader)']);
});

test('snapshot: identities from the config file; --as replaces them', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ identities: { reader: { env: { ROLE: 'reader' } }, admin: { env: { ROLE: 'admin' } } } }));
  const fromConfig = await run(['snapshot', '--json', '--no-write', '--', process.execPath, server], { cwd: dir });
  assert.equal(findings(fromConfig, 'menu/auth-variance').length, 1);
  const replaced = await run(['snapshot', '--json', '--no-write', '--as', 'a:ROLE=reader', '--as', 'b:ROLE=reader', '--', process.execPath, server], { cwd: dir });
  assert.deepEqual(findings(replaced, 'menu/auth-variance'), []);
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ identities: { reader: { env: { ROLE: 1 } } } }));
  const bad = await run(['snapshot', '--config', join(dir, 'bad.json'), '--', process.execPath, server], { cwd: dir });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /identities\.reader must be \{ "headers": \{ … \} \} or \{ "env": \{ … \} \}, with string values/);
});

test('--as: usage errors', async () => {
  const one = await snap(['--as', 'reader:ROLE=reader']);
  assert.equal(one.code, 2);
  assert.match(one.stderr, /--as needs two identities or more to compare/);
  const session = await run(['session', '--auto', '--as', 'a:X=1', '--as', 'b:X=2', '--', process.execPath, server]);
  assert.equal(session.code, 2);
  assert.match(session.stderr, /--as goes with snapshot/);
  const noName = await snap(['--as', ':ROLE=reader', '--as', 'b:ROLE=admin']);
  assert.equal(noName.code, 2);
  assert.match(noName.stderr, /should start with a name/);
  const badPair = await snap(['--as', 'reader:ROLE', '--as', 'b:ROLE=admin']);
  assert.equal(badPair.code, 2);
  assert.match(badPair.stderr, /should look like KEY=VALUE/);
});

test('asIdentity: an identity\'s headers (HTTP) or env (stdio) go over the ones every run gets', () => {
  const http = asIdentity({ kind: 'http', url: 'https://x.test/mcp', headers: { 'X-Team': 'a', Authorization: 'Bearer base' } }, { name: 'admin', headers: { Authorization: 'Bearer admin' } });
  assert.deepEqual(http.headers, { 'X-Team': 'a', Authorization: 'Bearer admin' });
  const stdio = asIdentity({ kind: 'stdio', command: 'node', args: [], env: { A: '1' } }, { name: 'admin', env: { ROLE: 'admin' } });
  assert.deepEqual(stdio.env, { A: '1', ROLE: 'admin' });
});

test('spec/cache-hints: with identities to compare, the public-scope hint gives way to the finding with evidence', () => {
  const ctx = (identities) => ({
    menu: menuOf([tool('a')], {}, { ttlMs: 60_000, cacheScope: 'public' }),
    pages: [],
    capabilities: { tools: {} },
    usedAuth: true,
    protocolVersion: '2026-07-28',
    era: 'modern',
    ...(identities ? { identities } : {}),
  });
  const hint = (c) => runRules(MENU_RULES, c).filter((f) => f.rule === 'spec/cache-hints' && /cacheScope/.test(f.message));
  assert.equal(hint(ctx()).length, 1);
  const same = [{ name: 'a', tools: [tool('a')], tokens: 1, cacheScope: 'public' }, { name: 'b', tools: [tool('a')], tokens: 1, cacheScope: 'public' }];
  assert.equal(hint(ctx(same)).length, 0);
});

// 0.17.1, from the review of 0.17.
test('asIdentity: header names match whatever their case, so the identity\'s credential is the only one sent', () => {
  const t = asIdentity({ kind: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer base', 'X-Team': 'a' } }, { name: 'admin', headers: { authorization: 'Bearer admin' } });
  assert.deepEqual(t.headers, { 'X-Team': 'a', authorization: 'Bearer admin' });
});

test('snapshot: a config identity with credentials only for the other kind of server is a usage error, not a silent no-op', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ identities: { reader: { headers: { Authorization: 'Bearer r' } }, admin: { env: { ROLE: 'admin' } } } }));
  const r = await run(['snapshot', '--no-write', '--', process.execPath, server], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /identities reader in the config give headers only, and this is a stdio server: give each "env"\./);
});
