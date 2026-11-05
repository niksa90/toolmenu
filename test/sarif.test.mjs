// SARIF 2.1.0 output (--format sarif, --sarif <path>): for GitHub code scanning. Each
// result points at the menu file, at the line of the tool it's about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSarif, toolLines } from '../dist/sarif.js';
import { FIXTURES, run, tempDir } from './helpers.mjs';

const headers = join(FIXTURES, 'header-server.mjs');

function lineOf(file, n) {
  return readFileSync(file, 'utf8').split('\n')[n - 1];
}

test('toolLines: the line of each tool\'s "name", not of names nested in schemas', () => {
  const menu = { server: { name: 's' }, tools: [{ name: 'a', inputSchema: { properties: { name: { type: 'string' } } } }, { name: 'b' }] };
  const text = JSON.stringify(menu, null, 2);
  const lines = toolLines(text);
  assert.deepEqual([...lines.keys()], ['a', 'b']);
  for (const [tool, n] of lines) assert.ok(text.split('\n')[n - 1].trim().startsWith(`"name": "${tool}"`), `${tool} at line ${n}`);
});

test('snapshot --sarif: a valid log beside the usual report, each result on its tool\'s line', async () => {
  const cwd = tempDir();
  const r = await run(['snapshot', '--sarif', 'out.sarif', '--', process.execPath, headers], { cwd });
  assert.match(r.stdout, /toolmenu snapshot/, 'the text report still prints');
  const log = JSON.parse(readFileSync(join(cwd, 'out.sarif'), 'utf8'));
  assert.equal(log.version, '2.1.0');
  const [runLog] = log.runs;
  assert.equal(runLog.tool.driver.name, 'toolmenu');
  assert.equal(runLog.automationDetails.id, 'toolmenu/snapshot/');
  const ids = runLog.tool.driver.rules.map((x) => x.id);
  assert.ok(ids.includes('spec/x-mcp-header'));
  for (const res of runLog.results) {
    assert.equal(runLog.tool.driver.rules[res.ruleIndex].id, res.ruleId);
    assert.ok(['error', 'warning', 'note'].includes(res.level));
    assert.match(res.partialFingerprints['toolmenuFinding/v1'], /^[0-9a-f]{32}$/);
    const loc = res.locations[0].physicalLocation;
    assert.equal(loc.artifactLocation.uri, 'menu.json');
    if (res.properties.tool) assert.equal(lineOf(join(cwd, 'menu.json'), loc.region.startLine).trim(), `"name": "${res.properties.tool}",`);
  }
  const header = runLog.results.find((x) => x.ruleId === 'spec/x-mcp-header');
  assert.match(header.message.text, /→ Next: /, 'the next step is in the message');
});

test('--format sarif prints the log instead of the report; fingerprints are stable across runs', async () => {
  const cwd = tempDir();
  const a = await run(['snapshot', '--format', 'sarif', '--', process.execPath, headers], { cwd });
  const b = await run(['snapshot', '--format', 'sarif', '--', process.execPath, headers], { cwd });
  const prints = (r) => JSON.parse(r.stdout).runs[0].results.map((x) => x.partialFingerprints['toolmenuFinding/v1']);
  assert.deepEqual(prints(a), prints(b));
  assert.equal(a.code, 0, 'findings below --fail-on: same exit code as the report');
});

test('diff: results point at the newer menu file, one per tool of a change found in several', async () => {
  const menus = join(FIXTURES, 'menus');
  const cwd = tempDir();
  const r = await run(['diff', '--sarif', 'diff.sarif', join(menus, 'server-filesystem-2025.7.1.json'), join(menus, 'server-filesystem-2026.8.31.json')], { cwd });
  const runLog = JSON.parse(readFileSync(join(cwd, 'diff.sarif'), 'utf8')).runs[0];
  assert.equal(runLog.automationDetails.id, 'toolmenu/diff/');
  const added = runLog.results.filter((x) => x.ruleId === 'diff/tool-added').map((x) => x.properties.tool).sort();
  assert.deepEqual(added, ['read_media_file', 'read_text_file']);
  const loc = runLog.results.find((x) => x.properties.tool === 'read_text_file').locations[0].physicalLocation;
  assert.match(loc.artifactLocation.uri, /server-filesystem-2026\.8\.31\.json$/);
  assert.match(r.stdout, /toolmenu diff/);
});

test('--sarif-menu names the committed file results point at', () => {
  const dir = tempDir();
  const menu = join(dir, 'menu.json');
  writeFileSync(menu, JSON.stringify({ tools: [{ name: 'x' }, { name: 'y' }] }, null, 2) + '\n');
  const log = JSON.parse(toSarif([{ rule: 'naming/vague-id', severity: 'warn', message: 'm', tool: 'y' }, { rule: 'naming/vague-id', severity: 'warn', message: 'm', tool: 'new_tool' }], { command: 'snapshot', menuPath: menu, root: dir }));
  const [onY, onNew] = log.runs[0].results;
  assert.equal(onY.locations[0].physicalLocation.artifactLocation.uri, 'menu.json');
  assert.equal(lineOf(menu, onY.locations[0].physicalLocation.region.startLine).trim(), '"name": "y"');
  assert.equal(onNew.locations[0].physicalLocation.region.startLine, 1, 'a tool the file lacks: line 1');
  assert.equal(log.runs[0].tool.driver.rules[0].defaultConfiguration.level, 'warning', 'the level RULES.md gives');
});

test('SARIF goes with snapshot, diff and session only', async () => {
  const r = await run(['explain', '--format', 'sarif']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /SARIF output .* goes with snapshot, diff or session/);
  const plan = await run(['session', '--plan', '--sarif', 'x.sarif', '--scenario', join(FIXTURES, '..', '..', 'examples', 'unlock.scenario.yml')]);
  assert.equal(plan.code, 2);
  assert.match(plan.stderr, /SARIF needs findings/);
});
