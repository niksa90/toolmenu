// scan across servers: a tool its own server ranks in the top results, pushed out by other
// servers' tools when they're loaded together (search/outranked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, run, tempDir } from './helpers.mjs';

const obj = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const t = (name, description) => ({ name, description, inputSchema: obj, annotations: { readOnlyHint: true } });
const aimyear = [t('log_workout', 'Log a workout.'), t('get_plan', 'Get the training plan.'), t('list_goals', 'List goals.')];
// six tools that pile up "workout" and "log": together, they rank ahead of log_workout
const fitlog = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => t(`workout_log_${x}`, `Workout log ${x}: workout log, workout log.`));
const notes = [t('add_note', 'Add a note.'), t('list_notes', 'List notes.')];

function config(dir, servers) {
  const mcpServers = Object.fromEntries(servers.map(([name, tools]) => [name, { command: process.execPath, args: [join(FIXTURES, 'menu-server.mjs')], env: { MENU: JSON.stringify(tools), NAME: name } }]));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers }));
  return join(dir, 'mcp.json');
}
const outranked = (r) => JSON.parse(r.stdout).servers.flatMap((s) => s.findings.map((f) => ({ server: s.name, ...f }))).filter((f) => f.rule === 'search/outranked');

test('search/outranked: a tool found when its server is alone, pushed out by other servers\' tools', async () => {
  const dir = tempDir();
  const r = await run(['scan', '--format', 'json', config(dir, [['aimyear', aimyear], ['fitlog', fitlog], ['notes', notes]])], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const found = outranked(r);
  assert.equal(found.length, 1);
  assert.equal(found[0].server, 'aimyear');
  assert.equal(found[0].tool, 'log_workout');
  assert.equal(found[0].severity, 'info');
  assert.equal(found[0].confidence, 'unsure');
  assert.match(found[0].message, /^1 tool of aimyear comes up in the top 5 for its own name on aimyear's own, and drops out when it's loaded with the other servers in this list \(11 tools from 3 servers\)/);
  assert.match(found[0].detail[0], /^log_workout \(“log workout”\): 1 on its own, 7 with the others, behind fitlog\/workout_log_a/);
  assert.match(found[0].fix, /the product's name \("aimyear"\)/);
});

test('search/outranked: routes.yml across servers, per client; quiet with one server', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'routes.yml'), '"log past time workout":\n  must_match: [aimyear/log_workout]\n');
  const list = config(dir, [['aimyear', aimyear], ['fitlog', fitlog]]);
  const r = await run(['scan', '--format', 'json', '--routes', 'routes.yml', '--client', 'claude-api-search,codex', list], { cwd: dir });
  const found = outranked(r).filter((f) => f.severity === 'warn');
  // 7th with both servers loaded: past Claude's 5, inside Codex's 8
  assert.deepEqual(found.map((f) => f.client), ['claude-api-search']);
  assert.match(found[0].message, /^For Claude's tool search \(Claude API\): routes\.yml says “log past time workout” should reach aimyear\/log_workout, but with every server in this list loaded \(9 tools from 2 servers\), Claude's tool search \(Claude API\) puts it at 7, past the 5 a search returns/);
  assert.match(found[0].detail[0], /^ahead of it: fitlog\/workout_log_a/);
  // one server: nothing to be outranked by
  const alone = await run(['scan', '--format', 'json', config(tempDir(), [['aimyear', aimyear]])], { cwd: dir });
  assert.deepEqual(outranked(alone), []);
  // and the rule can be turned off
  writeFileSync(join(dir, 'toolmenu.config.json'), JSON.stringify({ rules: { 'search/outranked': 'off' } }));
  assert.deepEqual(outranked(await run(['scan', '--format', 'json', '--routes', 'routes.yml', list], { cwd: dir })), []);
});
