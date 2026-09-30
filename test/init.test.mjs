import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { detectProject, findGitRoot, initReport, planInit, secretsNeeded, workflowYaml } from '../dist/init.js';
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
  const uv = detectProject(dir({ 'pyproject.toml': '', 'uv.lock': '' })).setup;
  assert.ok(uv.includes('- run: uv sync'));
  // A tag that resolves: setup-uv publishes no floating v10.
  assert.ok(uv.some((l) => /astral-sh\/setup-uv@v\d+\.\d+\.\d+$/.test(l)));
  assert.ok(detectProject(dir({ 'requirements.txt': '' })).setup.includes('- run: pip install -r requirements.txt'));
  assert.equal(detectProject(dir({ 'go.mod': '' })).kind, 'go');
  assert.equal(detectProject(dir({})).kind, 'unknown');
});

test('workflowYaml: valid YAML, pinned Action, credentials only as secrets', () => {
  const env = {
    GITHUB_TOKEN: 'ghp_real',
    API_KEY: 'sk-live-123',
    LOG_LEVEL: 'verbose-debug',
    // Credentials no name pattern gives away.
    DATABASE_URL: 'postgres://admin:hunter2@db.internal/prod',
    SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/1',
  };
  const target = { kind: 'stdio', command: 'node', args: ['dist/server.js'], env };
  const text = workflowYaml({ target, project: detectProject(tempDir()), session: true });
  const wf = parse(text);
  const step = wf.jobs.toolmenu.steps.find((s) => String(s.uses).startsWith('niksa90/toolmenu'));
  assert.equal(step.uses, `niksa90/toolmenu@v${VERSION}`);
  assert.equal(step.with.command, 'node dist/server.js');
  assert.equal(step.with.scenario, 'auto');
  // GitHub reserves GITHUB_*: secrets.GITHUB_TOKEN would be the job's own token.
  assert.match(step.with.env, /GITHUB_TOKEN=\$\{\{ secrets\.MCP_GITHUB_TOKEN \}\}/);
  assert.match(step.with.env, /API_KEY=\$\{\{ secrets\.API_KEY \}\}/);
  assert.match(step.with.env, /LOG_LEVEL=\$\{\{ secrets\.LOG_LEVEL \}\}/);
  assert.match(step.with.env, /DATABASE_URL=\$\{\{ secrets\.DATABASE_URL \}\}/);
  for (const value of Object.values(env)) assert.equal(text.includes(value), false, value);
  assert.deepEqual(secretsNeeded(target), ['MCP_GITHUB_TOKEN', 'API_KEY', 'LOG_LEVEL', 'DATABASE_URL', 'SENTRY_DSN']);
  const http = parse(workflowYaml({ target: { kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } }, project: detectProject(tempDir()) }));
  const h = http.jobs.toolmenu.steps.find((s) => s.with);
  assert.equal(h.with.url, 'https://mcp.example.com/mcp');
  assert.match(h.with.headers, /Authorization: \$\{\{ secrets\.MCP_AUTHORIZATION \}\}/);
});

test('cli: init writes the baseline and the workflow, and never overwrites', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'package.json'), '{"scripts":{"build":"tsc"}}');
  const server = ['--env', 'API_TOKEN=supersecret', '--', process.execPath, join(FIXTURES, 'sdk-server.mjs')];
  const r = await run(['init', ...server], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Wrote\n {2}✓ .*menu\.json/);
  assert.match(r.stdout, /gh secret set API_TOKEN/);
  const menu = await loadMenu(join(cwd, 'menu.json'));
  assert.ok(menu.tools.length > 0);
  const wf = readFileSync(join(cwd, '.github/workflows/toolmenu.yml'), 'utf8');
  assert.equal(wf.includes('supersecret'), false);
  assert.ok(parse(wf).jobs.toolmenu.steps.some((s) => s.run === 'npm install && npm run build'));
  const again = await run(['init', ...server], { cwd });
  assert.equal(again.code, 2);
  assert.match(again.stderr, /never overwrites/);
});

// --- Paths, the repository root, and what init says -------------------------

/** A folder that looks like a git repository root (findGitRoot only needs .git). */
function repo(files = {}) {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, '.git'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}
const stdio = (command, args = [], env) => ({ kind: 'stdio', command, args, ...(env ? { env } : {}) });
const summary = { server: 'fixture', version: '1.0.0', tools: 3, tokens: 1234, counts: { error: 0, warn: 1, info: 0 } };
const yamlOf = (plan) => parse(workflowYaml({ target: plan.ciTarget, project: plan.project, baseline: plan.baseline, serverDir: plan.serverDir }));

test('planInit: an absolute path inside the repository becomes relative; flags, URLs and non-paths stay', () => {
  const root = repo({ 'package.json': '{}', 'dist/server.js': '', 'config/app.json': '{}' });
  const plan = planInit({
    cwd: root,
    target: stdio('node', [join(root, 'dist/server.js'), `--config=${join(root, 'config/app.json')}`, '--base', '/api/v1', '--upstream', 'https://example.com/mcp', '--port=8080']),
  });
  assert.deepEqual(plan.ciTarget.args, ['dist/server.js', '--config=config/app.json', '--base', '/api/v1', '--upstream', 'https://example.com/mcp', '--port=8080']);
  assert.equal(plan.problems.length, 0);
  assert.equal(plan.rewrites.length, 2);
  const wf = yamlOf(plan);
  const step = wf.jobs.toolmenu.steps.find((s) => s.with?.command);
  assert.equal(step.with.command, 'node dist/server.js --config=config/app.json --base /api/v1 --upstream https://example.com/mcp --port=8080');
  assert.equal(JSON.stringify(wf).includes(root), false, 'no local path in the workflow');
});

test('planInit: a path outside the repository is kept, and said loudly with what to do', () => {
  const outside = realpathSync(tempDir());
  writeFileSync(join(outside, 'server.js'), '');
  const root = repo({ 'package.json': '{}' });
  const target = stdio('node', [join(outside, 'server.js')]);
  const plan = planInit({ cwd: root, target });
  assert.deepEqual(plan.ciTarget.args, [join(outside, 'server.js')]);
  assert.equal(plan.problems.length, 1);
  const [p] = plan.problems;
  assert.match(p.what, /Argument 1 is outside the repository: .*server\.js/);
  assert.match(p.why, /runner only has the checkout/);
  assert.match(p.next, /Move it into the repository/);
  const text = initReport(plan, summary, target);
  assert.match(text, /✗ Won't work in CI as written \(1\)/);
  assert.match(text, /→ Next: Move it into the repository/);
  // A relative path that climbs out counts too.
  const rel = planInit({ cwd: root, target: stdio('node', [relative(root, join(outside, 'server.js'))]) });
  assert.equal(rel.problems.length, 1);
});

test('planInit: a program outside the repository that is on PATH is called by name', () => {
  const bin = realpathSync(tempDir());
  writeFileSync(join(bin, 'myserver'), '#!/bin/sh\n', { mode: 0o755 });
  const root = repo({ 'go.mod': 'module x' });
  const plan = planInit({ cwd: root, target: stdio(join(bin, 'myserver'), ['--stdio']), path: bin });
  assert.equal(plan.ciTarget.command, 'myserver');
  assert.equal(plan.problems.length, 0);
  // Not on PATH: kept, and a problem.
  const off = planInit({ cwd: root, target: stdio(join(bin, 'myserver')), path: '/nonexistent' });
  assert.equal(off.ciTarget.command, join(bin, 'myserver'));
  assert.match(off.problems[0].what, /The command is outside the repository/);
});

test('planInit: from a subfolder, .github goes to the repository root and the server starts where init ran', () => {
  const root = repo({ 'package.json': '{"scripts":{"build":"tsc"}}', 'package-lock.json': '{}', 'sub/server.js': '' });
  const plan = planInit({ cwd: join(root, 'sub'), target: stdio('node', ['server.js']) });
  assert.equal(plan.root, root);
  assert.equal(plan.workflowPath, join(root, '.github/workflows/toolmenu.yml'));
  assert.equal(plan.baselinePath, join(root, 'sub/menu.json'));
  assert.equal(plan.baseline, 'sub/menu.json');
  assert.equal(plan.project.kind, 'node', 'package.json in the parent is found');
  const steps = yamlOf(plan).jobs.toolmenu.steps;
  assert.ok(steps.some((s) => s.run === 'npm ci && npm run build' && !s['working-directory']));
  const step = steps.find((s) => s.with?.command);
  assert.equal(step.with.command, "sh -c 'cd sub && exec node server.js'");
  assert.equal(step.with.baseline, 'sub/menu.json');
  const text = initReport(plan, summary, plan.ciTarget);
  assert.match(text, /git add menu\.json \.\.\/\.github\/workflows\/toolmenu\.yml/);
  assert.match(text, /refresh the baseline from sub\//);
});

test('planInit: a monorepo package builds in its folder and installs where the lockfile is', () => {
  const root = repo({ 'package.json': '{"private":true}', 'pnpm-lock.yaml': '', 'packages/server/package.json': '{"scripts":{"build":"tsc"}}', 'packages/server/dist/index.js': '' });
  const cwd = join(root, 'packages/server');
  const plan = planInit({ cwd, target: stdio('node', [join(cwd, 'dist/index.js')], { API_KEY: 'k-secret' }) });
  assert.deepEqual(plan.ciTarget.args, ['dist/index.js']);
  assert.equal(plan.project.file, 'packages/server/package.json');
  const steps = yamlOf(plan).jobs.toolmenu.steps;
  assert.ok(steps.some((s) => s.run === 'pnpm install --frozen-lockfile' && !s['working-directory']));
  assert.ok(steps.some((s) => s.run === 'pnpm build' && s['working-directory'] === 'packages/server'));
  const step = steps.find((s) => s.with?.command);
  assert.equal(step.with.command, "sh -c 'cd packages/server && exec node dist/index.js'");
  assert.equal(step.with.baseline, 'packages/server/menu.json');
  assert.equal(step.with.release, 'off', "the root's version isn't this package's");
  // A lockfile beside the package, below the root: setup-node is told where it is.
  const root2 = repo({ 'a/b/package.json': '{}', 'a/b/yarn.lock': '' });
  assert.ok(detectProject(join(root2, 'a/b'), root2).setup.some((l) => l.includes('cache-dependency-path: a/b/yarn.lock')));
  const root3 = repo({ 'svc/go.mod': 'module x' });
  assert.ok(detectProject(join(root3, 'svc'), root3).setup.some((l) => l.includes('go-version-file: svc/go.mod')));
});

test('planInit: outside a git repository, the folder stands in for the root, and init says so', () => {
  const dir = realpathSync(tempDir());
  writeFileSync(join(dir, 'package.json'), '{}');
  assert.equal(findGitRoot(dir), undefined);
  const plan = planInit({ cwd: dir, target: stdio('node', ['server.js']) });
  assert.equal(plan.inGit, false);
  assert.equal(plan.root, dir);
  const text = initReport(plan, summary, plan.ciTarget);
  assert.match(text, /not a git repository/);
  assert.match(text, / {2}1\. Make .* a git repository/);
  assert.match(text, /git init/);
});

test('planInit: --out outside the repository is refused before anything is written', () => {
  const root = repo({ 'package.json': '{}' });
  assert.throws(() => planInit({ cwd: root, target: stdio('node', ['s.js']), out: '../menu.json' }), /outside the repository.*--out/s);
});

test('planInit: env values and localhost URLs that only work on this machine', () => {
  const root = repo({ 'package.json': '{}', 'conf.json': '{}' });
  const plan = planInit({ cwd: root, target: stdio('node', ['s.js'], { CONFIG: join(root, 'conf.json'), TOKEN: 'abc' }) });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].what, /--env CONFIG holds a path on this machine/);
  assert.equal(plan.problems[0].unsure, true);
  assert.equal(JSON.stringify(plan.problems).includes('conf.json'), false, 'never the value');
  const http = planInit({ cwd: root, target: { kind: 'http', url: 'http://localhost:3000/mcp' } });
  assert.match(http.problems[0].why, /runner itself/);
  assert.equal(planInit({ cwd: root, target: { kind: 'http', url: 'https://mcp.example.com/mcp' } }).problems.length, 0);
});

test('planInit: a file the server needs that git does not have yet goes in the commit', { skip: !hasGit() }, () => {
  const root = realpathSync(tempDir());
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'server.js'), '');
  const plan = planInit({ cwd: root, target: stdio('node', ['server.js']) });
  assert.deepEqual(plan.uncommitted, ['server.js']);
  assert.match(initReport(plan, summary, plan.ciTarget), /git add menu\.json \.github\/workflows\/toolmenu\.yml server\.js/);
});

test('initReport: every section, numbered next steps, --env as shell variables, never the values', () => {
  const root = repo({ 'package.json': '{}' });
  const target = stdio('node', ['server.js'], { API_TOKEN: 'supersecret', 'my-key': 'v2value' });
  const text = initReport(planInit({ cwd: root, target }), summary, target);
  for (const heading of ['Repository', 'Wrote', 'In CI the server starts with', 'Next steps']) assert.ok(text.includes(heading), heading);
  assert.match(text, /npx toolmenu snapshot --out menu\.json --env API_TOKEN="\$API_TOKEN" --env my-key="\$my_key" -- node server\.js/);
  assert.match(text, /gh secret set API_TOKEN/);
  assert.match(text, /1 warning/);
  assert.equal(text.includes('supersecret'), false);
  assert.equal(text.includes('v2value'), false);
  const nums = [...text.matchAll(/^ {2}(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
  const http = { kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer hunter2' } };
  const h = initReport(planInit({ cwd: root, target: http }), summary, http);
  assert.match(h, /--header "Authorization: \$MCP_AUTHORIZATION"/);
  assert.equal(h.includes('hunter2'), false);
});

test('cli: init from a subfolder writes .github at the root, and a server outside the repo is said loudly', async () => {
  const root = repo({ 'package.json': '{}' });
  const sub = join(root, 'sub');
  mkdirSync(sub);
  const server = ['--env', 'API_TOKEN=supersecret', '--', process.execPath, join(FIXTURES, 'sdk-server.mjs')];
  const r = await run(['init', ...server], { cwd: sub });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(root, '.github/workflows/toolmenu.yml')));
  assert.equal(existsSync(join(sub, '.github')), false);
  assert.ok(existsSync(join(sub, 'menu.json')));
  // The fixture lives outside this repository.
  assert.match(r.stdout, /✗ Won't work in CI as written/);
  assert.match(r.stdout, /--env API_TOKEN="\$API_TOKEN"/);
  assert.equal(r.stdout.includes('supersecret'), false);
  const wf = parse(readFileSync(join(root, '.github/workflows/toolmenu.yml'), 'utf8'));
  const step = wf.jobs.toolmenu.steps.find((s) => s.with?.command);
  assert.match(step.with.command, /^sh -c 'cd sub && exec node /);
  assert.equal(step.with.baseline, 'sub/menu.json');
});

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
