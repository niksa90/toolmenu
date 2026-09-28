import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { detectProject, looksSecret, workflowYaml } from '../dist/init.js';
import { loadMenu } from '../dist/menu.js';
import { FIXTURES, ROOT, run, tempDir } from './helpers.mjs';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

test('detectProject: how CI builds each kind of server', () => {
  const dir = (files) => {
    const d = tempDir();
    for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text);
    return d;
  };
  const npm = detectProject(dir({ 'package.json': '{"scripts":{"build":"tsc"}}', 'package-lock.json': '{}' }));
  assert.equal(npm.kind, 'node');
  assert.ok(npm.setup.includes('- run: npm ci && npm run build'));
  assert.ok(detectProject(dir({ 'package.json': '{}', 'pnpm-lock.yaml': '' })).setup.some((l) => l.includes('pnpm install --frozen-lockfile')));
  assert.ok(detectProject(dir({ 'pyproject.toml': '', 'uv.lock': '' })).setup.includes('- run: uv sync'));
  assert.ok(detectProject(dir({ 'requirements.txt': '' })).setup.includes('- run: pip install -r requirements.txt'));
  assert.equal(detectProject(dir({ 'go.mod': '' })).kind, 'go');
  assert.equal(detectProject(dir({})).kind, 'unknown');
});

test('workflowYaml: valid YAML, pinned Action, credentials only as secrets', () => {
  const target = { kind: 'stdio', command: 'node', args: ['dist/server.js'], env: { GITHUB_TOKEN: 'ghp_real', API_KEY: 'k', LOG_LEVEL: 'debug' } };
  const text = workflowYaml({ target, project: detectProject(tempDir()), session: true });
  const wf = parse(text);
  const step = wf.jobs.toolmenu.steps.find((s) => String(s.uses).startsWith('niksa90/toolmenu'));
  assert.equal(step.uses, `niksa90/toolmenu@v${VERSION}`);
  assert.equal(step.with.command, 'node dist/server.js');
  assert.equal(step.with.scenario, 'auto');
  assert.match(step.with.env, /GITHUB_TOKEN=\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(step.with.env, /API_KEY=\$\{\{ secrets\.API_KEY \}\}/);
  assert.match(step.with.env, /LOG_LEVEL=debug/);
  assert.equal(text.includes('ghp_real'), false);
  const http = parse(workflowYaml({ target: { kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } }, project: detectProject(tempDir()) }));
  const h = http.jobs.toolmenu.steps.find((s) => s.with);
  assert.equal(h.with.url, 'https://mcp.example.com/mcp');
  assert.match(h.with.headers, /Authorization: \$\{\{ secrets\.MCP_AUTHORIZATION \}\}/);
  assert.equal(looksSecret('MEMORY_FILE_PATH'), false);
  assert.equal(looksSecret('SENTRY_ACCESS_TOKEN'), true);
});

test('cli: init writes the baseline and the workflow, and never overwrites', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'package.json'), '{"scripts":{"build":"tsc"}}');
  const server = ['--env', 'API_TOKEN=supersecret', '--', process.execPath, join(FIXTURES, 'sdk-server.mjs')];
  const r = await run(['init', ...server], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /wrote menu\.json/);
  assert.match(r.stdout, /Add these repository secrets .*API_TOKEN/);
  const menu = await loadMenu(join(cwd, 'menu.json'));
  assert.ok(menu.tools.length > 0);
  const wf = readFileSync(join(cwd, '.github/workflows/toolmenu.yml'), 'utf8');
  assert.equal(wf.includes('supersecret'), false);
  assert.ok(parse(wf).jobs.toolmenu.steps.some((s) => s.run === 'npm install && npm run build'));
  const again = await run(['init', ...server], { cwd });
  assert.equal(again.code, 2);
  assert.match(again.stderr, /never overwrites/);
});
