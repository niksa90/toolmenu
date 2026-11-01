// spec/x-mcp-header, end to end: real fixture servers (2026-07-28 and 2025, stdio and
// HTTP), the CLI, and the official SDK client as the referee for which tools a
// compliant HTTP client drops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FIXTURES, run } from './helpers.mjs';
import { start } from './fixtures/http-server.mjs';
import { build, BROKEN, VALID } from './fixtures/header-server.mjs';
import { headerFaults } from '../dist/rules/headers.js';

const server = join(FIXTURES, 'header-server.mjs');
const RULE = 'spec/x-mcp-header';
const findingsOf = (stdout) => JSON.parse(stdout).findings.filter((f) => f.rule === RULE);

// What each broken tool's finding has to say: the place and the reason.
const EXPECT = {
  header_in_items: /ids\.<items> \(x-mcp-header: "Id"\): it sits under items/,
  header_in_anyof: /target\.<anyOf> \(x-mcp-header: "Target"\): it sits under anyOf/,
  header_on_root: /the schema root \(x-mcp-header: "Query"\): it sits on the schema root, not on a parameter/,
  header_bad_token: /region \(x-mcp-header: "Region Name"\): "Region Name" isn't a valid HTTP header name/,
  header_empty: /region: the header name must be a non-empty string/,
  header_on_object: /scope \(x-mcp-header: "Scope"\): the parameter is an object/,
  header_no_type: /region \(x-mcp-header: "Region"\): the parameter has no "type"/,
  header_type_list: /the parameter's type is \["string","null"\]/,
  header_duplicate: /zone \(x-mcp-header: "region"\): "region" is already used by region \("Region"\)/,
  header_number: /ratio \(x-mcp-header: "Ratio"\): the parameter is a number/,
};

test('spec/x-mcp-header over stdio: every broken annotation is a warning that names its place and reason; valid ones are quiet', async () => {
  const r = await run(['snapshot', '--no-write', '--json', '--', process.execPath, server]);
  const findings = findingsOf(r.stdout);
  assert.deepEqual(findings.map((f) => f.tool).sort(), Object.keys(BROKEN).sort(), 'one finding per broken tool, none for the valid ones');
  for (const f of findings) {
    assert.equal(f.severity, 'warn', `${f.tool}: stdio clients may ignore the annotation, so a warning`);
    assert.match(f.detail.join('\n'), EXPECT[f.tool], f.tool);
    assert.ok(f.fix, `${f.tool} has a next step`);
  }
  const items = findings.find((f) => f.tool === 'header_in_items');
  assert.match(items.message, /Streamable HTTP clients must then leave the whole tool out of their menu/);
  assert.match(items.message, /Over stdio clients may ignore the annotation, so it shows here; served over HTTP, it would be gone\./);
  assert.match(items.fix, /Then list the tools over HTTP with an SDK client and check header_in_items is there\./);
  const number = findings.find((f) => f.tool === 'header_number');
  assert.match(number.message, /the official SDK client keeps it for now/);
  assert.match(number.fix, /Make the parameter a string or an integer/);
  // Text output too: the finding and its next step.
  const text = await run(['snapshot', '--no-write', '--', process.execPath, server]);
  assert.match(text.stdout, /WARN {3}spec\/x-mcp-header\n {7}header_on_root has an x-mcp-header annotation/);
});

test('spec/x-mcp-header over HTTP: exactly the tools the official SDK client drops are errors; number is a warning', async () => {
  const s = await start({ factory: build });
  try {
    const r = await run(['snapshot', '--no-write', '--json', s.url]);
    const out = JSON.parse(r.stdout);
    const findings = findingsOf(r.stdout);
    const errors = findings.filter((f) => f.severity === 'error').map((f) => f.tool).sort();
    assert.deepEqual(findings.filter((f) => f.severity === 'warn').map((f) => f.tool), ['header_number']);
    assert.match(findings.find((f) => f.tool === 'header_in_items').message, /toolmenu reads the list off the wire, which is why it is in this menu\./);
    // toolmenu reads the wire, so the dropped tools are still in its menu.
    assert.equal(out.tools.length ?? out.tools, Object.keys(VALID).length + Object.keys(BROKEN).length);
    // The SDK's own warning would repeat every finding; toolmenu keeps it off stderr.
    assert.doesNotMatch(r.stderr, /\[mcp-sdk\] excluding tool/);

    // The referee: what a compliant SDK client actually lists over HTTP.
    const warn = console.warn;
    console.warn = () => {};
    // On 2026-07-28, as toolmenu negotiates: the SDK drops tools only on that era over HTTP.
    const client = new Client({ name: 'referee', version: '0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(s.url)));
      const listed = new Set((await client.listTools()).tools.map((t) => t.name));
      const dropped = [...Object.keys(VALID), ...Object.keys(BROKEN)].filter((n) => !listed.has(n)).sort();
      assert.deepEqual(errors, dropped, 'errors are exactly the tools the SDK client hides');
      for (const n of Object.keys(VALID)) assert.ok(listed.has(n), `${n} is valid and listed`);
    } finally {
      console.warn = warn;
      await client.close();
    }
  } finally {
    await s.close();
  }
});

test('spec/x-mcp-header: a 2025 server and a server with only valid annotations get no finding', async () => {
  // toolmenu starts a stdio server with a minimal environment: settings go through --env.
  const legacy = await run(['snapshot', '--no-write', '--json', '--env', 'LEGACY=1', '--', process.execPath, server]);
  assert.equal(JSON.parse(legacy.stdout).server.protocolVersion < '2026-07-28', true);
  assert.deepEqual(findingsOf(legacy.stdout), [], 'the rule is for 2026-07-28');
  const valid = await run(['snapshot', '--no-write', '--json', '--env', 'HEADERS=valid', '--', process.execPath, server]);
  assert.deepEqual(findingsOf(valid.stdout), []);
});

test('headerFaults: every broken annotation in a tool, where the SDK client stops at the first', () => {
  const faults = headerFaults({
    name: 'many',
    inputSchema: { type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'B C' }, c: { type: 'number', 'x-mcp-header': 'C' } } },
  });
  assert.deepEqual(faults.map((f) => [f.path, f.dropped]), [['a', true], ['b', true], ['c', false]]);
});

test('diff/x-mcp-header: a header added, removed or renamed between releases is said as such, not as an unclassified keyword', async () => {
  const { writeFileSync } = await import('node:fs');
  const { tempDir } = await import('./helpers.mjs');
  const { buildMenu } = await import('../dist/menu.js');
  const dir = tempDir();
  const menu = (headers) =>
    buildMenu(
      Object.entries(headers).map(([name, h]) => ({ name, description: `${name}.`, inputSchema: { type: 'object', properties: { region: { type: 'string', ...(h ? { 'x-mcp-header': h } : {}) } } } })),
      { name: 's', version: '1.0.0' },
    );
  writeFileSync(join(dir, 'a.json'), JSON.stringify(menu({ added: null, removed: 'Region', renamed: 'Region', same: 'Region' })));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(menu({ added: 'Region', removed: null, renamed: 'Zone', same: 'Region' })));
  const r = await run(['diff', '--json', join(dir, 'a.json'), join(dir, 'b.json')]);
  const found = JSON.parse(r.stdout).findings;
  assert.ok(!found.some((f) => f.rule === 'diff/schema-other'), 'no "doesn\'t classify" notice for a header');
  const by = Object.fromEntries(found.filter((f) => f.rule === 'diff/x-mcp-header').map((f) => [f.tool, f]));
  assert.deepEqual(Object.keys(by).sort(), ['added', 'removed', 'renamed']);
  assert.match(by.added.message, /`added\.region`: now mirrored into the Mcp-Param-Region HTTP header\. Proxies, load balancers and WAFs can route on it/);
  assert.match(by.removed.message, /no longer mirrored into the Mcp-Param-Region HTTP header\. Anything that routes on that header stops seeing it\./);
  assert.match(by.removed.fix, /If a proxy, load balancer or WAF rule matches Mcp-Param-Region, change it before this release ships\./);
  assert.match(by.renamed.message, /its HTTP header was renamed, Mcp-Param-Region → Mcp-Param-Zone/);
  for (const f of Object.values(by)) assert.equal(f.severity, 'info');
});

test('headerFaults: a duplicate involving a number parameter is caught, and drops the tool as the SDK client does', () => {
  const faults = headerFaults({
    name: 'dup',
    inputSchema: { type: 'object', properties: { a: { type: 'number', 'x-mcp-header': 'Region' }, b: { type: 'string', 'x-mcp-header': 'region' } } },
  });
  assert.deepEqual(faults.map((f) => [f.path, f.dropped]), [['a', false], ['b', true]]);
  assert.match(faults[1].problem, /"region" is already used by a \("Region"\)/);
});

test('diff/x-mcp-header-invalid: a 2026 release whose header makes HTTP clients drop the tool is warned about', async () => {
  const { writeFileSync } = await import('node:fs');
  const { tempDir } = await import('./helpers.mjs');
  const { buildMenu } = await import('../dist/menu.js');
  const dir = tempDir();
  const menu = (header, protocolVersion = '2026-07-28') => buildMenu([{ name: 'q', description: 'Q.', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': header } } } }], { name: 's', version: '1.0.0', protocolVersion });
  writeFileSync(join(dir, 'a.json'), JSON.stringify(menu('Region')));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(menu('Re gion')));
  writeFileSync(join(dir, 'c.json'), JSON.stringify(menu('Zone')));
  const broke = JSON.parse((await run(['diff', '--json', join(dir, 'a.json'), join(dir, 'b.json')])).stdout).findings;
  const invalid = broke.find((f) => f.rule === 'diff/x-mcp-header-invalid');
  // A warning: a menu file doesn't say whether the server runs over HTTP.
  assert.equal(invalid?.severity, 'warn');
  assert.match(invalid.message, /Streamable HTTP clients must leave the tool out of their menu/);
  assert.match(invalid.detail[0], /"Re gion" isn't a valid HTTP header name/);
  // A valid rename is only the notice.
  const renamed = JSON.parse((await run(['diff', '--json', join(dir, 'a.json'), join(dir, 'c.json')])).stdout).findings;
  assert.ok(!renamed.some((f) => f.rule === 'diff/x-mcp-header-invalid'));
  assert.ok(renamed.some((f) => f.rule === 'diff/x-mcp-header'));
  // On a 2025 server the annotation means nothing: no invalid-header finding.
  writeFileSync(join(dir, 'd.json'), JSON.stringify(menu('Region', '2025-11-25')));
  writeFileSync(join(dir, 'e.json'), JSON.stringify(menu('Re gion', '2025-11-25')));
  const legacy = JSON.parse((await run(['diff', '--json', join(dir, 'd.json'), join(dir, 'e.json')])).stdout).findings;
  assert.ok(!legacy.some((f) => f.rule === 'diff/x-mcp-header-invalid'));
  // Moving to 2026-07-28 with the bad annotation still in place: now HTTP clients drop it.
  const upgrade = JSON.parse((await run(['diff', '--json', join(dir, 'e.json'), join(dir, 'b.json')])).stdout).findings;
  assert.ok(upgrade.some((f) => f.rule === 'diff/x-mcp-header-invalid'), 'the first 2026 release is when it starts to count');
  // A new tool with a bad annotation: dropped on arrival.
  const fresh = buildMenu([{ name: 'other', description: 'O.', inputSchema: { type: 'object', properties: {} } }], { name: 's', version: '1.0.0', protocolVersion: '2026-07-28' });
  writeFileSync(join(dir, 'f.json'), JSON.stringify(fresh));
  const added = JSON.parse((await run(['diff', '--json', join(dir, 'f.json'), join(dir, 'b.json')])).stdout).findings;
  assert.deepEqual(added.filter((f) => f.rule === 'diff/x-mcp-header-invalid').map((f) => f.tool), ['q']);
});
