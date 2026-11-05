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

// 0.21: behind a proxy, a stdio server that calls an API at startup failed with nothing
// to say why (Stripe, Supabase): only PATH, HOME and the like reached it.
test('stdio servers get this machine\'s proxy and CA settings, and nothing else from it', async () => {
  const dir = tempDir();
  const out = join(dir, 'menu.json');
  // This machine's own settings cleared, so only these reach the CLI.
  const env = { HTTPS_PROXY: 'http://proxy.test:3128', HTTP_PROXY: '', https_proxy: '', http_proxy: '', NO_PROXY: 'localhost', no_proxy: '', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', SSL_CERT_FILE: '', SECRET_TOKEN: 'not-for-the-server' };
  const r = await run(['snapshot', '--out', out, '--processes', '1', '--', process.execPath, join(FIXTURES, 'env-server.mjs')], { env: { ...env, NODE_USE_ENV_PROXY: '' } });
  assert.equal(r.code, 0, r.stderr);
  const seen = JSON.parse(JSON.parse(readFileSync(out, 'utf8')).tools[0].description);
  assert.deepEqual(seen, { HTTPS_PROXY: 'http://proxy.test:3128', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' });
  // --env still wins.
  const own = join(dir, 'own.json');
  await run(['snapshot', '--out', own, '--processes', '1', '--env', 'HTTPS_PROXY=http://other.test:8080', '--', process.execPath, join(FIXTURES, 'env-server.mjs')], { env: { ...env, NODE_USE_ENV_PROXY: '' } });
  assert.equal(JSON.parse(JSON.parse(readFileSync(own, 'utf8')).tools[0].description).HTTPS_PROXY, 'http://other.test:8080');
});

// 0.21: Atlassian Rovo answered any Authorization header with a menu, not 401.
test('auth/invalid-accepted: a server that serves a menu to an invalid credential, not one that refuses it', async () => {
  const serving = await start({ auth: { token: 'good', onBad: 'serve' } });
  const refusing = await start({ auth: { token: 'good', onBad: 'refuse' } });
  try {
    const snap = async (url, extra = []) => JSON.parse((await run(['snapshot', '--no-write', '--json', '--no-auth', ...extra, url])).stdout);
    const bad = await snap(serving.url, ['--header', 'Authorization: Bearer good']);
    const [f] = bad.findings.filter((x) => x.rule === 'auth/invalid-accepted');
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /^With an invalid credential in place of this run's, the server served the same \d+ tools instead of refusing \(401\)\./);
    // The probe sent a credential that can't be valid, in the same scheme.
    assert.ok(serving.seen.authorization.includes('Bearer toolmenu-invalid-credential'));
    const good = await snap(refusing.url, ['--header', 'Authorization: Bearer good']);
    assert.deepEqual(good.findings.filter((x) => x.rule === 'auth/invalid-accepted'), []);
    // --processes 1 opens no extra connection, this probe included.
    const before = refusing.seen.authorization.length;
    await snap(refusing.url, ['--header', 'Authorization: Bearer good', '--processes', '1']);
    assert.ok(!refusing.seen.authorization.slice(before).includes('Bearer toolmenu-invalid-credential'));
  } finally {
    await serving.close();
    await refusing.close();
  }
});

test('withInvalidCredential: same scheme, every credential header, other headers kept', async () => {
  const { withInvalidCredential } = await import('../dist/snapshot.js');
  const t = withInvalidCredential({ kind: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Basic dTpw', 'X-Api-Key': 'k', 'X-Team': 'a' } });
  assert.equal(t.headers.Authorization, `Basic ${Buffer.from('toolmenu-invalid:toolmenu-invalid').toString('base64')}`);
  assert.equal(t.headers['X-Api-Key'], 'toolmenu-invalid-credential');
  assert.equal(t.headers['X-Team'], 'a');
  assert.equal(t.noAuth, true);
  // A stored login (no header of its own) gets an invalid Bearer token.
  assert.equal(withInvalidCredential({ kind: 'http', url: 'https://x.test/mcp' }).headers.Authorization, 'Bearer toolmenu-invalid-credential');
});

// 0.22, from the 0.21 corpus run: inite-visibility serves 3 tools offline, 10 online.
test('snapshot --offline-check: a menu that depends on the network; a server that needs it to start; quiet when the same', async () => {
  const { createServer } = await import('node:http');
  // "The network": a host only a proxy reaches. The main process is given the proxy
  // (--env); the offline process gets the dead one in its place, --env or not.
  const remote = createServer((req, res) => {
    res.statusCode = /^remote\.test(:\d+)?$/.test(req.headers.host ?? '') ? 200 : 404;
    res.end();
  });
  // Node's proxy agent tunnels plain HTTP too: answer CONNECT, then serve the tunnel here.
  remote.on('connect', (req, sock) => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    remote.emit('connection', sock);
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  const REMOTE_URL = 'http://remote.test/';
  const proxy = `http://127.0.0.1:${remote.address().port}`;
  const fixture = join(FIXTURES, 'network-server.mjs');
  const env = {};
  // Both spellings: Node reads the lowercase one first, and the machine running the tests may set it.
  const via = ['--env', `REMOTE_URL=${REMOTE_URL}`, '--env', `HTTP_PROXY=${proxy}`, '--env', `http_proxy=${proxy}`, '--env', 'NODE_USE_ENV_PROXY=1'];
  const snap = async (more = []) => JSON.parse((await run(['snapshot', '--no-write', '--json', '--processes', '1', '--offline-check', ...via, ...more, '--', process.execPath, fixture], { env })).stdout).findings.filter((f) => f.rule === 'menu/network-dependent');
  try {
    const [f] = await snap();
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /^With the network cut off, the server serves a different menu: 1 tool, not 2 \(1 missing\)\./);
    assert.deepEqual(f.detail, ['missing offline: remote_rules']);
    const [g] = await snap(['--env', 'REQUIRE=1']);
    assert.equal(g.severity, 'info');
    assert.match(g.message, /^The server didn't start or list its tools with the network cut off: the server exited with code 1/);
    // Not asked for: not run.
    const none = JSON.parse((await run(['snapshot', '--no-write', '--json', '--processes', '1', ...via, '--', process.execPath, fixture], { env })).stdout);
    assert.equal(none.findings.filter((x) => x.rule === 'menu/network-dependent').length, 0);
    // Loopback isn't the network: a server that reaches 127.0.0.1 directly keeps its menu.
    const local = createServer((req, res) => res.end('ok'));
    await new Promise((r) => local.listen(0, '127.0.0.1', r));
    const direct = JSON.parse((await run(['snapshot', '--no-write', '--json', '--processes', '1', '--offline-check', '--env', `REMOTE_URL=http://127.0.0.1:${local.address().port}/`, '--', process.execPath, fixture], { env })).stdout);
    local.close();
    assert.deepEqual(direct.findings.filter((x) => x.rule === 'menu/network-dependent'), [], 'a local helper on loopback');
    // A server that fetches nothing: quiet.
    assert.deepEqual(JSON.parse((await run(['snapshot', '--no-write', '--json', '--processes', '1', '--offline-check', '--', process.execPath, join(FIXTURES, 'client-server.mjs')])).stdout).findings.filter((x) => x.rule === 'menu/network-dependent'), []);
    // The config key, for scan too.
    const dir = tempDir();
    writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ offlineCheck: true }));
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { net: { command: process.execPath, args: [fixture], env: { REMOTE_URL, HTTP_PROXY: proxy, http_proxy: proxy, NODE_USE_ENV_PROXY: '1' } } } }));
    const scanned = JSON.parse((await run(['scan', '--json', '--processes', '1', 'mcp.json'], { cwd: dir, env })).stdout);
    assert.ok(scanned.servers[0].findings.some((x) => x.rule === 'menu/network-dependent'));
    writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ offlineCheck: 'yes' }));
    assert.match((await run(['snapshot', '--no-write', '--', process.execPath, fixture], { cwd: dir })).stderr, /offlineCheck must be true or false/);
    const http = await run(['snapshot', '--offline-check', 'https://example.com/mcp']);
    assert.equal(http.code, 2);
    assert.match(http.stderr, /--offline-check goes with a stdio server/);
  } finally {
    remote.close();
  }
});

// 0.22, from running github-mcp-server 1.14: delete_repository is listed only to clients with elicitation.
test('menu/capability-dependent: a tool listed only to a client with elicitation is in the menu file, and said', async () => {
  const dir = tempDir();
  const out = join(dir, 'menu.json');
  const raw = join(FIXTURES, 'raw-server.mjs');
  const r = JSON.parse((await run(['snapshot', '--json', '--out', out, '--env', 'FIXTURE=confirm', '--', process.execPath, raw])).stdout);
  assert.equal(r.tools, 2);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).tools.map((t) => t.name), ['get_thing', 'delete_thing'], 'the baseline holds the tool');
  const [f] = r.findings.filter((x) => x.rule === 'menu/capability-dependent');
  assert.equal(f.severity, 'info');
  assert.equal(f.tool, 'delete_thing');
  assert.match(f.message, /^delete_thing is listed only to a client that supports elicitation \(can ask the user to confirm\)\. A client without elicitation gets 1 tool, not 2\./);
  // --processes 1 opens nothing more: not checked.
  const one = JSON.parse((await run(['snapshot', '--json', '--no-write', '--processes', '1', '--env', 'FIXTURE=confirm', '--', process.execPath, raw])).stdout);
  assert.equal(one.findings.filter((x) => x.rule === 'menu/capability-dependent').length, 0);
  // A server that lists the same either way: quiet.
  const same = JSON.parse((await run(['snapshot', '--json', '--no-write', '--env', 'FIXTURE=clean', '--', process.execPath, raw])).stdout);
  assert.equal(same.findings.filter((x) => x.rule === 'menu/capability-dependent').length, 0);
});

// 0.22, from the corpus run: under load mastra's version probe fell back to 2025 in the
// main process only, and the second process's 2026-07-28 menu read as process variance.
test('snapshot: a later process that ends on another protocol than the main one is asked again on that one', async () => {
  const dir = tempDir();
  const log = join(dir, 'methods.log');
  const r = await run(['snapshot', '--no-write', '--json', '--env', `LOG=${log}`, '--', process.execPath, join(FIXTURES, 'first-legacy-server.mjs')]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.server.protocolVersion, '2025-11-25');
  assert.match(out.findings.find((f) => f.rule === 'spec/discover').message, /^This connection fell back to protocol 2025-11-25: .* A later process got 2026-07-28, so the server speaks it/);
  // The first method each process got: the main one, then each later one negotiated
  // as usual (server/discover) and, having got 2026-07-28, asked again on 2025 (initialize).
  const [main, ...later] = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(main, 'server/discover');
  // (0.22 before this fix sent no initialize after the main process: every later one stayed on 2026-07-28.)
  assert.ok(later.filter((m) => m === 'initialize').length >= 2, `the variance probe and the capability listing, each asked again on 2025: ${later.join(', ')}`);
});

// 2026-11-05: an option another command takes was ignored without a word (scan --no-auth).
test('cli: an option for another command is ignored with a warning that names it', async () => {
  const dir = tempDir();
  const menu = join(dir, 'm.json');
  writeFileSync(menu, JSON.stringify({ toolmenu: 1, server: { name: 's', version: '1' }, tools: [] }));
  const r = await run(['diff', '--header', 'A: b', '--auto', menu, menu]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^toolmenu: diff ignores --timeout, --header, --auto: they are for other commands\.\n  → Next: Leave them out to silence this; toolmenu diff --help lists the options diff takes\.\n/);
  // The helper passes --timeout to every command; snapshot takes it, so only --release is named.
  const one = await run(['snapshot', '--release', '1.0.0', '--no-write', '--', process.execPath, join(FIXTURES, 'client-server.mjs')]);
  assert.match(one.stderr, /^toolmenu: snapshot ignores --release: it is for other commands\./);
});
