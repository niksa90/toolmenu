import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, ROOT, run, tempDir } from './helpers.mjs';
import { start } from './fixtures/http-server.mjs';
import { start as startRaw } from './fixtures/raw-http-server.mjs';

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

test('cli: snapshot, session --init and --auto wait out a rate limit, and say so when it outlasts the waits', async () => {
  const env = { TOOLMENU_RATE_LIMIT_WAITS_MS: '150,300' };
  const commands = [['snapshot', '--no-write', '--json'], ['session', '--init'], ['session', '--auto']];
  // Refused from the first request for 100 ms: each is waited out.
  for (const args of commands) {
    const server = await start({ limit: 0, resetAfterMs: 100 });
    try {
      const r = await run([...args, server.url], { env });
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.ok(server.seen.refused > 0, args.join(' '));
    } finally {
      await server.close();
    }
  }
  // Refused throughout: the explanation, not the transport's error.
  for (const args of commands) {
    // The refusal as a JSON-RPC body: its message is quoted, not the JSON.
    const server = await start({ limit: 0, json: true });
    try {
      const r = await run([...args, server.url], { env });
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /^toolmenu: Rate-limited while connecting, and still after waiting 0\.5 s: “Too many requests — retry later”\. The limit counts every request from this address/, args.join(' '));
      assert.doesNotMatch(r.stderr, /Error POSTing|jsonrpc/, args.join(' '));
    } finally {
      await server.close();
    }
  }
});

test('--json stays valid JSON when a library logs, and a missing tools capability is an error', async () => {
  const r = await run(['snapshot', '--json', '--no-write', '--processes', '1', '--env', 'NO_TOOLS_CAPABILITY=1', ...raw('clean')]);
  assert.equal(r.code, 1, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.tools, 0);
  assert.ok(report.findings.some((f) => f.rule === 'spec/tools-capability' && f.severity === 'error'));
  assert.match(r.stderr, /does not advertise tools capability/, 'the SDK line went to stderr');
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
  assert.match(r.stdout, /get_time: description: "Get the time. Generated at call 1." vs "Get the time. Generated at call 2."/);
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

test('snapshot: a menu that differs per process is caught, and says what differs', async () => {
  const r = await run(['snapshot', '--no-write', ...raw('seedorder')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERROR  menu\/process-variance/);
  assert.match(r.stdout, /get_issue: inputSchema\.properties\.fields\.default: same 5 items, different order/);
  assert.match(r.stdout, /PYTHONHASHSEED=0/);
  // The main process is pinned: two snapshots save the same menu.
  const [a, b] = await Promise.all([1, 2].map(async () => {
    const cwd = tempDir();
    await run(['snapshot', '--processes', '1', ...raw('seedorder')], { cwd });
    return JSON.parse(readFileSync(join(cwd, 'menu.json'), 'utf8')).tools;
  }));
  assert.deepEqual(a, b);
});

test('snapshot: --processes 1 turns the check off; a stable server passes it', async () => {
  const off = await run(['snapshot', '--no-write', '--processes', '1', ...raw('seedorder')]);
  assert.doesNotMatch(off.stdout, /process-variance/);
  const clean = await run(['snapshot', '--no-write', ...raw('clean')]);
  assert.doesNotMatch(clean.stdout, /process-variance/);
  const bad = await run(['snapshot', '--no-write', '--processes', '0', ...raw('clean')]);
  assert.equal(bad.code, 2);
});

test('snapshot over http: a menu that differs per connection is caught', async () => {
  const server = await startRaw({ vary: true });
  try {
    const r = await run(['snapshot', '--no-write', server.url]);
    assert.match(r.stdout, /menu\/connection-variance/);
  } finally {
    await server.close();
  }
});


test('--protocol legacy checks a dual-era server as a 2025 server', async () => {
  const r = await run(['snapshot', '--no-write', '--json', '--protocol', 'legacy', ...sdkServer]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.server.protocolVersion, '2025-11-25');
  assert.equal(out.server.era, 'legacy');
  assert.deepEqual(out.findings.map((f) => f.rule), ['spec/discover']);
});

test('--protocol modern pins 2026-07-28, and says what to do when the server lacks it', async () => {
  const ok = await run(['snapshot', '--no-write', '--json', '--protocol', 'modern', ...sdkServer]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).server.protocolVersion, '2026-07-28');
  const bad = await run(['snapshot', '--no-write', '--protocol', 'modern', '--env', 'LEGACY=1', ...sdkServer]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /doesn't speak the 2026-07-28 protocol/);
  assert.match(bad.stderr, /→ Next: .*--protocol auto/);
});

test('--protocol and the config file: the flag wins, and a bad value is a usage error', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ protocol: 'legacy' }));
  const fromConfig = await run(['snapshot', '--no-write', '--json', ...sdkServer], { cwd: dir });
  assert.equal(JSON.parse(fromConfig.stdout).server.era, 'legacy');
  const flag = await run(['snapshot', '--no-write', '--json', '--protocol', 'auto', ...sdkServer], { cwd: dir });
  assert.equal(JSON.parse(flag.stdout).server.era, 'modern');
  const bad = await run(['snapshot', '--protocol', 'old', ...sdkServer]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--protocol must be auto, legacy or modern/);
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ protocol: 'old' }));
  const badConfig = await run(['snapshot', '--no-write', ...sdkServer], { cwd: dir });
  assert.equal(badConfig.code, 2);
  assert.match(badConfig.stderr, /protocol must be auto, legacy or modern/);
});
