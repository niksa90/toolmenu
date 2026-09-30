import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFailure, history, historyCsv, summarizeError } from '../dist/history.js';
import { run, tempDir } from './helpers.mjs';

const str = { type: 'string' };
const tool = (name, params = []) => ({
  name,
  description: `${name}.`,
  inputSchema: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, str])), required: params },
  annotations: { readOnlyHint: true },
});

/** A tiny 2025-era stdio server serving a fixed menu. */
const serverSource = (tools) => `
import { createInterface } from 'node:readline';
const tools = ${JSON.stringify(tools)};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fx', version: '0.0.1' } } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools } });
  else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
});`;

const VERSIONS = [
  { version: '1.0.0', published: '2026-01-01T00:00:00Z', tools: [tool('search_items', ['query']), tool('get_item', ['item_id'])] },
  { version: '1.1.0', published: '2026-02-01T00:00:00Z', tools: [tool('search_items', ['query']), tool('get_item', ['item_id']), tool('list_tags')] },
  { version: '1.2.0', published: '2026-03-01T00:00:00Z', noBin: true },
  { version: '1.3.0', published: '2026-04-01T00:00:00Z', script: `console.error('Error: FX_API_KEY is not set'); process.exit(1);` },
  { version: '1.4.0', published: '2026-04-15T00:00:00Z', script: `console.error('Usage: fx-mcp <directory>'); process.exit(1);` },
  { version: '2.0.0', published: '2026-05-01T00:00:00Z', tools: [tool('search_items', ['query']), tool('list_tags')] },
  { version: '2.1.0-beta.1', published: '2026-06-01T00:00:00Z', tools: [tool('search_items', ['query'])] },
];

/** Installs fake packages by copying files and writing the lockfile npm would. */
function fakeSource(root) {
  for (const v of VERSIONS) {
    const dir = join(root, v.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx-mcp', version: v.version, ...(v.noBin ? {} : { bin: { 'fx-mcp': 'server.mjs' } }), dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', left: '1' } }));
    writeFileSync(join(dir, 'server.mjs'), v.script ?? serverSource(v.tools ?? []));
  }
  return {
    installs: [],
    async versions() {
      return VERSIONS.map(({ version, published }) => ({ version, published }));
    },
    async install(pkg, version, dir, options) {
      this.installs.push({ version, options });
      if (version === 'missing') throw new Error('npm ERR! 404');
      cpSync(join(root, version), join(dir, 'node_modules', pkg), { recursive: true });
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
        packages: {
          '': {},
          [`node_modules/${pkg}`]: { version },
          'node_modules/@modelcontextprotocol/sdk': { version: '1.30.1' },
          'node_modules/zod': { version: '4.6.5' },
          'node_modules/other/node_modules/zod': { version: '3.25.76' },
        },
      }));
    },
  };
}

test('history snapshots each version, records failures and diffs the ones that worked', async () => {
  const root = tempDir();
  const outDir = join(root, 'out');
  const source = fakeSource(join(root, 'packages'));
  const h = await history('fx-mcp', { outDir, source, versions: 10, timeoutMs: 10_000 });

  assert.deepEqual(h.rows.map((r) => r.version), ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '2.0.0'], 'oldest first, prereleases left out');
  assert.equal(h.totalVersions, 7);
  assert.deepEqual(h.rows.map((r) => r.reason ?? r.status), ['ok', 'ok', 'no-bin', 'needs-env', 'needs-args', 'ok']);
  assert.match(h.rows[3].error, /FX_API_KEY is not set/);
  assert.ok(source.installs.every((i) => i.options.allowScripts === false), 'install scripts are off by default');

  const [first, second, , , , last] = h.rows;
  assert.equal(first.tools, 2);
  assert.equal(first.protocolVersion, '2025-11-25');
  assert.deepEqual(first.serverInfo, { name: 'fx', version: '0.0.1' });
  assert.deepEqual(first.declared, { '@modelcontextprotocol/sdk': '^1.0.0' });
  assert.deepEqual(first.resolved, { '@modelcontextprotocol/sdk': ['1.30.1'], zod: ['3.25.76', '4.6.5'] });
  assert.equal(first.diff, undefined);

  assert.equal(second.diff.from, '1.0.0');
  assert.equal(second.diff.minor, 1);
  assert.equal(second.diff.actualBump, 'minor', 'npm versions, not the server\'s own 0.0.1');

  assert.equal(last.diff.from, '1.1.0', 'failed versions are skipped');
  assert.equal(last.diff.breaking, 1);
  assert.match(last.diff.breakingChanges[0], /`get_item` was removed/);

  assert.ok(existsSync(join(outDir, '1.0.0.json')));
  assert.ok(!existsSync(join(outDir, '1.2.0.json')));
  const saved = JSON.parse(readFileSync(join(outDir, 'history.json'), 'utf8'));
  assert.equal(saved.rows.length, 6);
});

test('history: --versions keeps the most recent, prereleases on request', async () => {
  const root = tempDir();
  const source = fakeSource(join(root, 'packages'));
  const h = await history('fx-mcp', { outDir: join(root, 'out'), source, versions: 2, includePrereleases: true, timeoutMs: 10_000 });
  assert.deepEqual(h.rows.map((r) => r.version), ['2.0.0', '2.1.0-beta.1']);
});

test('history: versions: Infinity takes every release', async () => {
  const root = tempDir();
  const source = fakeSource(join(root, 'packages'));
  const h = await history('fx-mcp', { outDir: join(root, 'out'), source, versions: Infinity, timeoutMs: 10_000 });
  assert.equal(h.rows.length, 6, 'all six non-prerelease versions');
});

test('history: --cmd template runs a custom command', async () => {
  const root = tempDir();
  const source = fakeSource(join(root, 'packages'));
  const h = await history('fx-mcp', { outDir: join(root, 'out'), source, versions: 1, cmd: `"${process.execPath}" {dir}/node_modules/fx-mcp/server.mjs`, timeoutMs: 10_000 });
  assert.equal(h.rows[0].status, 'ok');
});

test('history: csv has one row per version', async () => {
  const root = tempDir();
  const source = fakeSource(join(root, 'packages'));
  const csv = historyCsv(await history('fx-mcp', { outDir: join(root, 'out'), source, versions: 3, timeoutMs: 10_000 }));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'version');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^1\.3\.0,2026-04-01,failed,needs-env,/);
  assert.match(lines[3], /^2\.0\.0,2026-05-01,ok,,2025-11-25,0\.0\.1,2,/);
});

test('classifyFailure and summarizeError', () => {
  assert.equal(classifyFailure(new Error('Connection closed\nserver stderr:\nUsage: mcp-server-filesystem <allowed-directory>')), 'needs-args');
  assert.equal(classifyFailure(new Error('server stderr:\nError: GITHUB_TOKEN environment variable is not set')), 'needs-env');
  assert.equal(classifyFailure(new Error('Request timed out')), 'timeout');
  assert.equal(classifyFailure(new Error('Connection closed')), 'crashed');
  const summary = summarizeError(new Error(`Connection closed
server stderr:
node:internal/modules/esm/resolve:873
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod-to-json-schema' imported from /x/index.js
    at packageResolve (node:internal/modules/esm/resolve:873:9)
    at ModuleJob._link (node:internal/modules/esm/module_job:182:49) {
  code: 'ERR_MODULE_NOT_FOUND'
}

Node.js v22.22.2`));
  assert.match(summary, /Cannot find package 'zod-to-json-schema'/);
  assert.doesNotMatch(summary, /ModuleJob/);
});

test('cli: history usage errors exit 2', async () => {
  assert.equal((await run(['history'])).code, 2);
  assert.equal((await run(['history', 'a', 'b'])).code, 2);
  assert.equal((await run(['history', '--versions', '0', 'pkg'])).code, 2);
  assert.equal((await run(['history', '--', 'node', 'x.js'])).code, 2);
});
