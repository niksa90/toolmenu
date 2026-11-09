// bench/scripts/compare-weeks.py on two made-up weeks: what changed, fixes and
// regressions per stdio package, and the running trend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, ROOT, tempDir } from './helpers.mjs';

const HTTP_COLS = ['url', 'name', 'mode', 'protocol', 'tools', 'tokens', 'menu_hash', 'calls', 'answered', 'error', 'warn', 'info', 'review', 'tool_names'];
const STDIO_COLS = ['pkg', 'repo', 'protocol', 'tools', 'tokens', 'calls', 'answered', 'error', 'warn', 'info', 'review'];
const tsv = (cols, rows) => [cols.join('\t'), ...rows.map((r) => cols.map((c) => r[c] ?? '').join('\t'))].join('\n') + '\n';
const jsonl = (list) => list.map((x) => JSON.stringify(x)).join('\n') + '\n';
const folder = (url) => url.replace(/^https:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_');
const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: 'object' }, tokens: 10 });
const menu = (names) => ({ toolmenu: 1, server: { name: 'v', version: '1' }, tools: names.map(tool), totalTokens: 10 * names.length });

const VENDOR_COLS = ['id', 'server', 'via', 'status', 'protocol', 'tools', 'why'];
function week(dir, date, { vendorTools, mode, httpFindings, stdio, stdioFindings, vendors = [] }) {
  const d = join(dir, date);
  mkdirSync(join(d, 'http', 'menus'), { recursive: true });
  mkdirSync(join(d, 'stdio'), { recursive: true });
  const vendor = 'https://mcp.vendor.example/mcp';
  writeFileSync(join(d, 'http', 'menus', `${folder(vendor)}.json`), JSON.stringify(menu(vendorTools)));
  writeFileSync(
    join(d, 'http', 'servers.tsv'),
    tsv(HTTP_COLS, [
      { url: vendor, name: 'vendor', mode: 'open', tools: vendorTools.length, tokens: 10 * vendorTools.length, menu_hash: vendorTools.join('+'), calls: 0, answered: 0, error: 0, warn: 0, info: 0, tool_names: vendorTools.join(',') },
      { url: 'https://other.example/mcp', name: 'other', mode, tools: 0, tokens: 0, menu_hash: '', calls: 0, answered: 0, error: 0, warn: 0, info: 0, tool_names: '' },
    ]),
  );
  writeFileSync(join(d, 'http', 'findings.jsonl'), jsonl(httpFindings));
  writeFileSync(join(d, 'stdio', 'servers.tsv'), tsv(STDIO_COLS, stdio.map((pkg) => ({ pkg, error: 0, warn: 0, info: 0 }))));
  writeFileSync(join(d, 'stdio', 'findings.jsonl'), jsonl(stdioFindings));
  mkdirSync(join(d, 'vendors', 'menus'), { recursive: true });
  writeFileSync(join(d, 'vendors', 'servers.tsv'), tsv(VENDOR_COLS, vendors.map((v) => ({ id: v.id, server: v.server, via: 'npm', status: v.tools.length ? 'ok' : 'no-menu', tools: v.tools.length, why: v.why ?? '' }))));
  writeFileSync(join(d, 'vendors', 'findings.jsonl'), jsonl(vendors.flatMap((v) => (v.findings ?? []).map((rule) => ({ server: v.server, rule, kind: 'spec', severity: 'error', message: 'm' })))));
  for (const v of vendors) if (v.tools.length) writeFileSync(join(d, 'vendors', 'menus', `${v.id}.json`), JSON.stringify(menu(v.tools)));
  return d;
}

test('compare-weeks: menus changed, servers moved, fixes and regressions, and the trend', () => {
  const dir = tempDir();
  const f = (url, rule, severity = 'error', kind = 'spec') => ({ url, name: 'x', command: 'snapshot', rule, kind, severity, message: 'm' });
  const p = (pkg, rule, severity = 'error', kind = 'spec') => ({ pkg, command: 'snapshot', rule, kind, severity, message: 'm' });
  const prev = week(dir, '2026-11-09', {
    vendorTools: ['get_a', 'get_b'],
    mode: 'open',
    httpFindings: [f('https://mcp.vendor.example/mcp', 'spec/schema'), f('https://other.example/mcp', 'lists/schema')],
    stdio: ['fixed-pkg@1.0.0', 'broken-pkg@1.0.0'],
    stdioFindings: [p('fixed-pkg@1.0.0', 'spec/schema')],
    vendors: [{ id: 'pay', server: '@pay/mcp@1.0.0', tools: ['list_tx', 'refund'], findings: ['menu/nondeterministic'] }, { id: 'gone', server: 'gone-mcp@1.0.0', tools: ['a'] }],
  });
  const cur = week(dir, '2026-11-16', {
    vendorTools: ['get_a'],
    mode: 'oauth',
    httpFindings: [f('https://other.example/mcp', 'lists/schema'), f('https://other.example/mcp', 'session/result-type')],
    stdio: ['fixed-pkg@1.1.0', 'broken-pkg@1.1.0', 'brand-new@0.1.0'],
    stdioFindings: [p('broken-pkg@1.1.0', 'menu/duplicate-name', 'error', 'client')],
    vendors: [{ id: 'pay', server: '@pay/mcp@1.1.0', tools: ['list_tx'] }, { id: 'gone', server: 'gone-mcp@1.1.0', tools: [], why: 'ModuleNotFoundError' }],
  });
  const r = spawnSync('python3', ['-I', join(ROOT, 'bench/scripts/compare-weeks.py'), prev, cur, CLI], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /1 menus changed, 1 servers changed how they answer/);
  assert.match(out, /\| other \(`https:\/\/other\.example\/mcp`\) \| open \| oauth \|/);
  assert.match(out, /\*\*vendor\*\* \(`https:\/\/mcp\.vendor\.example\/mcp`\): removed get_a|removed get_b/);
  assert.match(out, /review: \*\*breaking\*\*/, 'the vendor menu lost a tool: review says breaking');
  assert.match(out, /gone from vendor: `spec\/schema` \(error\)/);
  assert.match(out, /new on other: `session\/result-type` \(error\)/);
  assert.match(out, /3 rechecked: 2 new releases of servers checked before, 1 servers new to the bench/);
  assert.match(out, /fixed in `fixed-pkg@1\.1\.0` \(was `fixed-pkg@1\.0\.0`\): `spec\/schema`/);
  assert.match(out, /new in `broken-pkg@1\.1\.0` \(was `broken-pkg@1\.0\.0`\): `menu\/duplicate-name` \(error\)/);
  assert.match(out, /### Vendors' own servers\n\n2 this week, 2 also last week: 2 new releases, 1 menus changed, 0 started that didn't, 1 stopped\./);
  assert.match(out, /- stopped starting: `gone-mcp@1\.1\.0`: ModuleNotFoundError/);
  assert.match(out, /- menu changed: `@pay\/mcp@1\.1\.0`: removed refund \(2 → 1 tools\) · review: \*\*breaking\*\*/);
  assert.match(out, /- fixed in `@pay\/mcp@1\.1\.0`: `menu\/nondeterministic`/);
  const trend = readFileSync(join(dir, 'trend.tsv'), 'utf8').trim().split('\n');
  assert.equal(trend.length, 2, 'a header and this week');
  assert.deepEqual(trend[1].split('\t'), ['2026-11-16', '2', '1', '1', '1', '1', '3', '1', '2', '1', '1']);
  // Run again for the same week: the line is replaced, not added twice.
  spawnSync('python3', ['-I', join(ROOT, 'bench/scripts/compare-weeks.py'), prev, cur, CLI], { encoding: 'utf8' });
  assert.equal(readFileSync(join(dir, 'trend.tsv'), 'utf8').trim().split('\n').length, 2);
});
