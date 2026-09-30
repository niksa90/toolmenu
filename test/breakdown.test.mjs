import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, breakdownLines } from '../dist/breakdown.js';
import { countTokens } from '../dist/menu.js';
import { menuOf, run, FIXTURES, tool } from './helpers.mjs';
import { join } from 'node:path';

test('breakdown: top tools with their split, big enums, parameters repeated byte for byte', () => {
  const lang = { type: 'string', enum: Array.from({ length: 30 }, (_, i) => `lang-${i}`), description: 'The language of the results.' };
  const tools = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => tool(`search_${n}`, [], { inputSchema: { type: 'object', properties: { query: { type: 'string' }, ui_lang: lang } } }));
  tools.push(tool('big', [], { description: 'Long. '.repeat(300) }));
  const b = breakdown(menuOf(tools));
  assert.equal(b.top[0].name, 'big');
  assert.ok(b.top[0].description > b.top[0].schema);
  assert.equal(b.enums[0].values, 30);
  assert.deepEqual(b.repeated.map((r) => [r.param, r.tools]), [['ui_lang', 6]]);
  const lines = breakdownLines(b, tools.length);
  assert.match(lines[0], /^Where the tokens go \(estimate\): the top 5 tools are \d+% of the menu$/);
  assert.ok(lines.some((l) => /repeated: ui_lang .* in 6 tools/.test(l)));
  assert.deepEqual(breakdownLines(breakdown(menuOf(tools.slice(0, 3))), 3), []);
});

test('breakdown: one block repeated inside a single tool, reported once, with what $defs could save', () => {
  // The case from the review: one block ×5 in content_generateMessageHtml.
  const style = { type: 'string', enum: ['plain', 'bold', 'italic', 'code', 'quote'], description: 'How the text is styled when rendered in the message.' };
  const block = { type: 'object', description: 'A section of the generated message.', properties: { text: { type: 'string', description: 'The text of the section, in markdown.' }, style, align: { type: 'string', enum: ['left', 'center', 'right'] } }, required: ['text'] };
  const props = Object.fromEntries(['header', 'intro', 'body', 'outro', 'footer'].map((k) => [k, block]));
  const html = tool('content_generateMessageHtml', [], { inputSchema: { type: 'object', properties: { options: { type: 'object', properties: props } } } });
  const b = breakdown(menuOf([html]));
  assert.equal(b.repeated.length, 1, JSON.stringify(b.repeated.map((r) => r.where)));
  const [r] = b.repeated;
  assert.deepEqual([r.count, r.tools, r.within, r.withinTool], [5, 1, 5, 'content_generateMessageHtml']);
  assert.deepEqual(r.where, ['content_generateMessageHtml.options.header', 'content_generateMessageHtml.options.intro', 'content_generateMessageHtml.options.body']);
  assert.ok(r.saving > 3 * r.tokens, `saving ${r.saving} for a ${r.tokens}-token block ×5`);
  // Shown even though a one-tool menu gets no other breakdown.
  const lines = breakdownLines(b, 1);
  assert.match(lines[1], /repeated: one ~\d+-token block ×5 in content_generateMessageHtml \(options\.header, options\.intro, options\.body, …\): a \$defs entry could save ~\d+/);
  // The same block once per tool, in two tools: normal, not reported.
  const two = ['a', 'b'].map((n) => tool(`get_${n}`, [], { inputSchema: { type: 'object', properties: { section: block } } }));
  assert.deepEqual(breakdown(menuOf(two)).repeated, []);
});

test('breakdown: $defs nothing refers to, followed through $defs that refer to others (Notion 2.5.2: 72% of the menu)', () => {
  const $defs = {
    used: { type: 'object', properties: { inner: { $ref: '#/$defs/usedByUsed' } } },
    usedByUsed: { type: 'string', description: 'Only reachable through another definition.' },
    dead: { type: 'object', description: 'A request body for another endpoint entirely, shipped with every tool.', properties: { a: { type: 'string' }, b: { type: 'string' } } },
  };
  const t = (name, props) => tool(name, [], { inputSchema: { type: 'object', $defs, properties: props } });
  const b = breakdown(menuOf([t('get_user', { user_id: { type: 'string' } }), t('create_page', { body: { $ref: '#/$defs/used' } })]));
  assert.equal(b.unusedDefs.tools, 2);
  // get_user uses none of the three; create_page uses two, through one reference.
  const tokensOf = (o) => countTokens(JSON.stringify(o));
  assert.equal(b.unusedDefs.tokens, tokensOf({ used: $defs.used }) + tokensOf({ usedByUsed: $defs.usedByUsed }) + 2 * tokensOf({ dead: $defs.dead }));
  assert.match(breakdownLines(b, 2).join('\n'), /unused \$defs: ~\d+ tokens \(\d+% of the menu\) in 2 tools \(get_user, create_page\)/);
  assert.match(breakdownLines(b, 2).join('\n'), /→ Next: Remove the unreferenced \$defs entries/);
});

test('cli: snapshot shows where the tokens go', async () => {
  const r = await run(['snapshot', '--no-write', '--env', 'FIXTURE=smells', '--', process.execPath, join(FIXTURES, 'raw-server.mjs')]);
  assert.match(r.stdout, /Where the tokens go \(estimate\)/);
});
