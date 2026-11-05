// snapshot --badge: a shields.io endpoint file, committed with the menu file, and the
// README line that shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { badge, badgeMarkdown, compactTokens, githubRepo } from '../dist/badge.js';
import { FIXTURES, run, tempDir } from './helpers.mjs';

const menu = (n, tokens) => ({ server: { name: 's' }, tools: Array.from({ length: n }, (_, i) => ({ name: `t${i}` })), totalTokens: tokens });
const f = (severity) => ({ rule: 'naming/vague-id', severity, message: 'm' });

test('compactTokens: the size people compare', () => {
  assert.equal(compactTokens(184), '~184');
  assert.equal(compactTokens(1023), '~1K');
  assert.equal(compactTokens(4120), '~4.1K');
  assert.equal(compactTokens(18450), '~18K');
});

test('badge: tools and tokens, then errors (red) or warnings (yellow); info stays green', () => {
  assert.deepEqual(badge(menu(4, 1023), [f('info')]), { schemaVersion: 1, label: 'toolmenu', message: '4 tools · ~1K tokens', color: 'brightgreen', cacheSeconds: 3600 });
  assert.equal(badge(menu(1, 90), []).message, '1 tool · ~90 tokens');
  const warned = badge(menu(12, 4120), [f('warn'), f('warn'), f('info')]);
  assert.equal(warned.message, '12 tools · ~4.1K tokens · 2 warnings');
  assert.equal(warned.color, 'yellow');
  const errored = badge(menu(12, 4120), [f('error'), f('warn')]);
  assert.equal(errored.message, '12 tools · ~4.1K tokens · 1 error', 'errors, not warnings too');
  assert.equal(errored.color, 'red');
});

test('githubRepo: https and ssh remotes', () => {
  assert.equal(githubRepo('https://github.com/acme/orders-mcp.git'), 'acme/orders-mcp');
  assert.equal(githubRepo('git@github.com:acme/orders-mcp.git'), 'acme/orders-mcp');
  assert.equal(githubRepo('https://github.com/acme/orders.mcp'), 'acme/orders.mcp');
  assert.equal(githubRepo('https://gitlab.com/acme/x.git'), undefined);
});

test('badgeMarkdown: the raw file on the default branch, linking to toolmenu', () => {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'trunk');
  git('remote', 'add', 'origin', 'git@github.com:acme/orders-mcp.git');
  const md = badgeMarkdown('server/toolmenu-badge.json', dir);
  const raw = 'https://raw.githubusercontent.com/acme/orders-mcp/trunk/server/toolmenu-badge.json';
  assert.equal(md, `[![toolmenu](https://img.shields.io/endpoint?url=${encodeURIComponent(raw)})](https://github.com/niksa90/toolmenu)`);
});

test('snapshot --badge writes the file and prints the README line on stderr', async () => {
  const cwd = tempDir();
  const r = await run(['snapshot', '--json', '--badge', 'toolmenu-badge.json', '--', process.execPath, join(FIXTURES, 'header-server.mjs')], { cwd });
  JSON.parse(r.stdout); // stdout stays the JSON report
  const b = JSON.parse(readFileSync(join(cwd, 'toolmenu-badge.json'), 'utf8'));
  assert.equal(b.schemaVersion, 1);
  assert.match(b.message, /^12 tools · ~[\d.]+K? tokens · 11 warnings$/);
  assert.equal(b.color, 'yellow');
  assert.match(r.stderr, /wrote the badge to toolmenu-badge\.json/);
  assert.match(r.stderr, /\[!\[toolmenu\]\(https:\/\/img\.shields\.io\/endpoint\?url=/);
});

test("toolmenu's own badge (docs/toolmenu-badge.json, in the README) matches its MCP server", async () => {
  const cwd = tempDir();
  await run(['snapshot', '--no-write', '--badge', 'b.json', '--', process.execPath, join(FIXTURES, '..', '..', 'dist', 'cli.js'), 'mcp'], { cwd });
  const committed = readFileSync(join(FIXTURES, '..', '..', 'docs', 'toolmenu-badge.json'), 'utf8');
  assert.equal(readFileSync(join(cwd, 'b.json'), 'utf8'), committed, 'regenerate it: node dist/cli.js snapshot --no-write --badge docs/toolmenu-badge.json -- node dist/cli.js mcp');
});
