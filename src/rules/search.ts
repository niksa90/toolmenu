import { buildIndex, placeIn, placeOf, SEARCH_LIMIT } from '../search.js';
import { commonWords, VERBS, words } from '../words.js';
import { clip, count, kept, names, num, type Rule, type RuleFinding } from './rule.js';

/**
 * When a client defers tools and lets the model search for them (Claude's tool
 * search, OpenAI's tool_search, Claude Code's deferred MCP tools), a tool the
 * search doesn't return can't be called. The search returns 5 tools unless the
 * model asks for more, so a tool that a search for its own name doesn't put in
 * the top 5 is one the agent can miss.
 *
 * Only for menus a client would defer: the tool search docs suggest it from 10
 * tools or 10K tokens of definitions.
 */
const MIN_TOOLS = 10;
const MIN_TOKENS = 10_000;

export const findable: Rule = {
  id: 'search/findable',
  severity: 'info',
  summary: 'Each tool comes up when searched for by its own name, for clients that defer tools',
  run(ctx) {
    const tools = ctx.menu.tools;
    if (tools.length < MIN_TOOLS || ((ctx.menu.totalTokens ?? 0) < MIN_TOKENS && tools.length < 30)) return [];
    const index = buildIndex(tools);
    const findings: RuleFinding[] = [];

    // The words of a name that say something: not a prefix most tools share (firecrawl_, API-).
    const shared = commonWords(tools.map((t) => t.name));
    const missed: { tool: string; query: string; place?: number; ahead: string[] }[] = [];
    for (const t of kept(tools, ctx)) {
      // A bare verb ("create" from ads_create) isn't how an agent searches: then the
      // prefix stays, since it's the object the tool acts on.
      const all = words(t.name);
      const own = all.filter((w) => !shared.has(w));
      const query = (own.some((w) => !VERBS.has(w)) ? own : all).join(' ');
      if (!query || !all.some((w) => !VERBS.has(w))) continue;
      const { place, ahead } = placeOf(index, query, t.name);
      if (place === undefined || place > SEARCH_LIMIT) missed.push({ tool: t.name, query, place, ahead });
    }
    if (missed.length) {
      const first = missed[0];
      findings.push({
        ...(missed.length === 1 ? { tool: first.tool } : {}),
        confidence: 'unsure',
        message: `${count(missed.length, 'tool')} of ${num(tools.length)} ${missed.length === 1 ? "doesn't" : "don't"} come up in the top ${SEARCH_LIMIT} when searched for by ${missed.length === 1 ? 'its' : 'their'} own name. Clients that defer a menu this size let the model search it, and a search returns ${SEARCH_LIMIT} tools unless the model asks for more, so an agent looking for ${missed.length === 1 ? 'it' : 'them'} can be shown other tools instead. Ranked the way a BM25 tool search ranks them (name, description, argument names and descriptions); a client's own search can rank a little differently.`,
        detail: missed.slice(0, 12).map(
          (m) =>
            `${m.tool}: “${m.query}” puts it ${m.place === undefined ? 'nowhere' : `at ${m.place}`}, behind ${names(m.ahead.slice(0, 4), 4)}${m.ahead.length > 4 ? ` and ${num(m.ahead.length - 4)} more` : ''}`,
        ).concat(missed.length > 12 ? [`and ${num(missed.length - 12)} more`] : []),
        fix: 'Say the words of each tool\'s name in its own description, early on (a search ranks the description too, and "Returns the llms.txt" never says "guide"), give it a word the tools ahead of it lack (the object it acts on, not the verb), and cut repeats of other tools\' words from long descriptions: a description that mentions "domain" ten times outranks the tool named for domains.',
      });
    }

    // routes.yml: a route's tools should be in what a search for it returns.
    for (const [keyword, expectation] of Object.entries(ctx.routes ?? {})) {
      const present = (expectation.must_match ?? []).filter((n) => tools.some((t) => t.name === n));
      const ranked = present.length ? index.rank(keyword) : [];
      const lost = present
        .map((n) => ({ n, ...placeIn(ranked, n) }))
        .filter((r) => r.place === undefined || r.place > SEARCH_LIMIT);
      for (const r of lost) {
        findings.push({
          tool: r.n,
          severity: 'warn',
          confidence: 'unsure',
          message: `routes.yml says “${keyword}” should reach ${r.n}, but a tool search for “${keyword}” ${r.place === undefined ? "doesn't return it at all" : `puts it at ${r.place}`}, past the ${SEARCH_LIMIT} a search returns by default. A client that defers tools may never show it.`,
          detail: [`ahead of it: ${names(r.ahead.slice(0, 5), 5)}`, `${r.n}: ${clip(tools.find((t) => t.name === r.n)?.description ?? '', 120)}`],
          fix: `Put the words of “${keyword}” in ${r.n}'s name or the start of its description, or take them out of the tools ahead of it.`,
        });
      }
    }
    return findings;
  },
};
