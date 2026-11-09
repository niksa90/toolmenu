// Subschemas that aren't objects: JSON Schema allows true and false as a whole schema
// ("items": true, figma-mcp-rs 0.1.0 crashed diff and review), and broken servers send
// null, strings or numbers. Every analysis must take them without throwing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenu, compareMenus, diffMenus, MENU_RULES, reviewMenus, runRules, starterScenario } from '../dist/index.js';
import { autoScenario } from '../dist/auto.js';
import { breakdown } from '../dist/breakdown.js';
import { formatDiff } from '../dist/report.js';
import { formatReview } from '../dist/review.js';

const ODD = [true, false, null, 'x', 3, [], {}, { type: 'string' }];
const schema = (v) => ({
  type: 'object',
  properties: { a: { type: 'array', items: v }, b: v, id: v, c: { anyOf: [v, { type: 'string' }] }, c2: { oneOf: [{ type: 'object', properties: { k: { const: 'a' } } }, v] }, d: { type: 'object', properties: { e: v }, additionalProperties: v }, r: { $ref: '#/$defs/X' } },
  required: ['b'],
  $defs: { X: v },
});
const tools = (v) => [
  { name: 'get_thing', description: 'Get a thing. Returns thing_id.', inputSchema: schema(v), outputSchema: schema(v), annotations: { readOnlyHint: true } },
  { name: 'delete_thing', description: 'Delete a thing.', inputSchema: schema(v) },
];

test('every analysis takes subschemas that are booleans, null, strings, numbers or arrays', () => {
  const failed = [];
  for (const v of ODD) {
    for (const w of ODD) {
      const a = buildMenu(tools(v), { name: 's', version: '1.0.0' });
      const b = buildMenu(tools(w), { name: 's', version: '1.0.0' });
      const runs = {
        rules: () => runRules(MENU_RULES, { menu: a, secondList: b.tools, pages: [{ tools: tools(v) }], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2026-07-28', era: 'modern', client: 'claude-api-search' }),
        auto: () => autoScenario(a),
        breakdown: () => breakdown(a),
        diff: () => formatDiff(diffMenus(a, b), 2, 2, 'markdown'),
        review: () => formatReview(reviewMenus(a, b), ['a', 'b'], 'markdown'),
        starter: () => starterScenario(a),
        compare: () => compareMenus(a.tools, b.tools),
      };
      for (const [name, run] of Object.entries(runs)) {
        try {
          run();
        } catch (e) {
          failed.push(`${JSON.stringify(v)} → ${JSON.stringify(w)} ${name}: ${e.message}`);
        }
      }
    }
  }
  assert.deepEqual(failed.slice(0, 10), [], `${failed.length} failures`);
});

test('diff reads boolean schemas for what they accept: true is anything, false nothing', () => {
  const t = (items) => buildMenu([{ name: 't', description: 'T.', inputSchema: { type: 'object', properties: { a: { type: 'array', items } } } }], {});
  assert.deepEqual(diffMenus(t(true), t(true)).findings, []);
  assert.deepEqual(diffMenus(t(true), t({ type: 'string' })).findings.map((f) => f.rule), ['diff/param-type'], 'anything → strings narrows');
  assert.deepEqual(diffMenus(t({ type: 'string' }), t(true)).findings.map((f) => f.rule), ['diff/type-widened']);
  assert.deepEqual(diffMenus(t(true), t(false)).findings.map((f) => f.rule), ['diff/schema-other'], 'never silent');
});
