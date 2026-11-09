// False positives, two ways.
//
// 1. A server that does everything right (fixtures/clean-server.mjs) gets no finding
//    from any command or option toolmenu can run on it, on either protocol. A rule
//    that starts firing there is wrong until shown otherwise.
// 2. Real servers' menus (fixtures/corpus, fixtures/menus) get exactly the findings
//    recorded in fixtures/golden/findings.json: rule, level and tool, by menu, and for
//    diff between consecutive filesystem releases. An engine change that adds, drops or
//    re-levels a finding on a real server fails here, so it can't ship unexplained.
//    UPDATE_GOLDEN=1 writes the file again; the diff of it is the change to review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { diffMenus } from '../dist/diff.js';
import { FIXTURES, menuOf, run, tempDir } from './helpers.mjs';

const CLEAN = ['--', process.execPath, join(FIXTURES, 'clean-server.mjs')];
const LEGACY = ['--env', 'LEGACY=1'];
// On 2025, saying the server isn't on 2026-07-28 yet is a fact, not a false positive.
const ON_2025 = new Set(['spec/discover']);

async function json(args) {
  const r = await run(['--format', 'json', ...args]);
  assert.ok(r.code === 0, `${args.join(' ')} exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
const findingsOf = (report, legacy) => report.findings.filter((f) => !(legacy && ON_2025.has(f.rule))).map((f) => `${f.rule} (${f.severity}): ${f.message}`);

for (const legacy of [false, true]) {
  const era = legacy ? '2025' : '2026-07-28';
  const env = legacy ? LEGACY : [];

  test(`clean server (${era}): snapshot finds nothing, with every check on`, async () => {
    const plain = await json(['snapshot', '--no-write', ...env, ...CLEAN]);
    assert.equal(plain.server.protocolVersion, legacy ? '2025-11-25' : '2026-07-28');
    assert.deepEqual(findingsOf(plain, legacy), []);
    // Lists, identities and the offline check each add rules; each must have run.
    const all = await json(['snapshot', '--no-write', '--lists', 'prompts,resources', '--as', 'reader:ROLE=reader', '--as', 'admin:ROLE=admin', '--offline-check', ...env, ...CLEAN]);
    assert.equal(all.prompts, 1, 'prompts were read');
    assert.equal(all.resources, 1, 'resources were read');
    assert.equal(all.resourceTemplates, 1, 'resource templates were read');
    assert.deepEqual(findingsOf(all, legacy), []);
  });

  test(`clean server (${era}): snapshot --client finds nothing for any client`, async () => {
    for (const client of ['claude-code', 'claude-api-search', 'openai']) {
      assert.deepEqual(findingsOf(await json(['snapshot', '--no-write', '--client', client, ...env, ...CLEAN]), legacy), [], client);
    }
  });

  test(`clean server (${era}): session --auto calls its read-only tools and finds nothing`, async () => {
    const r = await json(['session', '--auto', ...env, ...CLEAN]);
    assert.ok(r.steps.filter((s) => s.outcome === 'answered').length >= 2, 'tools were called');
    assert.equal(r.connectionCheck, 'same', 'a second process was compared');
    assert.deepEqual(findingsOf(r, legacy), []);
  });
}

test('clean server: diff of its menu against itself, and across protocols, finds nothing', async () => {
  const dir = tempDir();
  for (const [file, env] of [['modern.json', []], ['legacy.json', LEGACY]]) {
    const r = await run(['snapshot', '--out', join(dir, file), ...env, ...CLEAN]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  }
  for (const [a, b] of [['modern.json', 'modern.json'], ['legacy.json', 'modern.json']]) {
    const d = await json(['diff', join(dir, a), join(dir, b)]);
    assert.deepEqual(d.findings.map((f) => `${f.rule}: ${f.message}`), [], `${a} → ${b}`);
  }
});

// ---- golden findings on real menus ----

const GOLDEN = join(FIXTURES, 'golden/findings.json');
const load = (dir, f) => JSON.parse(readFileSync(join(FIXTURES, dir, f), 'utf8'));
const real = [
  ...readdirSync(join(FIXTURES, 'corpus')).filter((f) => f.endsWith('.json')).map((f) => ['corpus', f]),
  ...readdirSync(join(FIXTURES, 'menus')).filter((f) => f.endsWith('.json')).map((f) => ['menus', f]),
].sort(([, a], [, b]) => a.localeCompare(b, 'en', { numeric: true }));

/** One line per finding: what a reviewer of a change needs to see move. */
const line = (f) => `${f.severity} ${f.rule}${f.class ? ` [${f.class}]` : ''}${f.tool ? ` ${f.tool}` : f.tools ? ` ${f.tools.join(',')}` : ''}`;

function current() {
  const out = { snapshot: {}, diff: {} };
  for (const [dir, f] of real) {
    const saved = load(dir, f);
    const menu = menuOf(saved.tools, saved.server ?? {});
    // The menu file alone: no second list, no probes, as a static check sees it.
    const findings = runRules(MENU_RULES, { menu, pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2025-11-25', era: 'legacy' }).filter((x) => x.rule !== 'spec/schema' && x.rule !== 'spec/discover');
    out.snapshot[f] = findings.map(line).sort();
  }
  const fs = real.filter(([dir]) => dir === 'menus').map(([dir, f]) => [f, load(dir, f)]);
  for (let i = 1; i < fs.length; i++) {
    const [a, before] = fs[i - 1];
    const [b, after] = fs[i];
    const d = diffMenus(menuOf(before.tools, before.server), menuOf(after.tools, after.server));
    out.diff[`${a} → ${b}`] = { bump: d.suggestedBump, findings: d.findings.map(line).sort() };
  }
  return out;
}

test('real menus: the findings recorded in fixtures/golden/findings.json, no more, no fewer', () => {
  const now = current();
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.ok(Object.keys(golden.snapshot).length >= 9 && Object.keys(golden.diff).length >= 3, 'every real menu is covered');
  assert.deepEqual(now, golden, 'Findings on real menus changed. If that is intended, UPDATE_GOLDEN=1 node --test test/clean.test.mjs and say why in the changelog.');
});
