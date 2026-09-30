import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultQueries, findCatalogTool, leadingJson, mentionedNames, operationsIn } from '../dist/catalog.js';
import { FIXTURES, menuOf, run, tempDir, tool } from './helpers.mjs';

const server = (fixture, version = '1') => ['--env', `FIXTURE=${fixture}`, '--env', `CATALOG_VERSION=${version}`, '--', process.execPath, join(FIXTURES, 'raw-server.mjs')];

test('findCatalogTool: a read-only search with one required query, named like one', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const q = { inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  assert.equal(findCatalogTool([tool('search_sentry_tools', [], { ...ro, ...q })])?.name, 'search_sentry_tools');
  assert.equal(findCatalogTool([tool('discover', [], { ...ro, ...q })])?.name, 'discover');
  assert.equal(findCatalogTool([tool('search_issues', [], { ...ro, ...q })]), undefined);
  assert.equal(findCatalogTool([tool('search_sentry_tools', [], q)]), undefined, 'not read-only');
});

test('operationsIn: standard definitions and Atlassian-style inputs', () => {
  const std = operationsIn({ structuredContent: { results: [{ name: 'a', description: 'A.', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }, { name: 'not_an_op' }] } });
  assert.deepEqual(std.map((o) => o.name), ['a']);
  const atl = operationsIn({ content: [{ type: 'text', text: JSON.stringify({ results: [{ name: 'listJiraIssueWorklogs', inputs: [{ name: 'cloudId', type: 'string', required: true }, { name: 'startAt', type: 'number', integer: true, minimum: 0, repairHint: 'Zero-based.' }] }] }) }] });
  assert.deepEqual(atl[0].inputSchema, { type: 'object', properties: { cloudId: { type: 'string' }, startAt: { type: 'integer', minimum: 0, repairHint: 'Zero-based.' } }, required: ['cloudId'] });
  assert.deepEqual(operationsIn({ content: [{ type: 'text', text: 'Found 3 operations: …' }] }), []);
});

test('defaultQueries: the same menu gives the same queries', () => {
  const m = menuOf([tool('list_releases'), tool('get_issue'), tool('update_issue')]).tools;
  assert.deepEqual(defaultQueries(m), defaultQueries(m));
  assert.equal(defaultQueries(m)[0], 'list issue');
});

for (const fixture of ['catalog', 'catalog-inputs']) {
  test(`cli: snapshot --catalog, then diff finds a breaking change behind the search tool (${fixture})`, async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0 } }));
    const a = await run(['snapshot', '--catalog', '--out', 'v1.json', ...server(fixture, '1')], { cwd });
    assert.equal(a.code, 0, a.stderr);
    const menu = JSON.parse(readFileSync(join(cwd, 'v1.json'), 'utf8'));
    assert.equal(menu.catalog.tool, 'search_ops_tools');
    assert.deepEqual(menu.catalog.operations.map((o) => o.name), ['delete_release', 'get_release', 'list_releases']);
    await run(['snapshot', '--catalog', '--out', 'v2.json', ...server(fixture, '2')], { cwd });
    const d = await run(['diff', '--json', 'v1.json', 'v2.json'], { cwd });
    const findings = JSON.parse(d.stdout).findings;
    const rules = findings.map((f) => f.rule).sort();
    assert.ok(rules.includes('diff/param-required'), rules.join(','));
    assert.ok(rules.includes('diff/catalog-missing'));
    const breaking = findings.find((f) => f.rule === 'diff/param-required');
    assert.match(breaking.message, /^Behind `search_ops_tools`: `get_release\.region` is new and required/);
    assert.equal(breaking.severity, 'error');
    assert.equal(findings.find((f) => f.rule === 'diff/catalog-missing').severity, 'info');
    assert.equal(d.code, 1);
  });
}

test('cli: a rate-limited search is retried; one that stays limited leaves a partial catalog, not a failed snapshot', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0, queries: ['list releases'] } }));
  const withEnv = (v) => ['--env', `RATE_LIMIT=${v}`, ...server('catalog')];
  const once = await run(['snapshot', '--catalog', '--out', 'once.json', ...withEnv('first')], { cwd });
  assert.equal(once.code, 0, once.stderr);
  const a = JSON.parse(readFileSync(join(cwd, 'once.json'), 'utf8')).catalog;
  assert.equal(a.failed, undefined);
  assert.ok(a.operations.length > 0);
  const always = await run(['snapshot', '--catalog', '--out', 'always.json', ...withEnv('always')], { cwd });
  assert.equal(always.code, 0, always.stderr);
  const b = JSON.parse(readFileSync(join(cwd, 'always.json'), 'utf8')).catalog;
  assert.deepEqual(b.failed.map((f) => f.query), ['list releases']);
  assert.deepEqual(b.operations, []);
  const d = await run(['diff', '--json', 'once.json', 'always.json'], { cwd });
  const rules = JSON.parse(d.stdout).findings.map((f) => f.rule);
  assert.ok(rules.includes('diff/catalog-queries'));
  assert.equal(d.code, 0, 'a partial catalog is never breaking');
});

test('leadingJson and mentionedNames: JSON followed by prose (Atlassian discover)', () => {
  const text = '{"results":[{"name":"listJiraIssueWorklogs","inputs":[]}]}\n\nRelated:\n  createJiraBoard — Create a board\n  - `getJiraProjectVersions` — List versions\nNot a name — just prose, twice over';
  assert.deepEqual(leadingJson(text), { results: [{ name: 'listJiraIssueWorklogs', inputs: [] }] });
  assert.equal(leadingJson('Found nothing.'), undefined);
  assert.deepEqual(operationsIn({ content: [{ type: 'text', text }] }).map((o) => o.name), ['listJiraIssueWorklogs']);
  assert.deepEqual(mentionedNames({ content: [{ type: 'text', text }] }), ['createJiraBoard', 'getJiraProjectVersions']);
});

test('cli: the crawl follows the catalog\'s own names to operations no seed query finds, then stops', async () => {
  const cwd = tempDir();
  // One seed that matches only list_releases; the rest are reached by name.
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0, queries: ['list'] } }));
  await run(['snapshot', '--catalog', '--out', 'crawl.json', ...server('catalog-inputs')], { cwd });
  const crawled = JSON.parse(readFileSync(join(cwd, 'crawl.json'), 'utf8')).catalog;
  assert.deepEqual(crawled.operations.map((o) => o.name), ['delete_release', 'get_release', 'list_releases']);
  assert.ok(crawled.queries.length > 1 && crawled.queries.length < 10, crawled.queries.join(' | '));
  writeFileSync(join(cwd, 'toolmenu.config.json'), JSON.stringify({ catalog: { pauseMs: 0, queries: ['list'], crawl: false } }));
  await run(['snapshot', '--catalog', '--out', 'seeds.json', ...server('catalog-inputs')], { cwd });
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'seeds.json'), 'utf8')).catalog.operations.map((o) => o.name), ['list_releases']);
});

