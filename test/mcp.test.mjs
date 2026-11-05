// toolmenu mcp: toolmenu as an MCP server. Its tools run the CLI, and its own menu
// passes toolmenu's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../dist/connect.js';
import { serverArgs } from '../dist/mcp.js';
import { CLI, FIXTURES, run, tempDir, TIMEOUT_MS } from './helpers.mjs';

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

test('its own menu: no findings, at any level, on either protocol', async () => {
  for (const protocol of ['modern', 'auto']) {
    const r = await run(['snapshot', '--no-write', '--fail-on', 'info', '--protocol', protocol, '--', process.execPath, CLI, 'mcp']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /4 tools/);
  }
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
  assert.deepEqual(serverArgs({ url: 'https://e.com/mcp', headers: { Authorization: 'Bearer t' } }), { before: ['https://e.com/mcp', '--header', 'Authorization: Bearer t'], after: [] });
  assert.deepEqual(serverArgs({ command: ['node', 's.js', '--flag'], env: { K: 'v' } }), { before: ['--env', 'K=v'], after: ['--', 'node', 's.js', '--flag'] });
});

test('toolmenu mcp takes no server', async () => {
  const r = await run(['mcp', '--', 'node', 'x.js']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /mcp takes no server/);
});
