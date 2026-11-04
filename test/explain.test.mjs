// toolmenu explain <rule>: docs/RULES.md, shipped as dist/rule-docs.json, covers every
// rule the code can report, and nothing the code no longer reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './helpers.mjs';
import { ruleDocs } from '../dist/rule-docs.js';
import { MENU_RULES } from '../dist/rules/index.js';
import { DIFF_RULES } from '../dist/diff.js';

/** Every rule id written in the source: a rule's id, a finding's rule, a fail('…') call. */
function idsInSource() {
  const ids = new Set([...MENU_RULES.map((r) => r.id), ...Object.keys(DIFF_RULES)]);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:\brule: |\bid: |fail\()'([a-z]+\/[a-z0-9-]+)'/g)) ids.add(m[1]);
        for (const m of src.matchAll(/'((?:menu|session)\/[a-z0-9-]+)'/g)) ids.add(m[1]);
      }
    }
  };
  walk('src');
  return ids;
}

test('every rule the code reports has an entry in docs/RULES.md, and every entry is a rule', () => {
  const docs = ruleDocs();
  const code = idsInSource();
  assert.deepEqual([...code].filter((id) => !docs[id]).sort(), [], 'rules without an entry');
  assert.deepEqual(Object.keys(docs).filter((id) => !code.has(id)).sort(), [], 'entries for no rule');
  for (const r of MENU_RULES) assert.equal(docs[r.id].severity.split(/[ ,]/)[0], r.severity, `${r.id}: the severity in RULES.md`);
  for (const [id, r] of Object.entries(DIFF_RULES)) assert.match(docs[id].severity, new RegExp(`^${r.severity}${r.class ? ` \\(${r.class}\\)` : ''}$`), `${id}: severity and class in RULES.md`);
});

test('explain: by id, or by the part after the slash; JSON with --json', async () => {
  const r = await run(['explain', 'naming/vague-id']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^naming\/vague-id {2}\(snapshot, warn\)\n\n {2}A parameter named id, ids or key/);
  assert.match(r.stdout, /\{ "rules": \{ "naming\/vague-id": "off" \} \}/);
  assert.equal((await run(['explain', 'vague-id'])).stdout, r.stdout);
  const j = JSON.parse((await run(['explain', '--json', 'diff/param-required'])).stdout);
  assert.deepEqual([j.rule, j.command, j.severity, j.class], ['diff/param-required', 'diff', 'error', 'breaking']);
  const since = JSON.parse((await run(['explain', '--json', 'handle-lifetime'])).stdout);
  assert.equal(since.since, '2026-07-28');
  assert.match((await run(['explain', 'handle-lifetime'])).stdout, /Checked on servers that speak 2026-07-28 or later\./);
});

test('explain: an unknown rule names the closest; no rule lists them all', async () => {
  const typo = await run(['explain', 'diff/param-requird']);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /No rule "diff\/param-requird"\. Did you mean diff\/param-required/);
  const none = await run(['explain', 'nothing-like-this-at-all']);
  assert.equal(none.code, 2);
  assert.doesNotMatch(none.stderr, /Did you mean/);
  const all = await run(['explain']);
  assert.equal(all.code, 0);
  assert.match(all.stdout, /\nsnapshot:\n/);
  assert.match(all.stdout, /\ndiff:\n/);
  assert.match(all.stdout, /\nsession:\n/);
  const both = await run(['explain', 'a', 'b']);
  assert.equal(both.code, 2);
  const server = await run(['explain', '--', 'node', 'x.js']);
  assert.equal(server.code, 2);
  assert.match(server.stderr, /not a server/);
});
