import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, placeOf, searchText } from '../dist/search.js';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { menuOf, tool } from './helpers.mjs';

// Real menus this size run past 10K tokens; these test tools are tiny, so say so.
function findings(tools, ctx = {}, totalTokens = 20_000) {
  const menu = { ...menuOf(tools), totalTokens };
  return runRules(MENU_RULES, { menu, pages: [], capabilities: { tools: {} }, usedAuth: false, ...ctx }).filter((f) => f.rule === 'search/findable');
}

// Ten small tools, each about its own object, so a search for any of them by name finds it first.
const fillers = ['invoice', 'customer', 'payment', 'refund', 'coupon', 'product', 'order', 'shipment', 'tax_rate'].map((o) =>
  tool(`get_${o}`, [`${o}_id`], { description: `Get one ${o.replace('_', ' ')} by its ID.` }),
);

test('searchText: the name, description, argument names and argument descriptions, nested ones too', () => {
  const t = tool('list_issues', [], {
    description: 'Lists issues.',
    inputSchema: { type: 'object', properties: { filter: { type: 'object', description: 'Which ones', properties: { label: { type: 'string', description: 'A tag' } } } } },
  });
  assert.deepEqual(searchText(t), ['list', 'issue', 'list', 'issue', 'filter', 'which', 'one', 'label', 'tag']);
});

test('buildIndex: the tool named for the words ranks first; a rarer word weighs more', () => {
  const index = buildIndex(fillers);
  assert.equal(index.rank('get refund')[0].tool, 'get_refund');
  assert.equal(placeOf(index, 'tax rate', 'get_tax_rate').place, 1);
  assert.equal(placeOf(index, 'weather', 'get_refund').place, undefined, 'no shared word: not returned at all');
});

test('search/findable: a tool whose description never says its own words loses to tools that keep saying them', () => {
  // longbook's read_guide: "Returns longbook's llms.txt — the contract and working
  // method…", while other tools tell the agent to read the guide.
  const guide = tool('read_guide', [], { description: 'Returns the llms.txt: the contract and working method, whole or one chapter.' });
  const noisy = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((n) =>
    tool(`run_${n}`, [], { description: `Runs ${n}. Read the guide first.` }),
  );
  const [f] = findings([...fillers, ...noisy, guide]);
  assert.equal(f?.tool, 'read_guide');
  assert.equal(f.severity, 'info');
  assert.equal(f.confidence, 'unsure');
  assert.match(f.message, /doesn't come up in the top 5 when searched for by its own name/);
  assert.match(f.detail[0], /^read_guide: “read guide” puts it at 7, behind run_/);
});

test('search/findable: small menus are left alone; a shared prefix is not the query unless only a verb is left', () => {
  assert.deepEqual(findings(fillers.slice(0, 5)), [], 'under 10 tools: a client loads them all');
  const guide = tool('read_guide', [], { description: 'Read the guide.' });
  const noisy = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((n) => tool(`run_${n}`, [], { description: `Read the guide; the guide, the guide.` }));
  assert.deepEqual(findings([...fillers, ...noisy, guide], {}, 3_000), [], 'under 30 tools and 10K tokens: a client loads them all');
  assert.deepEqual(findings(fillers), [], 'every tool first for its own name');
  // Every tool starts with ads_: "create" alone isn't a search, so the prefix stays in it.
  const ads = ['list_uploads', 'list_pages', 'get_job', 'save_build', 'update_build', 'list_presets', 'get_page', 'list_builds', 'get_upload', 'get_preset', 'get_build']
    .map((n) => tool(`ads_${n}`, [], { description: `Ads ${n.replace('_', ' ')}.` }));
  const create = tool('ads_create', [], { description: 'Creates ads.' });
  const r = findings([...ads, create]);
  assert.ok(!r.some((f) => /“create” puts/.test(f.detail?.join(' ') ?? '')), 'never a bare-verb query');
});

test('search/findable: a routes.yml keyword whose tool falls past the top 5 warns', () => {
  const target = tool('summarize_audits', [], { description: 'Summary of audit scores.' });
  const crowd = ['list', 'get', 'export', 'archive', 'compare', 'count'].map((v) =>
    tool(`${v}_audit_results`, [], { description: `${v} audit results for a team audit.` }),
  );
  const routes = { 'team audit results': { must_match: ['summarize_audits'] } };
  const all = [...fillers, ...crowd, target];
  const r = findings(all, { routes });
  const route = r.find((f) => f.severity === 'warn');
  assert.equal(route?.tool, 'summarize_audits');
  assert.match(route.message, /routes\.yml says “team audit results” should reach summarize_audits, but a tool search for “team audit results” puts it at 7/);
});
