import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { routeScores } from '../dist/routes.js';
import { menuOf, tool } from './helpers.mjs';

function lint(tools, ctx = {}, settings = {}) {
  const menu = menuOf(tools, {}, ctx.listMeta);
  return runRules(
    MENU_RULES,
    { menu, pages: [], capabilities: {}, usedAuth: false, protocolVersion: '2025-11-25', era: 'legacy', ...ctx },
    settings,
  ).filter((f) => f.rule !== 'spec/discover' && f.rule !== 'spec/schema');
}
const ids = (findings) => findings.map((f) => `${f.rule}${f.tool ? ':' + f.tool : ''}`).sort();

test('a clean menu has no findings', () => {
  const findings = lint([
    tool('search_forms', ['query'], { annotations: { readOnlyHint: true } }),
    tool('get_form', ['form_id'], { annotations: { readOnlyHint: true } }),
    tool('delete_form', ['form_id', 'dry_run'], { annotations: { destructiveHint: true } }),
  ]);
  assert.deepEqual(ids(findings), []);
});

test('menu/duplicate-name: two tools with one name, and nothing else read into it', () => {
  const tools = [
    tool('search', ['query'], { annotations: { readOnlyHint: true } }),
    tool('get_form', ['form_id'], { annotations: { readOnlyHint: true } }),
    tool('search', ['query'], { description: 'Another search.', annotations: { readOnlyHint: true } }),
  ];
  const second = menuOf(tools).tools;
  const findings = lint(tools, { secondList: second });
  assert.deepEqual(ids(findings).filter((i) => i.startsWith('menu/')), ['menu/duplicate-name:search']);
  assert.match(findings.find((f) => f.rule === 'menu/duplicate-name').message, /positions 0, 2/);
});

test('naming/vague-id flags params that just say "id"', () => {
  assert.deepEqual(ids(lint([tool('get_thing', ['id'], { annotations: { readOnlyHint: true } })])).filter((i) => i.startsWith('naming/vague-id')), ['naming/vague-id:get_thing']);
});

test('naming/shared-word flags the audit collision but not get_form vs get_form_fields', () => {
  const audit = lint([tool('list_team_audits'), tool('get_audit_trail')]).filter((f) => f.rule === 'naming/shared-word');
  assert.equal(audit.length, 1);
  assert.match(audit[0].message, /"audit"/);
  const forms = lint([tool('get_form'), tool('get_form_fields')]).filter((f) => f.rule === 'naming/shared-word');
  assert.equal(forms.length, 0);
});

test('naming/route: a tie on the keyword is an error, a clear winner passes', () => {
  const routes = { audit: { must_match: ['list_team_audits'], must_not_match: ['get_audit_trail'] } };
  const tied = lint([tool('list_team_audits'), tool('get_audit_trail')], { routes }).filter((f) => f.rule === 'naming/route');
  assert.equal(tied.length, 1);
  assert.match(tied[0].message, /at least as well/);
  const fixed = lint(
    [tool('list_team_audits', [], { description: 'List the audits a team has done.' }), tool('get_change_log', [], { description: 'Who changed what.' })],
    { routes: { audit: { must_match: ['list_team_audits'], must_not_match: ['get_change_log'] } } },
  ).filter((f) => f.rule === 'naming/route');
  assert.deepEqual(fixed, []);
});

test('naming/route: a renamed tool breaks the route', () => {
  const routes = { audit: { must_match: ['list_team_audits'] } };
  const findings = lint([tool('list_audits_for_team')], { routes }).filter((f) => f.rule === 'naming/route');
  assert.match(findings[0].message, /isn't in the menu/);
});

test('naming/route: must_not_match on its own means no match, and a disclaimer still matches', () => {
  const tools = [
    tool('get_score_summary', [], { description: 'Store scores from our own checks, not the native audit trail.' }),
    tool('get_audit_trail', [], { description: 'Who changed what.' }),
  ];
  const findings = lint(tools, { routes: { 'audit trail': { must_not_match: ['get_score_summary'] } } }).filter((f) => f.rule === 'naming/route');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /matches get_score_summary \(score \d\), which routes\.yml says must not match it/);
  assert.match(findings[0].message, /can't read "not"/);
  assert.deepEqual(lint(tools, { routes: { 'change log': { must_not_match: ['get_score_summary'] } } }).filter((f) => f.rule === 'naming/route'), []);
});

test('naming/route: a multi-word route matches by all its words', () => {
  const tools = [
    tool('get_template_progress_table', [], { description: 'One row for every team.' }),
    tool('get_template', [], { description: 'One template.' }),
  ];
  const routes = { 'template progress per team': { must_match: ['get_template_progress_table'], must_not_match: ['get_template'] } };
  assert.deepEqual(lint(tools, { routes }).filter((f) => f.rule === 'naming/route'), []);
  const missing = lint(tools, { routes: { 'template progress per region': { must_match: ['get_template_progress_table'] } } }).filter((f) => f.rule === 'naming/route');
  assert.match(missing[0].message, /"region" isn't in its name or description/);
});

test('naming/route: the name decides between tools the description alone would tie', () => {
  const tools = [
    tool('get_team_progress', [], { description: 'Progress of every template.' }),
    tool('get_template', [], { description: 'One template, with team progress.' }),
  ];
  const scores = routeScores('template progress per team', menuOf(tools).tools);
  assert.ok(scores.get('get_team_progress') > scores.get('get_template'), JSON.stringify([...scores]));
  const tie = lint([tool('list_team_audits'), tool('get_audit_trail')], { routes: { audit: { must_match: ['list_team_audits'], must_not_match: ['get_audit_trail'] } } }).filter((f) => f.rule === 'naming/route');
  assert.match(tie[0].message, /Neither the names nor the descriptions separate them/);
});

test('ids/authored: "don\'t invent" in the tool description counts for an optional param', () => {
  const flagged = (description, paramDescription) =>
    lint([tool('assistant_ask', [], {
      description,
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { question: { type: 'string' }, sessionId: { type: 'string', description: paramDescription } }, required: ['question'] },
    })]).filter((f) => f.rule === 'ids/authored').length;
  assert.equal(flagged('Ask the assistant.', 'The session.'), 1);
  assert.equal(flagged('Ask the assistant. To continue a thread pass the sessionId it returned; don\'t invent a sessionId.', 'The session.'), 0);
  assert.equal(flagged('Ask the assistant.', 'Omit this in the normal case.'), 0);
});

test('routeScores: name match outranks description mentions, plural-insensitive', () => {
  const scores = routeScores('audits', menuOf([tool('list_audit', [], { description: 'Lists them.' }), tool('other', [], { description: 'An audit of the audit.' })]).tools);
  assert.equal(scores.get('list_audit'), 3 + 0);
  assert.equal(scores.get('other'), 2);
});

test('ids/authored: an ID nothing hands out is flagged; a search tool fixes it', () => {
  const alone = lint([tool('get_form', ['form_id'], { annotations: { readOnlyHint: true } })]).filter((f) => f.rule === 'ids/authored');
  assert.equal(alone.length, 1);
  const withSearch = lint([
    tool('get_form', ['form_id'], { annotations: { readOnlyHint: true } }),
    tool('search_forms', ['query'], { annotations: { readOnlyHint: true } }),
  ]).filter((f) => f.rule === 'ids/authored');
  assert.deepEqual(withSearch, []);
});

test('ids/authored: an output schema carrying the ID counts', () => {
  const findings = lint([
    tool('get_form', ['form_id'], { annotations: { readOnlyHint: true } }),
    tool('create_form', ['title'], {
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: { type: 'object', properties: { form_id: { type: 'string' } } },
    }),
  ]).filter((f) => f.rule === 'ids/authored');
  assert.deepEqual(findings, []);
});

test('ids/authored: enums are chosen, not invented', () => {
  const findings = lint([
    tool('set_mode', [], { inputSchema: { type: 'object', properties: { mode_id: { type: 'string', enum: ['a', 'b'] } } }, annotations: { idempotentHint: true } }),
  ]).filter((f) => f.rule === 'ids/authored');
  assert.deepEqual(findings, []);
});

test('write/unannotated and write/no-dry-run', () => {
  const findings = ids(lint([tool('send_invoice', ['invoice_id']), tool('search_invoices'), tool('delete_invoice', ['invoice_id'], { annotations: { destructiveHint: true } })]));
  assert.ok(findings.includes('write/unannotated:send_invoice'));
  assert.ok(findings.includes('write/no-dry-run:delete_invoice'));
  const withPreview = ids(lint([tool('search_invoices'), tool('delete_invoice', ['invoice_id'], { annotations: { destructiveHint: true } }), tool('preview_invoice_deletion', ['invoice_id'], { annotations: { readOnlyHint: true } })]));
  assert.ok(!withPreview.includes('write/no-dry-run:delete_invoice'));
});

test('2026-07-28 rules are skipped for 2025-era servers and run for modern ones', () => {
  const tools = [tool('ping_service', [], { annotations: { readOnlyHint: true } })];
  const listMeta = { ttlMs: 0, cacheScope: 'public' };
  assert.deepEqual(ids(lint(tools, { listMeta, capabilities: { logging: {} } })), []);
  const modern = ids(lint(tools, { listMeta, capabilities: { logging: {} }, protocolVersion: '2026-07-28', era: 'modern', usedAuth: true }));
  assert.deepEqual(modern, ['spec/cache-hints', 'spec/cache-hints', 'spec/deprecated']);
});

test('config can turn rules off, change severity, and ignore tools', () => {
  const tools = [tool('get_thing', ['id'])];
  assert.ok(!ids(lint(tools, {}, { rules: { 'naming/vague-id': 'off' } })).some((i) => i.startsWith('naming/vague-id')));
  const raised = lint(tools, {}, { rules: { 'naming/vague-id': 'error' } }).find((f) => f.rule === 'naming/vague-id');
  assert.equal(raised.severity, 'error');
  assert.deepEqual(lint(tools, {}, { ignore: ['get_*'] }).filter((f) => f.tool), []);
});

test('menu/nondeterministic compares content as well as order', () => {
  const first = menuOf([tool('a'), tool('b')]);
  const reordered = menuOf([tool('b'), tool('a')]).tools;
  const edited = menuOf([tool('a', [], { description: 'other' }), tool('b')]).tools;
  const run = (secondList) =>
    runRules(MENU_RULES, { menu: first, secondList, pages: [], capabilities: {}, usedAuth: false }).filter((f) => f.rule === 'menu/nondeterministic');
  assert.match(run(reordered)[0].message, /different order/);
  assert.match(run(edited)[0].detail.join("\n"), /a: description: "a\." vs "other"/);
  assert.deepEqual(run(first.tools), []);
});

test('spec/schema validates older protocol versions too (draft-07 schemas)', () => {
  const run = (protocolVersion, page) =>
    runRules(MENU_RULES, { menu: menuOf([]), pages: [page], capabilities: {}, usedAuth: false, protocolVersion }).filter((f) => f.rule === 'spec/schema');
  for (const v of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
    assert.deepEqual(run(v, { tools: [{ name: 'ok', inputSchema: { type: 'object' } }] }), [], v);
    const bad = run(v, { tools: [{ name: 'empty', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#' } }] });
    assert.equal(bad.length, 1, v);
    assert.match(bad[0].detail.join('\n'), /required property 'type'/);
  }
  assert.equal(run('2026-07-28', { tools: [] })[0].severity, 'error', '2026-07-28 requires ttlMs, cacheScope, resultType');
  assert.equal(run('2023-01-01', { tools: [] })[0].severity, 'info', 'unknown versions are skipped, not failed');
});

test('real-menu regressions: ID heuristics (FINDINGS F10)', () => {
  const authored = (tools) => lint(tools).filter((f) => f.rule === 'ids/authored').flatMap((f) => (f.detail ? f.detail[0].split(', ') : [f.message.split(' looks like')[0]]));
  const ro = { annotations: { readOnlyHint: true } };
  // chrome-devtools: uid is not "u" + "id"; a description that says where the value comes from counts
  assert.deepEqual(authored([tool('click', ['uid'], ro), tool('drag', ['from_uid'], ro)]), []);
  assert.deepEqual(authored([tool('get_node', [], { ...ro, inputSchema: { type: 'object', properties: { node_id: { type: 'string', description: 'The id from the page snapshot' } } } })]), []);
  // playwright: a keyboard key is not an identifier
  assert.deepEqual(lint([tool('press_key', ['key'], ro), tool('type_text', ['submitKey'], ro)]).filter((f) => f.tool), []);
  // sentry: a \\d pattern is not an opaque ID; projectSlugOrId identifies a project
  assert.deepEqual(authored([tool('search_events', [], { ...ro, inputSchema: { type: 'object', properties: { period: { type: 'string', pattern: '^\\d+[hdw]$' } } } })]), []);
  assert.deepEqual(authored([tool('search_issues', ['projectSlugOrId'], ro), tool('find_projects', [], ro)]), []);
  // notion: prefixes, retrieve, a general search, and creates hand out IDs
  const notion = [tool('API-get-users', [], ro), tool('API-get-user', ['user_id'], ro), tool('API-post-search', ['query'], ro), tool('API-retrieve-a-page', ['page_id'], ro), tool('API-post-page', ['title'])];
  assert.deepEqual(authored(notion), []);
  // firecrawl: a search's ID comes from the search tool; a shared product prefix is noise
  assert.deepEqual(authored([tool('firecrawl_search', ['query'], ro), tool('firecrawl_search_feedback', ['searchId'], ro), tool('firecrawl_map', ['url'], ro), tool('firecrawl_scrape', ['url'], ro)]), []);
  // still flagged: an ID nothing gives out
  assert.deepEqual(authored([tool('firecrawl_feedback', ['jobId'], ro), tool('firecrawl_map', ['url'], ro), tool('firecrawl_scrape', ['url'], ro), tool('firecrawl_crawl', ['url'], ro)]), ['firecrawl_feedback.jobId']);
});

test('real-menu regressions: status stays status, prefixes and verbs are not shared nouns', () => {
  const shared = (names) => lint(names.map((n) => tool(n))).filter((f) => f.rule === 'naming/shared-word').flatMap((f) => f.words.map((w) => w.noun));
  assert.deepEqual(shared(['browser_click', 'browser_resize', 'browser_navigate', 'browser_take_screenshot', 'browser_console_messages']), []);
  assert.deepEqual(shared(['take_screenshot', 'take_snapshot', 'navigate_page', 'resize_page', 'select_page']), []);
  assert.deepEqual(shared(['list_team_audits', 'get_audit_trail']), ['audit']);
  assert.ok(lint([tool('check_crawl_status', ['id'])]).every((f) => !/statu /.test(f.message)));
});

test('write/no-dry-run is one finding per server, listing the tools', () => {
  const d = { annotations: { destructiveHint: true } };
  const findings = lint([tool('browser_close', [], d), tool('browser_resize', [], d), tool('browser_click', [], d)]).filter((f) => f.rule === 'write/no-dry-run');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^3 tools are destructive/);
  assert.deepEqual(findings[0].detail, ['browser_close, browser_resize, browser_click']);
});

test('real-menu regressions: qualifiers, "don\'t invent" and group prefixes (a 115-tool server)', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const authored = (tools) => lint(tools).filter((f) => f.rule === 'ids/authored').flatMap((f) => (f.detail ? f.detail[0].split(', ') : [f.message.split(' looks like')[0]]));
  // creatorRegionId and newRegionId are region IDs, which search_regions returns
  assert.deepEqual(authored([tool('search_regions', ['query'], ro), tool('content_findCourseDropouts', ['creatorRegionId'], ro), tool('form_updateRegions', ['newRegionId'])]), []);
  // an optional ID whose description says not to invent it
  const ask = { ...ro, inputSchema: { type: 'object', properties: { question: { type: 'string' }, sessionId: { type: 'string', description: "Optional. Don't invent a sessionId; the server remembers the thread." } }, required: ['question'] } };
  assert.deepEqual(authored([tool('assistant_ask', [], ask)]), []);
  // ...but a required one still counts
  const required = { ...ro, inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: "Don't invent it." } }, required: ['sessionId'] } };
  assert.deepEqual(authored([tool('assistant_ask', [], required)]), ['assistant_ask.sessionId']);
  // domain prefixes are a convention; a word inside different names is still a collision
  const shared = (names) => lint(names.map((n) => tool(n))).filter((f) => f.rule === 'naming/shared-word').flatMap((f) => f.words.map((w) => w.noun));
  assert.deepEqual(shared(['task_list', 'task_getDetails', 'task_assignUsers', 'content_search', 'content_getReport']), []);
  assert.deepEqual(shared(['list_team_audits', 'get_audit_trail', 'task_list', 'task_get']), ['audit']);
});

test('naming/shared-word is one summary finding, with every word in --json', () => {
  const names = ['list_team_audits', 'get_audit_trail', 'list_team_reports', 'get_report_archive', 'get_stock_price', 'set_price_alert'];
  const findings = lint(names.map((n) => tool(n))).filter((f) => f.rule === 'naming/shared-word');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^3 words name different things/);
  assert.deepEqual(findings[0].words.map((w) => w.noun).sort(), ['audit', 'price', 'team']);
  assert.equal(findings[0].detail.length, 3);
});

test('description/buried: a routing instruction past the cut-off', () => {
  const pad = 'Ask the assistant about anything in the workspace, including projects, people and plans. '.repeat(15);
  const long = `${pad}"Check with" plus its name means call this tool, not look for a colleague.`;
  const findings = lint([tool('assistant_ask', ['question'], { description: long, annotations: { readOnlyHint: true } })], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /cuts it at 280\. An instruction to the agent is past the cut, the first at 1,3\d\d/);
  assert.match(findings[0].detail[0], /not look for a colleague/);
  // the same words early on are fine, and so is a short description
  assert.deepEqual(lint([tool('a_ask', ['q'], { description: `Call this tool, not the people search. ${pad}`, annotations: { readOnlyHint: true } })], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried'), []);
  assert.deepEqual(lint([tool('b_ask', ['q'], { description: 'Never call this for people.', annotations: { readOnlyHint: true } })], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried'), []);
  // "don't hesitate" is not a routing instruction (sequential-thinking)
  assert.deepEqual(lint([tool('think', ['thought'], { description: `${pad}Don't hesitate to add more thoughts.`, annotations: { readOnlyHint: true } })], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried'), []);
  // the cut-off is configurable
  const ctx = { menu: menuOf([tool('c_ask', ['q'], { description: long })]), pages: [], capabilities: {}, usedAuth: false, descriptionLimit: 2000 };
  assert.deepEqual(runRules(MENU_RULES, ctx).filter((f) => f.rule === 'description/buried'), []);
});

test('description/buried: an early disclaimer does not hide a later instruction', () => {
  const pad = 'Answers questions about the workspace from its knowledge base. '.repeat(20);
  const text = `Ask the assistant. It is a name, not a person. ${pad}"Check with" plus its name means call this tool, not a colleague search.`;
  const findings = lint([tool('assistant_ask', ['question'], { description: text })], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
  assert.equal(findings.length, 1, 'every instruction past the cut counts, not only the first routing word');
  assert.match(findings[0].detail[0], /means call this tool/);
});

test('description/buried: an instruction the cut falls inside counts', () => {
  const lead = 'Shows one template with its fields and owner. ';
  const pad = `${lead.repeat(5)}It lists answers and files for each step. `;
  // the tool name starts at 276: the model sees "Use get_" and loses the name
  const text = `${pad}Use get_progress_table for per-team rows. ${'More detail on templates. '.repeat(5)}`;
  const found = lint([tool('get_template', ['template_id'], { description: text }), tool('get_progress_table', [])], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /the first cut mid-instruction \(it starts at 27\d\)/);
  assert.match(found[0].detail[0], /cut mid-instruction/);
  // a sentence that starts at 0 with the routing in a parenthetical past the cut
  const paren = `Finds instances of a template in a team, with their status, assignee, due date, answers and attachments, sorted by due date and grouped by team so a manager can see what is late, what is done and what still needs attention this week or is waiting on a reviewer (for one row per team use get_progress_table, not this). ${'Paged. '.repeat(10)}`;
  const found2 = lint([tool('find_instances', ['template_id'], { description: paren }), tool('get_progress_table', [])], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
  assert.equal(found2.length, 1, 'an earlier hit in the same sentence must not hide the one past the cut');
});

test('description/buried: behaviour is not an instruction', () => {
  const pad = 'Returns the item with its fields, owner and dates, in the caller\'s language. '.repeat(5);
  const behaviour = [
    'Never throws on a missing item.',
    'Returns null instead of failing the call.',
    'Degrades to a partial list rather than erroring.',
    'Old IDs were never recognized by the viewer.',
    'Returns a link, never the full file.',
    'Scores are per team, never company-wide.',
  ];
  for (const sentence of behaviour) {
    const found = lint([tool('get_item', ['item_id'], { description: `${pad}${sentence}` })], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
    assert.deepEqual(found, [], sentence);
  }
  const instructionsPast = [
    ['Call render_html first instead of writing HTML by hand.', 'render_html'],
    ['Use get_progress_table instead for a table.', 'get_progress_table'],
    ['If the report ID is unknown, never guess one.', undefined],
    ['On a 403, do not retry.', undefined],
    ['Never hand-construct a storage ID.', undefined],
    ['Never surface bare IDs to the user.', undefined],
  ];
  for (const [sentence, other] of instructionsPast) {
    const tools = [tool('get_item', ['item_id'], { description: `${pad}${sentence}` })];
    if (other) tools.push(tool(other, []));
    const found = lint(tools, { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
    assert.equal(found.length, 1, sentence);
  }
});

test('description/buried: tools the client sends in full are skipped', () => {
  const pad = 'Resolves names to entities. '.repeat(15);
  const tools = [tool('resolve_names', ['q'], { description: `${pad}Never guess an ID.` }), tool('resolve_other', ['q'], { description: `${pad}Never guess an ID.` })];
  const ctx = { menu: menuOf(tools), pages: [], capabilities: {}, usedAuth: false, descriptionLimit: 280, fullDescriptions: ['resolve_n*'] };
  assert.deepEqual(runRules(MENU_RULES, ctx).filter((f) => f.rule === 'description/buried').map((f) => f.tool), ['resolve_other']);
});

test('description limits: Claude Code by default, presets, or your number', () => {
  const pad = 'Returns the record with every field it has. '.repeat(50); // 2,200 characters
  const text = (at) => `${pad.slice(0, at)} Never guess a record ID. ${pad}`;
  const run = (tools, ctx = {}) => lint(tools, ctx).filter((f) => f.rule.startsWith('description/'));
  // past Claude Code's 2,048: flagged, and the message names the client
  const late = run([tool('get_record', ['record_id'], { description: text(2100) })]);
  assert.deepEqual(late.map((f) => f.rule), ['description/buried']);
  assert.match(late[0].message, /Claude Code \(2,048 characters, the default: set descriptionLimit for your client\) cuts it at 2,048/);
  // before 2,048 but past 280: fine unless you say your client cuts at 280
  // (one summary for the length, one hint for the instruction a shorter cut would hide)
  assert.deepEqual(run([tool('get_record', ['record_id'], { description: text(500) })]).map((f) => f.rule), ['description/cut', 'description/cut']);
  assert.match(run([tool('get_record', ['record_id'], { description: text(500) })], { descriptionLimit: 280 })[0].message, /your client \(descriptionLimit 280\) cuts it at 280/);
  // Amazon Q sends up to 10,024
  assert.deepEqual(run([tool('get_record', ['record_id'], { description: text(2100) })], { descriptionLimit: 'amazon-q' }), []);
});

test('description/cut: one summary of descriptions longer than the client sends', () => {
  const long = 'Lists every field with an example value. '.repeat(60);
  const found = lint([tool('get_a', [], { description: long }), tool('get_b', [], { description: long }), tool('get_c', [], { description: 'Short.' })]).filter((f) => f.rule === 'description/cut');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.match(found[0].message, /2 descriptions are longer than Claude Code .* get_a \(2,4\d\d\), get_b/);
});

test('description/buried: tools named in a contrast count ("x and y don\'t answer this")', () => {
  const pad = 'Lists instances with their status and owner. '.repeat(8);
  const text = `${pad}(get_assigned and get_progress don't answer this directly.)`;
  const found = lint([tool('find_instances', ['template_id'], { description: text }), tool('get_assigned', []), tool('get_progress', [])], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
  assert.equal(found.length, 1);
});

test('naming/route: a tool missing from a server that changes its menu is info, not an error', () => {
  const routes = { audit: { must_match: ['list_team_audits'] } };
  const gated = lint([tool('unlock_toolset', [])], { routes, capabilities: { tools: { listChanged: true } } }).filter((f) => f.rule === 'naming/route');
  assert.equal(gated[0].severity, 'info');
  assert.match(gated[0].message, /isn't in the menu yet/);
  const fixed = lint([tool('unlock_toolset', [])], { routes }).filter((f) => f.rule === 'naming/route');
  assert.equal(fixed[0].severity, 'error');
});

test('description/cut: with the default cut, instructions a shorter client cut would hide get one hint', () => {
  const pad = 'Returns the record with every field it has. '.repeat(10); // 450 characters, under 2,048
  const tools = [tool('get_record', ['record_id'], { description: `${pad}Never guess a record ID.` }), tool('get_other', [], { description: 'Short.' })];
  const hint = lint(tools).filter((f) => f.rule === 'description/cut');
  assert.equal(hint.length, 1);
  assert.match(hint[0].message, /1 description gives the agent instructions after character 280: get_record\. Claude Code sends 2,048 characters/);
  assert.match(hint[0].message, /set descriptionLimit/);
  // once the cut is set, the hint goes and buried decides
  assert.deepEqual(lint(tools, { descriptionLimit: 280 }).filter((f) => f.rule.startsWith('description/')).map((f) => f.rule), ['description/buried']);
  assert.deepEqual(lint(tools, { descriptionLimit: 'claude-code' }).filter((f) => f.rule === 'description/cut'), []);
});

test('ids/authored: abbreviations, lone qualifiers, URL provenance, one finding per kind (FINDINGS F12)', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const found = (tools) => lint(tools).filter((f) => f.rule === 'ids/authored');
  // Miro: orgId is returned by the organization tools.
  assert.deepEqual(found([tool('get-board-classification', ['orgId'], ro), tool('get-organization-info', [], ro)]), []);
  // A qualifier alone names no kind.
  assert.deepEqual(found([tool('update-item-position', ['parentId'])]), []);
  // Figma: the ID comes from the URL the user pastes.
  const figma = { type: 'object', properties: { nodeId: { type: 'string', description: 'The ID of the node to fetch, often found as URL parameter node-id=<nodeId>' } }, required: ['nodeId'] };
  assert.deepEqual(found([tool('get_figma_data', [], { ...ro, inputSchema: figma })]), []);
  // Sentry: "when not using a URL" names an alternative input, not a source.
  const sentry = { type: 'object', properties: { resourceId: { type: 'string', description: 'Required when not using a URL.' } }, required: ['resourceId'] };
  assert.equal(found([tool('get_sentry_resource', [], { ...ro, inputSchema: sentry })]).length, 1);
  // One finding for every tool taking the same kind, at info.
  const team = found([tool('create-board', ['teamId']), tool('copy-board', ['teamId']), tool('share-board', ['teamId'])]);
  assert.equal(team.length, 1);
  assert.equal(team[0].severity, 'info');
  assert.match(team[0].message, /^3 parameters look like a team ID/);
});

test('naming/vague-id: a git ref is not a vague ID', () => {
  assert.deepEqual(lint([tool('get_file_contents', ['owner', 'repo', 'path', 'ref'])]).filter((f) => f.rule === 'naming/vague-id'), []);
});

