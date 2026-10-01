import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU_RULES, runRules } from '../dist/rules/index.js';
import { routeScores } from '../dist/routes.js';
import { menuOf, tool } from './helpers.mjs';

function lint(tools, ctx = {}, settings = {}) {
  const menu = menuOf(tools, {}, ctx.listMeta);
  return runRules(
    MENU_RULES,
    { menu, pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: '2025-11-25', era: 'legacy', ...ctx },
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

test('spec/tools-capability: a server without it serves clients no tools', () => {
  const missing = lint([], { capabilities: {} });
  assert.deepEqual(ids(missing), ['spec/tools-capability']);
  assert.match(missing[0].message, /that is the menu toolmenu got/);
  assert.deepEqual(ids(lint([])), []);
});

test('description/buried: another tool\'s name counts only as a whole word', () => {
  const padding = 'x'.repeat(2100);
  const menu = (tail) => [
    tool('search', ['query'], { annotations: { readOnlyHint: true } }),
    tool('get_papers', [], { description: `${padding} ${tail}`, annotations: { readOnlyHint: true } }),
  ];
  const buried = (tail) => lint(menu(tail)).filter((f) => f.rule === 'description/buried');
  assert.deepEqual(buried('Covers papers that research groups use.'), [], '"research" is not the search tool');
  assert.equal(buried('Use search first for anything else.').length, 1);
  assert.equal(buried('For broad queries, search_all is better; use it.').length, 0, 'search_all is another name');
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
  assert.deepEqual(ids(lint(tools, { listMeta, capabilities: { tools: {}, logging: {} } })), []);
  const modern = ids(lint(tools, { listMeta, capabilities: { tools: {}, logging: {} }, protocolVersion: '2026-07-28', era: 'modern', usedAuth: true }));
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
  const authored = (tools) => lint(tools).filter((f) => f.rule === 'ids/authored').flatMap((f) => (f.detail ? f.detail[0].split(', ') : [f.message.split(' takes')[0]]));
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
  assert.match(findings[0].message, /^3 tools are annotated as destructive/);
  assert.deepEqual(findings[0].detail, ['browser_close, browser_resize, browser_click']);
});

test('real-menu regressions: qualifiers, "don\'t invent" and group prefixes (a 115-tool server)', () => {
  const ro = { annotations: { readOnlyHint: true } };
  const authored = (tools) => lint(tools).filter((f) => f.rule === 'ids/authored').flatMap((f) => (f.detail ? f.detail[0].split(', ') : [f.message.split(' takes')[0]]));
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
  assert.match(findings[0].message, /^3 words appear in tool names that qualify them differently/);
  assert.deepEqual(findings[0].words.map((w) => w.noun).sort(), ['audit', 'price', 'team']);
  assert.equal(findings[0].detail.length, 3);
});

test('description/buried: a routing instruction past the cut-off', () => {
  const pad = 'Ask the assistant about anything in the workspace, including projects, people and plans. '.repeat(15);
  const long = `${pad}"Check with" plus its name means call this tool, not look for a colleague.`;
  const findings = lint([tool('assistant_ask', ['question'], { description: long, annotations: { readOnlyHint: true } })], { descriptionLimit: 280 }).filter((f) => f.rule === 'description/buried');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^assistant_ask: a sentence that reads as an instruction to the agent sits past character 280, where your client cuts the description, so the model never sees it\. The description is 1,4\d\d characters; the instruction is at 1,3\d\d\./);
  assert.equal(findings[0].confidence, 'unsure');
  assert.match(findings[0].detail[0], /not look for a colleague/);
  assert.match(findings[0].fix, /^Move “"Check with" plus its name means call this tool.*” into the first 280 characters of the assistant_ask description/);
  assert.doesNotMatch(findings[0].fix, /isn't Claude Code/, 'a set cut is not an assumption');
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
  assert.match(found[0].message, /the instruction starts at 27\d and is cut in the middle/);
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
  assert.match(late[0].message, /past character 2,048, where Claude Code cuts the description/);
  assert.match(late[0].fix, /If your client isn't Claude Code, set descriptionLimit to its cut\.$/);
  // before 2,048 but past 280: fine unless you say your client cuts at 280
  // (one summary for the length, one hint for the instruction a shorter cut would hide)
  assert.deepEqual(run([tool('get_record', ['record_id'], { description: text(500) })]).map((f) => f.rule), ['description/cut', 'description/late-instruction']);
  assert.match(run([tool('get_record', ['record_id'], { description: text(500) })], { descriptionLimit: 280 })[0].message, /past character 280, where your client cuts the description/);
  // Amazon Q sends up to 10,024
  assert.deepEqual(run([tool('get_record', ['record_id'], { description: text(2100) })], { descriptionLimit: 'amazon-q' }), []);
});

test('description/cut: one summary of descriptions longer than the client sends', () => {
  const long = 'Lists every field with an example value. '.repeat(60);
  const found = lint([tool('get_a', [], { description: long }), tool('get_b', [], { description: long }), tool('get_c', [], { description: 'Short.' })]).filter((f) => f.rule === 'description/cut');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.match(found[0].message, /^2 descriptions are longer than the 2,048 characters Claude Code sends/);
  assert.equal(found[0].confidence, undefined, 'a length is observed, not guessed');
  assert.equal(found[0].detail.length, 2);
  assert.match(found[0].detail[0], /^get_a: 2,4\d\d characters, \d+ past the cut, which falls at “….+✂.+…”$/);
  assert.ok(found[0].fix);
});

test('description/cut: every tool in the detail, not the first five', () => {
  const long = 'Lists every field with an example value. '.repeat(60);
  const names = ['get_a', 'get_b', 'get_c', 'get_d', 'get_e', 'get_f', 'get_g'];
  const found = lint(names.map((n) => tool(n, [], { description: long }))).filter((f) => f.rule === 'description/cut');
  assert.deepEqual(found[0].detail.map((d) => d.split(':')[0]), names);
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

test('description/late-instruction: with the default cut, instructions a shorter client cut would hide get one hint', () => {
  const pad = 'Returns the record with every field it has. '.repeat(10); // 450 characters, under 2,048
  const tools = [tool('get_record', ['record_id'], { description: `${pad}Never guess a record ID.` }), tool('get_other', [], { description: 'Short.' })];
  const hint = lint(tools).filter((f) => f.rule === 'description/late-instruction');
  assert.equal(hint.length, 1);
  assert.equal(hint[0].tool, 'get_record');
  assert.equal(hint[0].confidence, 'unsure');
  assert.match(hint[0].message, /^The get_record description gives the agent instructions after character 280.*Claude Code sends 2,048 characters/);
  assert.deepEqual(hint[0].detail, ['get_record: char 440: “Never guess a record ID.”']);
  assert.match(hint[0].fix, /set descriptionLimit/);
  assert.deepEqual(lint(tools).filter((f) => f.rule === 'description/cut'), [], 'no longer a description/cut finding');
  // once the cut is set, the hint goes and buried decides
  assert.deepEqual(lint(tools, { descriptionLimit: 280 }).filter((f) => f.rule.startsWith('description/')).map((f) => f.rule), ['description/buried']);
  assert.deepEqual(lint(tools, { descriptionLimit: 'claude-code' }).filter((f) => f.rule === 'description/late-instruction'), []);
  // the old id still turns it off, unless the new one is set itself
  assert.deepEqual(lint(tools, {}, { rules: { 'description/cut': 'off' } }).filter((f) => f.rule.startsWith('description/')), []);
  assert.equal(lint(tools, {}, { rules: { 'description/cut': 'warn' } }).find((f) => f.rule === 'description/late-instruction').severity, 'warn');
  assert.equal(lint(tools, {}, { rules: { 'description/cut': 'off', 'description/late-instruction': 'info' } }).filter((f) => f.rule === 'description/late-instruction').length, 1);
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
  assert.match(team[0].message, /^3 parameters take a team ID, and no tool in the menu appears to return one/);
});

test('naming/vague-id: a git ref is not a vague ID', () => {
  assert.deepEqual(lint([tool('get_file_contents', ['owner', 'repo', 'path', 'ref'])]).filter((f) => f.rule === 'naming/vague-id'), []);
});

test('write/unannotated is one warning per menu, listing every tool (53 on Miro)', () => {
  const names = Array.from({ length: 30 }, (_, i) => [`create_item_${i}`, `delete_item_${i}`]).flat();
  const found = lint(names.map((n) => tool(n))).filter((f) => f.rule === 'write/unannotated');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.equal(found[0].confidence, 'unsure');
  assert.equal(found[0].tool, undefined);
  assert.match(found[0].message, /^60 tools are named like writes \(create… and delete…\) and have no annotations/);
  const listed = found[0].detail.flatMap((d) => d.split('): ')[1].split(', '));
  assert.deepEqual(listed.sort(), [...names].sort(), 'every tool, not the first few');
  assert.match(found[0].detail[0], /^Delete or overwrite, going by the name \(destructiveHint: true\): delete_item_0/);
  assert.match(found[0].detail[1], /^Only add, going by the name \(destructiveHint: false\): create_item_0/);
  assert.match(found[0].fix, /readOnlyHint: false, destructiveHint: true/);
  // ignore still drops tools: from the summary, and a summary of none is no finding
  const some = lint(names.map((n) => tool(n)), {}, { ignore: ['delete_*'] }).find((f) => f.rule === 'write/unannotated');
  assert.equal(some.detail.length, 1);
  assert.deepEqual(lint(names.map((n) => tool(n)), {}, { ignore: ['*_item_*'] }).filter((f) => f.rule === 'write/unannotated'), []);
  // one tool keeps its tool field, and the fix names it
  const one = lint([tool('delete_form', ['form_id'])]).find((f) => f.rule === 'write/unannotated');
  assert.equal(one.tool, 'delete_form');
  assert.match(one.fix, /^Add annotations: \{ readOnlyHint: false, destructiveHint: true \} to delete_form/);
  const adds = lint([tool('send_invoice', ['invoice_id'])]).find((f) => f.rule === 'write/unannotated');
  assert.match(adds.fix, /destructiveHint: false \} to send_invoice \(true if it can also delete or overwrite\)/);
});

test('naming/vague-id is one finding per menu, with a name to try where the tool says what it is', () => {
  const found = lint([tool('get_order', ['id']), tool('pay_order', ['id']), tool('check_crawl_status', ['id'])]).filter((f) => f.rule === 'naming/vague-id');
  assert.equal(found.length, 1);
  assert.equal(found[0].confidence, 'unsure');
  assert.match(found[0].message, /^3 parameters are called just "id"/);
  assert.deepEqual(found[0].detail, ['get_order.id (order_id?)', 'pay_order.id', 'check_crawl_status.id']);
  assert.match(found[0].fix, /get_order\.id → order_id/);
  const camel = lint([tool('get_form', ['id', 'pageSize'])]).find((f) => f.rule === 'naming/vague-id');
  assert.equal(camel.tool, 'get_form');
  assert.match(camel.fix, /get_form\.id → formId/);
});

test('naming/vague-id: no rename on collection verbs, where a bare id is usually the parent\'s', () => {
  for (const name of ['list_comments', 'search_comments', 'find_comments', 'query_comments', 'browse_comments']) {
    const f = lint([tool(name, ['id'])]).find((x) => x.rule === 'naming/vague-id');
    assert.equal(f.tool, name);
    assert.doesNotMatch(f.fix, /→/, name);
    assert.match(f.fix, /\(form_id, not id\)/, name);
  }
  for (const name of ['get_comment', 'update_comment', 'delete_comment']) {
    assert.match(lint([tool(name, ['id'])]).find((x) => x.rule === 'naming/vague-id').fix, new RegExp(`${name}\\.id → comment_id`), name);
  }
});

test('ids/authored: the article follows the sound: a user ID, a UUID, an order ID', () => {
  const said = (param) => lint([tool('send_message', [param])]).find((f) => f.rule === 'ids/authored')?.message ?? '';
  assert.match(said('user_id'), / takes a user ID, and no tool .* with a user ID\./);
  assert.match(said('order_id'), / takes an order ID/);
});

test('article: by sound, not by letter', async () => {
  const { article } = await import('../dist/words.js');
  for (const w of ['user', 'uuid', 'url', 'unique', 'usage', 'unit', 'one', 'one-time', 'team']) assert.equal(article(w), 'a', w);
  for (const w of ['order', 'upload', 'update', 'umbrella', 'hour', 'honest', 'item', 'api', 'id']) assert.equal(article(w), 'an', w);
});

test('certainty: guesses from words are marked unsure, observed facts are not', () => {
  const pad = 'Returns the record with every field it has. '.repeat(50);
  const tools = [
    tool('get_thing', ['id']),
    tool('list_team_audits'),
    tool('get_audit_trail'),
    tool('get_form', ['form_id'], { annotations: { readOnlyHint: true } }),
    tool('send_invoice'),
    tool('delete_invoice', [], { annotations: { destructiveHint: true } }),
    tool('get_record', [], { description: `${pad}Never guess a record ID.`, annotations: { readOnlyHint: true } }),
    tool('ping', [], { annotations: { readOnlyHint: true } }),
    tool('ping', [], { annotations: { readOnlyHint: true } }),
  ];
  const second = menuOf([...tools].reverse()).tools;
  const found = lint(tools, { secondList: second, listMeta: { ttlMs: 0 }, protocolVersion: '2026-07-28', era: 'modern' });
  const unsure = [...new Set(found.filter((f) => f.confidence === 'unsure').map((f) => f.rule))].sort();
  const sure = [...new Set(found.filter((f) => !f.confidence).map((f) => f.rule))].sort();
  assert.deepEqual(unsure, ['description/buried', 'description/late-instruction', 'ids/authored', 'naming/shared-word', 'naming/vague-id', 'write/no-dry-run', 'write/unannotated'].filter((r) => unsure.includes(r)));
  for (const rule of ['naming/vague-id', 'naming/shared-word', 'ids/authored', 'write/unannotated']) assert.ok(unsure.includes(rule), rule);
  for (const rule of ['menu/nondeterministic', 'menu/duplicate-name', 'spec/cache-hints']) assert.ok(sure.includes(rule), rule);
  // and every finding gives a next step
  for (const f of found) assert.ok(f.fix, `${f.rule} has a fix`);
});

test('menu/nondeterministic: a timestamp default names the parameter and the fix (PayPal)', () => {
  const at = (time) => tool('list_transactions', [], { inputSchema: { type: 'object', properties: { end_date: { type: 'string', default: time } } } });
  const first = menuOf([at('2026-09-29T22:11:21.528Z')]);
  const second = menuOf([at('2026-09-29T22:11:21.537Z')]).tools;
  const [f] = runRules(MENU_RULES, { menu: first, secondList: second, pages: [], capabilities: { tools: {} }, usedAuth: false }).filter((x) => x.rule === 'menu/nondeterministic');
  assert.equal(f.tool, 'list_transactions');
  assert.match(f.message, /every conversation can miss the prompt cache\. list_transactions\.end_date\.default is a timestamp, taken when the menu is built\./);
  assert.match(f.detail[0], /"2026-09-29T22:11:21\.528Z" vs "2026-09-29T22:11:21\.537Z"/);
  assert.equal(f.fix, 'Build list_transactions.end_date.default from a fixed value, not the current time: leave it out, or say "defaults to now" in the description.');
  assert.equal(f.confidence, undefined);
});

test('menu/nondeterministic: order only, and items in a different order, each get their own fix', () => {
  const first = menuOf([tool('a'), tool('b')]);
  const [moved] = runRules(MENU_RULES, { menu: first, secondList: menuOf([tool('b'), tool('a')]).tools, pages: [], capabilities: {}, usedAuth: false }).filter((x) => x.rule === 'menu/nondeterministic');
  assert.match(moved.fix, /^Return the tools in a fixed order/);
  const fields = (v) => tool('jira_get_issue', [], { inputSchema: { type: 'object', properties: { fields: { type: 'string', default: v } } } });
  const [sorted] = runRules(MENU_RULES, { menu: menuOf([fields('a,b,c')]), secondList: menuOf([fields('c,a,b')]).tools, pages: [], capabilities: {}, usedAuth: false }).filter((x) => x.rule === 'menu/nondeterministic');
  assert.match(sorted.message, /jira_get_issue\.fields\.default holds the same items in a different order/);
  assert.match(sorted.fix, /^Sort the items of jira_get_issue\.fields\.default when building the menu/);
});

test('menu/process-variance: the same cause as menu/nondeterministic points to it instead of repeating it', () => {
  const at = (time) => tool('list_transactions', [], { inputSchema: { type: 'object', properties: { end_date: { type: 'string', default: time } } } });
  const menu = menuOf([at('2026-09-29T22:11:21.528Z')]);
  const ctx = { menu, pages: [], capabilities: { tools: {} }, usedAuth: false, transport: 'stdio', probes: [{ tools: menuOf([at('2026-09-29T22:11:23.440Z')]).tools }] };
  const alone = runRules(MENU_RULES, ctx).find((f) => f.rule === 'menu/process-variance');
  assert.match(alone.message, /^A second server process, started the same way, served a different menu/);
  assert.match(alone.fix, /^Build list_transactions\.end_date\.default from a fixed value/);
  const both = runRules(MENU_RULES, { ...ctx, secondList: menuOf([at('2026-09-29T22:11:21.537Z')]).tools });
  const pointer = both.find((f) => f.rule === 'menu/process-variance');
  assert.equal(pointer.severity, 'error');
  assert.match(pointer.message, /in the same place menu\/nondeterministic reports/);
  assert.equal(pointer.fix, 'Fix menu/nondeterministic; this goes away with it.');
  // a Python set in hash order (mcp-atlassian): different places from the list check, so its own finding
  const fields = (v) => tool('jira_get_issue', [], { inputSchema: { type: 'object', properties: { fields: { type: 'string', default: v } } } });
  const hashed = runRules(MENU_RULES, { menu: menuOf([fields('labels,status,updated')]), pages: [], capabilities: {}, usedAuth: false, transport: 'stdio', probes: [{ tools: menuOf([fields('status,updated,labels')]).tools }] }).find((f) => f.rule === 'menu/process-variance');
  assert.match(hashed.message, /Likely a set or a map iterated in hash order/);
  assert.match(hashed.fix, /so every process lists them in the same order/);
});

test('menu/process-variance: a second cause behind the same tool is reported, not merged into the first', () => {
  // A timestamp default (changes every call) and a Python set (changes only between processes) in one tool.
  const both = (time, v) => tool('jira_search', [], { inputSchema: { type: 'object', properties: { end_date: { type: 'string', default: time }, fields: { type: 'string', default: v } } } });
  const found = runRules(MENU_RULES, {
    menu: menuOf([both('2026-09-29T22:11:21.528Z', 'labels,status,updated')]),
    secondList: menuOf([both('2026-09-29T22:11:21.537Z', 'labels,status,updated')]).tools,
    probes: [{ tools: menuOf([both('2026-09-29T22:11:23.440Z', 'status,updated,labels')]).tools }],
    pages: [], capabilities: {}, usedAuth: false, transport: 'stdio',
  });
  const f = found.find((x) => x.rule === 'menu/process-variance');
  assert.doesNotMatch(f.message, /Same cause, same fix/);
  assert.match(f.message, /jira_search\.end_date\.default is what menu\/nondeterministic reports/);
  assert.match(f.message, /jira_search\.fields\.default holds the same items in a different order/);
  assert.match(f.message, /Likely a set or a map iterated in hash order/);
  assert.match(f.fix, /^Sort the items of jira_search\.fields\.default when building the menu/);
  assert.ok(f.detail.some((l) => /fields\.default/.test(l)), f.detail.join('\n'));
  assert.equal(found.find((x) => x.rule === 'menu/nondeterministic').fix.startsWith('Build jira_search.end_date.default'), true);
});

test('description/late-instruction: an instruction that starts before 280 and runs past it is said to run past it', () => {
  const pad = 'Returns the record with every field it has. '.repeat(6); // 264 characters
  // "Never guess" starts at 275 and ends at 286: across the cut.
  const tools = [tool('get_record', ['record_id'], { description: `${pad}Note this: Never guess a record ID.` })];
  const hint = lint(tools).find((f) => f.rule === 'description/late-instruction');
  assert.match(hint.message, /^The get_record description gives the agent instructions that run past character 280/);
  assert.equal(hint.detail.length, 1);
  assert.match(hint.detail[0], /^get_record: char 275 \(runs past 280\): “.*Never guess a record ID\.”$/);
});

const unlock = () =>
  tool('unlock_toolset', [], {
    description: 'Unlock more tools.',
    inputSchema: { type: 'object', properties: { toolset: { type: 'string', enum: ['audits', 'reports'] } }, required: ['toolset'] },
    annotations: { readOnlyHint: true },
  });

test('menu/gated: a server that unlocks tools and says its list changes may have served only the starting set', () => {
  const tools = [tool('get_form', ['form_id'], { annotations: { readOnlyHint: true } }), unlock()];
  const gated = lint(tools, { capabilities: { tools: { listChanged: true } } }).find((f) => f.rule === 'menu/gated');
  assert.equal(gated.severity, 'warn');
  assert.equal(gated.confidence, 'unsure');
  assert.equal(gated.tool, 'unlock_toolset');
  assert.match(gated.message, /unlock_toolset looks like it unlocks more tools, and the server says its tool list can change/);
  assert.match(gated.fix, /toolmenu session --auto --union-out menu\.json/);
  assert.equal(lint(tools).find((f) => f.rule === 'menu/gated'), undefined, 'no listChanged, no finding');
  assert.equal(lint([tools[0]], { capabilities: { tools: { listChanged: true } } }).find((f) => f.rule === 'menu/gated'), undefined, 'no unlock, no finding');
  assert.match(lint(tools, { capabilities: { tools: { listChanged: true } }, server: '-- node server.js' }).find((f) => f.rule === 'menu/gated').fix, /toolmenu session --auto --union-out menu\.json -- node server\.js /);
  // Everything already listed (a server started with every toolset): the unlock would add nothing.
  const all = [...tools, tool('list_team_audits', ['team'], { annotations: { readOnlyHint: true } }), tool('export_report', ['report_id'], { annotations: { readOnlyHint: true } })];
  assert.equal(lint(all, { capabilities: { tools: { listChanged: true } } }).find((f) => f.rule === 'menu/gated'), undefined, 'every value has its tools listed');
  // Only some listed: the finding names the values whose tools aren't there.
  const some = lint(all.slice(0, 3), { capabilities: { tools: { listChanged: true } } }).find((f) => f.rule === 'menu/gated');
  assert.match(some.message, /1 of 2 values \(reports\) match no tool by name/);
  assert.doesNotMatch(some.message, /audits/);
  // A partial match is only a hint: half or fewer of the values unmatched may just be named differently.
  assert.equal(some.severity, 'info');
  // "Enables Cross-Region Restore on a vault" turns on a feature, not tools: no parameter names what to unlock.
  const enable = tool('backup_enable_crr', ['vault'], { description: 'Enables Cross-Region Restore on a vault.' });
  assert.equal(lint([tools[0], enable], { capabilities: { tools: { listChanged: true } } }).find((f) => f.rule === 'menu/gated'), undefined, 'a feature switch is not an unlock');
});

test('menu/gated: in a namespaced menu a domain matches by namespace; a mostly complete menu is only a hint', () => {
  const domains = ['content', 'tasks', 'users', 'groups', 'insights', 'engagement'];
  const unlockDomains = tool('enable_domains', [], {
    description: 'Unlock more tools for a domain.',
    inputSchema: { type: 'object', properties: { domains: { type: 'array', items: { type: 'string', enum: domains } } }, required: ['domains'] },
    annotations: { readOnlyHint: true },
  });
  const always = [tool('home_getContentPools'), tool('home_getGroups'), tool('home_listUsers'), tool('search_groups'), tool('home_getTasks')];
  const ctx = { capabilities: { tools: { listChanged: true } } };
  // Starting set: the always-on tools mention content, groups, users and tasks, but no domain's own tools are there.
  const primary = lint([...always, unlockDomains], ctx).find((f) => f.rule === 'menu/gated');
  assert.equal(primary.severity, 'warn');
  assert.match(primary.message, /no tool in this menu matches content, tasks, users, groups and 2 more|no tool in this menu matches content, tasks, users, groups, insights and 1 more/);
  assert.match(primary.detail[0], /no tool named for: content, tasks, users, groups, insights and engagement/);
  // Everything listed, but two domains' tools are named for something else (report_get, comment_add).
  const everything = [...always, tool('content_get'), tool('content_list'), tool('task_get'), tool('user_get'), tool('group_list'), tool('report_get'), tool('comment_add'), unlockDomains];
  const all = lint(everything, ctx).find((f) => f.rule === 'menu/gated');
  assert.equal(all.severity, 'info');
  assert.match(all.message, /2 of 6 values \(insights and engagement\) match no tool by name/);
});

test('naming/shared-word: a word that opens several tool names is a namespace, not a shared noun', () => {
  const words = (tools) => lint(tools).find((f) => f.rule === 'naming/shared-word')?.words.map((w) => w.noun) ?? [];
  assert.deepEqual(words([tool('content_get_page'), tool('content_update_page'), tool('export_content_report'), tool('list_team_audits'), tool('get_audit_trail')]), ['audit']);
  assert.deepEqual(words([tool('maps_geocode'), tool('maps_search_places'), tool('maps_place_details'), tool('maps_directions')]), []);
  // the namespace still tells qualifiers apart: "entry" in two namespaces is a real clash
  assert.deepEqual(words([tool('context_get_entry'), tool('context_search'), tool('content_get_entry'), tool('content_publish')]), ['entry']);
});

