// toolmenu mcp: toolmenu as an MCP server. Its tools run the CLI, and its own menu
// passes toolmenu's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../dist/connect.js';
import { folder, savePath, serverArgs } from '../dist/mcp.js';
import { CLI, FIXTURES, ROOT, run, tempDir, TIMEOUT_MS } from './helpers.mjs';

const toolmenu = () => ({ kind: 'stdio', command: process.execPath, args: [CLI, 'mcp'] });
const textOf = (r) => r.content.map((c) => c.text).join('\n');

async function withServer(fn) {
  const conn = await connect(toolmenu(), { timeoutMs: TIMEOUT_MS });
  try {
    return await fn((name, args) => conn.client.callTool({ name, arguments: args }, { timeout: TIMEOUT_MS }));
  } finally {
    await conn.close();
  }
}

test('its own menu: no findings on either protocol, but the dry-run hint for the two tools that start a server', async () => {
  for (const protocol of ['modern', 'auto']) {
    const r = await run(['snapshot', '--no-write', '--format', 'json', '--protocol', protocol, '--', process.execPath, CLI, 'mcp']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.tools, 6);
    // snapshot_menu and check_session run a command, so they're marked destructive; a dry
    // run of "start this server and list its tools" isn't a thing, so this info stays.
    assert.deepEqual(report.findings.map((f) => [f.rule, f.severity]), [['write/no-dry-run', 'info']], r.stdout);
    assert.deepEqual(report.findings[0].detail, ['snapshot_menu, check_session']);
  }
});

test('the committed menu file and badge are this build\'s: CI diffs PRs against them', async () => {
  // Out of date, a PR that changes a tool's name, description or schema gets a diff of
  // someone else's change in its comment. Regenerate with the command in AGENTS.md.
  const dir = tempDir();
  const r = await run(['snapshot', '--out', join(dir, 'menu.json'), '--badge', join(dir, 'badge.json'), '--', process.execPath, CLI, 'mcp']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = await run(['diff', '--json', join(ROOT, 'docs/toolmenu-menu.json'), join(dir, 'menu.json')]);
  const diff = JSON.parse(d.stdout);
  assert.deepEqual(diff.findings, [], 'docs/toolmenu-menu.json differs from toolmenu mcp: rerun the snapshot in AGENTS.md');
  assert.deepEqual(Object.values(diff.classes).map((c) => c.changes), [0, 0, 0]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'badge.json'), 'utf8')).message, JSON.parse(readFileSync(join(ROOT, 'docs/toolmenu-badge.json'), 'utf8')).message);
});

test('snapshot_menu checks a stdio server and writes the menu only when asked', async () => {
  const cwd = tempDir();
  await withServer(async (call) => {
    const report = await call('snapshot_menu', { command: [process.execPath, join(FIXTURES, 'sdk-server.mjs')], cwd });
    assert.equal(report.isError, undefined, textOf(report));
    assert.match(textOf(report), /forms-fixture 1\.2\.3/);
    assert.ok(!existsSync(join(cwd, 'menu.json')), 'nothing written without save_as');

    const saved = await call('snapshot_menu', { command: [process.execPath, join(FIXTURES, 'sdk-server.mjs')], cwd, save_as: 'menu.json' });
    assert.equal(saved.isError, undefined, textOf(saved));
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'menu.json'), 'utf8')).tools.map((t) => t.name), ['search_forms', 'get_form', 'delete_form']);
  });
});

test('diff_menus: two releases of the filesystem server, paths from cwd', async () => {
  await withServer(async (call) => {
    const r = await call('diff_menus', { before: 'server-filesystem-2025.7.1.json', after: 'server-filesystem-2026.8.31.json', cwd: join(FIXTURES, 'menus') });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /tools {4}12 → 14/);
    assert.match(textOf(r), /diff\/tool-added/);
  });
});

test('review_baseline: the verdict on two releases of the filesystem server; exit 1 is the verdict, not a tool error', async () => {
  await withServer(async (call) => {
    const cwd = join(FIXTURES, 'menus');
    const r = await call('review_baseline', { baseline: 'server-filesystem-2026.1.14.json', candidate: 'server-filesystem-2026.8.31.json', cwd });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /verdict\s+✗ don't accept as is: 1 breaking change/);
    assert.match(textOf(r), /diff\/safety-hint/);
    assert.match(textOf(r), /Exit 1: the verdict is not to accept the new menu as it is\./);
    const same = await call('review_baseline', { baseline: 'server-filesystem-2026.8.31.json', candidate: 'server-filesystem-2026.8.31.json', cwd });
    assert.equal(same.isError, undefined, textOf(same));
    assert.match(textOf(same), /verdict\s+✓ unchanged/);
    assert.doesNotMatch(textOf(same), /Exit 1/);
    const missing = await call('review_baseline', { baseline: 'no-such-menu.json', candidate: 'server-filesystem-2026.8.31.json', cwd });
    assert.equal(missing.isError, true);
  });
});

test('check_auth runs auth check on an https URL; credentials in the URL, another scheme or an option are refused', async () => {
  await withServer(async (call) => {
    // Nothing listens there: the report says so as a finding, which is a report, not a tool error.
    const r = await call('check_auth', { url: 'https://127.0.0.1:9/mcp' });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /toolmenu auth check {2}https:\/\/127\.0\.0\.1:9\/mcp/);
    assert.match(textOf(r), /auth\/discovery/);
    for (const url of ['https://user:pass@example.com/mcp', 'http://example.com/mcp', 'file:///etc/passwd', '--format=json']) {
      const bad = await call('check_auth', { url });
      assert.equal(bad.isError, true, url);
      assert.doesNotMatch(textOf(bad), /user:pass@/);
    }
  });
});

test('explain_rule explains a rule, and a rule that does not exist is an error naming the closest', async () => {
  await withServer(async (call) => {
    const ok = await call('explain_rule', { rule: 'naming/vague-id' });
    assert.equal(ok.isError, undefined);
    assert.match(textOf(ok), /vague-id/);
    const bad = await call('explain_rule', { rule: 'vague-idd' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /No rule "vague-idd"/);
  });
});

test('a server that cannot start is a tool error with the reason, and the server keeps serving', async () => {
  await withServer(async (call) => {
    const r = await call('snapshot_menu', { command: ['definitely-not-a-command-toolmenu'] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /definitely-not-a-command-toolmenu/);
    assert.equal((await call('explain_rule', { rule: 'vague-id' })).isError, undefined);
  });
});

test('the server is named by command or url, one of the two', () => {
  assert.match(serverArgs({}).error, /command .* or url/);
  assert.match(serverArgs({ command: ['x'], url: 'https://e.com/mcp' }).error, /one of the two/);
  assert.match(serverArgs({ url: 'https://e.com/mcp', env: { A: '1' } }).error, /env goes with command/);
  assert.match(serverArgs({ command: ['x'], headers: { A: '1' } }).error, /headers go with url/);
  assert.match(serverArgs({ url: '--config=x.json' }).error, /http\(s\) URL/);
  // Credentials go in secret (the environment), never in argv.
  assert.deepEqual(serverArgs({ url: 'https://e.com/mcp', headers: { Authorization: 'Bearer t' } }), { before: ['https://e.com/mcp'], secret: ['--header', 'Authorization: Bearer t'], after: [] });
  // Credentials embedded in the URL would land in argv: refused, and not echoed back.
  for (const url of ['https://user@e.com/mcp', 'https://:pw@e.com/mcp', 'https://user:pw@e.com/mcp', 'http://user:pw@e.com/mcp']) {
    const r = serverArgs({ url });
    assert.match(r.error, /headers, not embedded in the URL/);
    assert.doesNotMatch(r.error, /pw|user@/);
  }
  assert.match(serverArgs({ url: 'https://' }).error, /not a valid URL/);
  assert.deepEqual(serverArgs({ url: 'https://e.com/mcp?x=1' }), { before: ['https://e.com/mcp?x=1'], secret: [], after: [] });
  assert.deepEqual(serverArgs({ command: ['node', 's.js', '--flag'], env: { K: 'v' } }), { before: [], secret: ['--env', 'K=v'], after: ['--', 'node', 's.js', '--flag'] });
});

test('toolmenu mcp takes no server', async () => {
  const r = await run(['mcp', '--', 'node', 'x.js']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /mcp takes no server/);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}
const hang = (cwd) => ({ command: [process.execPath, join(FIXTURES, 'hang-server.mjs')], env: { PID_FILE: join(cwd, 'pid.json'), SECRET: 'sk-test-not-in-argv' }, cwd });

test('a cancelled call stops the run and the server it started, even one that ignores SIGTERM', async () => {
  const cwd = tempDir();
  const conn = await connect(toolmenu(), { timeoutMs: TIMEOUT_MS });
  try {
    const ac = new AbortController();
    const call = conn.client.callTool({ name: 'snapshot_menu', arguments: hang(cwd) }, { signal: ac.signal, timeout: TIMEOUT_MS });
    call.catch(() => {});
    assert.ok(await until(() => existsSync(join(cwd, 'pid.json'))), 'the server started');
    const { pid, parentArgs, secret } = JSON.parse(readFileSync(join(cwd, 'pid.json'), 'utf8'));
    // The env values reached the server through the environment, not the CLI's argv.
    assert.equal(secret, 'sk-test-not-in-argv');
    if (parentArgs.length) assert.ok(!parentArgs.join(' ').includes('sk-test-not-in-argv'), parentArgs.join(' '));
    ac.abort();
    await assert.rejects(call);
    assert.ok(await until(() => !alive(pid)), `server ${pid} still running after the call was cancelled`);
    // The server still serves.
    const ok = await conn.client.callTool({ name: 'explain_rule', arguments: { rule: 'vague-id' } }, { timeout: TIMEOUT_MS });
    assert.equal(ok.isError, undefined);
  } finally {
    await conn.close();
  }
});

test('closing the connection stops runs still going', async () => {
  const cwd = tempDir();
  const conn = await connect(toolmenu(), { timeoutMs: TIMEOUT_MS });
  conn.client.callTool({ name: 'check_session', arguments: hang(cwd) }, { timeout: TIMEOUT_MS }).catch(() => {});
  assert.ok(await until(() => existsSync(join(cwd, 'pid.json'))), 'the server started');
  const { pid } = JSON.parse(readFileSync(join(cwd, 'pid.json'), 'utf8'));
  await conn.close();
  assert.ok(await until(() => !alive(pid)), `server ${pid} still running after the client closed`);
});

test('values from the agent are never read as options', async () => {
  const cwd = tempDir();
  await withServer(async (call) => {
    const rule = await call('explain_rule', { rule: '--json' });
    assert.equal(rule.isError, true);
    assert.match(textOf(rule), /isn't a rule name/);
    // A real after file, so the only path that can fail is before's.
    const diff = await call('diff_menus', { before: '--config=other.json', after: join(FIXTURES, 'menus/server-filesystem-2026.8.31.json'), cwd });
    assert.equal(diff.isError, true);
    assert.match(textOf(diff), /--config=other\.json/);
    assert.doesNotMatch(textOf(diff), /other\.json: ENOENT/, 'read as a path, not a config option');
    const saved = await call('snapshot_menu', { command: [process.execPath, join(FIXTURES, 'sdk-server.mjs')], cwd, save_as: '-menu.json' });
    assert.equal(saved.isError, undefined, textOf(saved));
    assert.ok(existsSync(join(cwd, '-menu.json')));
  });
});

test('a cwd that is not a folder says so', async () => {
  const cwd = tempDir();
  assert.match(folder(cwd, 'packages/sever').error, /doesn't exist/);
  await withServer(async (call) => {
    const r = await call('snapshot_menu', { command: ['node', 'x.js'], cwd: join(cwd, 'nope') });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /cwd ".*nope" doesn't exist/);
    assert.doesNotMatch(textOf(r), /ENOENT/);
  });
});

test('server.json, the MCP Registry entry, names this package and version and starts `toolmenu mcp`', () => {
  const server = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // The registry only takes the entry if the npm package's mcpName is the server's name.
  assert.equal(pkg.mcpName, server.name);
  assert.equal(server.version, pkg.version);
  assert.ok(server.description.length <= 100, 'the registry caps the description at 100 characters');
  assert.equal(server.packages.length, 1);
  const [p] = server.packages;
  assert.deepEqual(
    { registryType: p.registryType, identifier: p.identifier, version: p.version, transport: p.transport },
    { registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } },
  );
  assert.deepEqual(p.packageArguments, [{ type: 'positional', value: 'mcp' }]);
});

test('the plugin runs the toolmenu release its lockfile pins, installed with it, never a newer one than this repo', () => {
  const dir = join(ROOT, 'plugins/toolmenu');
  const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const plugin = read('.claude-plugin/plugin.json');
  const deps = read('package.json').dependencies;
  const lock = read('package-lock.json');
  // The plugin's version is the toolmenu release it runs: published first, then pinned here.
  assert.deepEqual(deps, { toolmenu: plugin.version }, 'package.json pins toolmenu to the plugin version, exactly');
  assert.equal(lock.packages['node_modules/toolmenu'].version, plugin.version, 'regenerate: npm install --package-lock-only (in plugins/toolmenu)');
  assert.deepEqual(lock.packages[''].dependencies, deps, 'package.json and the lockfile list the same dependencies, or Claude Code skips the install');
  // What Claude Code's install needs: lockfile v2 or 3, exact registry packages over https with hashes, no scripts.
  assert.ok([2, 3].includes(lock.lockfileVersion));
  for (const [path, p] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(p.resolved, /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(p.integrity, /^sha512-/, path);
    assert.ok(!p.hasInstallScript, `${path} has an install script, which Claude Code's install doesn't run`);
  }
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version.split('.').map(Number);
  const pinned = plugin.version.split('.').map(Number);
  assert.ok(pinned[0] < pkgVersion[0] || (pinned[0] === pkgVersion[0] && (pinned[1] < pkgVersion[1] || (pinned[1] === pkgVersion[1] && pinned[2] <= pkgVersion[2]))), 'the plugin pins a published release, not one ahead of this repo');
  const mcp = read('.mcp.json').mcpServers.toolmenu;
  assert.equal(mcp.command, 'node');
  // The directory wants the command to run a file the plugin ships, not one under node_modules.
  assert.deepEqual(mcp.args, ['${CLAUDE_PLUGIN_ROOT}/bin/toolmenu-mcp.mjs']);
  const launcher = readFileSync(join(ROOT, 'plugins/toolmenu/bin/toolmenu-mcp.mjs'), 'utf8');
  assert.match(launcher, /await import\('toolmenu\/dist\/cli\.js'\)/);
  assert.match(launcher, /'mcp'/);
});

test('TOOLMENU_MCP_ARGS: arguments the CLI takes from the environment, before "--"', async () => {
  const r = await run(['explain'], { env: { TOOLMENU_MCP_ARGS: '["--json"]' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Array.isArray(JSON.parse(r.stdout)));
  const bad = await run(['explain'], { env: { TOOLMENU_MCP_ARGS: '{"no":1}' } });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /JSON array of strings/);
});

test('TOOLMENU_ARGS: the same for anyone, alongside TOOLMENU_MCP_ARGS', async () => {
  const r = await run(['explain'], { env: { TOOLMENU_ARGS: '["--json"]' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Array.isArray(JSON.parse(r.stdout)));
  const bad = await run(['explain'], { env: { TOOLMENU_ARGS: '"--json"' } });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /TOOLMENU_ARGS must be a JSON array of strings/);
});

test('the tools that start a server say so: destructive, not idempotent', async () => {
  const conn = await connect(toolmenu(), { timeoutMs: TIMEOUT_MS });
  try {
    const { tools } = await conn.client.listTools();
    for (const name of ['snapshot_menu', 'check_session']) {
      const a = tools.find((t) => t.name === name).annotations;
      assert.equal(a.destructiveHint, true, name);
      assert.equal(a.idempotentHint, false, name);
      assert.equal(a.readOnlyHint, false, name);
    }
    for (const name of ['diff_menus', 'explain_rule']) assert.equal(tools.find((t) => t.name === name).annotations.readOnlyHint, true, name);
  } finally {
    await conn.close();
  }
});

test('save_as writes only inside cwd: a new file, or a menu file it replaces', async () => {
  const cwd = tempDir();
  const elsewhere = tempDir();
  mkdirSync(join(cwd, 'sub'));
  writeFileSync(join(cwd, 'notes.txt'), 'keep me');
  writeFileSync(join(cwd, 'menu.json'), JSON.stringify({ toolmenu: 1, tools: [] }));
  writeFileSync(join(elsewhere, 'target.json'), JSON.stringify({ toolmenu: 1, tools: [] }));
  symlinkSync(join(elsewhere, 'target.json'), join(cwd, 'link.json'));
  symlinkSync(elsewhere, join(cwd, 'out'));

  assert.ok('path' in savePath(cwd, 'new-menu.json'));
  assert.ok('path' in savePath(cwd, 'sub/new.json'));
  assert.ok('path' in savePath(cwd, 'menu.json'), 'an existing menu file is replaced');
  assert.match(savePath(cwd, '../escape.json').error, /outside the folder/);
  assert.match(savePath(cwd, join(elsewhere, 'abs.json')).error, /outside the folder/);
  assert.match(savePath(cwd, 'out/through-symlinked-folder.json').error, /outside the folder/);
  assert.match(savePath(cwd, 'link.json').error, /symbolic link/);
  assert.match(savePath(cwd, 'notes.txt').error, /isn't a toolmenu menu/);
  assert.match(savePath(cwd, 'sub').error, /not a file/);
  assert.match(savePath(cwd, 'nope/x.json').error, /doesn't exist/);
  // A dangling symlink: writing it would create its target, wherever that is.
  symlinkSync(join(elsewhere, 'not-yet.json'), join(cwd, 'dangling.json'));
  assert.match(savePath(cwd, 'dangling.json').error, /symbolic link/);
  assert.ok(!existsSync(join(elsewhere, 'not-yet.json')));
  // A hard link to a menu file outside cwd: same file, so refused.
  linkSync(join(elsewhere, 'target.json'), join(cwd, 'hard.json'));
  assert.match(savePath(cwd, 'hard.json').error, /hard link/);
  // A name that starts with two dots is still inside.
  assert.ok('path' in savePath(cwd, '..menu.json'));

  await withServer(async (call) => {
    const server = [process.execPath, join(FIXTURES, 'sdk-server.mjs')];
    const refused = await call('snapshot_menu', { command: server, cwd, save_as: 'notes.txt' });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /wasn't overwritten/);
    assert.equal(readFileSync(join(cwd, 'notes.txt'), 'utf8'), 'keep me');
    const out = await call('snapshot_menu', { command: server, cwd, save_as: '../escape.json' });
    assert.equal(out.isError, true);
    assert.ok(!existsSync(join(cwd, '..', 'escape.json')));
    const badCwd = await call('snapshot_menu', { command: server, cwd: join(cwd, 'missing'), save_as: 'menu.json' });
    assert.equal(badCwd.isError, true);
    assert.match(textOf(badCwd), /doesn't exist/);
    const replaced = await call('snapshot_menu', { command: server, cwd, save_as: 'menu.json' });
    assert.equal(replaced.isError, undefined, textOf(replaced));
    assert.equal(JSON.parse(readFileSync(join(cwd, 'menu.json'), 'utf8')).tools.length, 3);
  });
});

test('TOOLMENU_ARGS holds only options and their values: no "--", no stray word, never echoed', async () => {
  for (const [args, said] of [
    [['--env', 'X=1', 'S3CRET'], /item 3 isn't one/],
    [['--', 'node', 'evil.js'], /item 1 isn't one/],
    [['--nope=S3CRET'], /--nope isn't an option/],
    [['--header'], /needs a value/],
  ]) {
    const r = await run(['explain'], { env: { TOOLMENU_ARGS: JSON.stringify(args) } });
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.stderr, said);
    assert.doesNotMatch(r.stderr, /S3CRET|evil/);
  }
  // An option's value may start with "--" (it's the value): still fine.
  const ok = await run(['explain'], { env: { TOOLMENU_ARGS: JSON.stringify(['--format', 'json']) } });
  assert.equal(ok.code, 0, ok.stderr);
});
