import { profileOf } from '../clients.js';
import { buildIndex, placeIn, placeOf, SEARCH_LIMIT, type SearchIndex } from '../search.js';
import type { MenuTool } from '../types.js';
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
export const MIN_TOOLS = 10;
export const MIN_TOKENS = 10_000;

/** Where each tool lands when searched for by the words of its own name, the way a client's search ranks. */
export interface OwnNamePlace {
  tool: string;
  query: string;
  place?: number;
  ahead: string[];
}

/**
 * Each tool searched for by its own name, ranked the way a client's search ranks: its
 * own result count and fields where its docs or source give them (Codex: 8, no argument
 * descriptions), Claude's otherwise.
 */
export function ownNamePlaces(
  checked: MenuTool[],
  all: MenuTool[],
  client: string | undefined,
  descriptionChars?: number,
): { limit: number; read: string; index: SearchIndex; places: OwnNamePlace[] } {
  const profile = profileOf(client);
  const limit = profile?.searchLimit?.value ?? SEARCH_LIMIT;
  const codex = client === 'codex';
  const index = buildIndex(all, { descriptionChars, fields: codex ? 'codex' : 'claude' });
  const read = codex ? 'name, title, description and argument names' : 'name, description, argument names and descriptions';
  // The words of a name that say something: not a prefix most tools share (firecrawl_, API-).
  const shared = commonWords(all.map((t) => t.name));
  const places: OwnNamePlace[] = [];
  for (const t of checked) {
    // A bare verb ("create" from ads_create) isn't how an agent searches: then the
    // prefix stays, since it's the object the tool acts on.
    const words_ = words(t.name);
    const own = words_.filter((w) => !shared.has(w));
    const query = (own.some((w) => !VERBS.has(w)) ? own : words_).join(' ');
    if (!query || !words_.some((w) => !VERBS.has(w))) continue;
    places.push({ tool: t.name, query, ...placeOf(index, query, t.name, limit) });
  }
  return { limit, read, index, places };
}

export const findable: Rule = {
  id: 'search/findable',
  scope: 'agent',
  severity: 'info',
  summary: 'Each tool comes up when searched for by its own name, for clients that defer tools',
  run(ctx) {
    const tools = ctx.menu.tools;
    const profile = profileOf(ctx.client);
    if (profile) {
      // A client that defers tools does it at any size; one whose search results
      // aren't documented (OpenAI's spec doesn't say how many) isn't ranked against a guess.
      if (!profile.defers || profile.defers.value === 'none' || tools.length < 2) return [];
      if (!profile.searchLimit && ctx.client !== 'claude-code') return [];
    } else if (tools.length < MIN_TOOLS || ((ctx.menu.totalTokens ?? 0) < MIN_TOKENS && tools.length < 30)) return [];
    const { limit, read, index, places } = ownNamePlaces(kept(tools, ctx), tools, ctx.client, profile?.searchReads?.value);
    const missed = places.filter((p) => p.place === undefined || p.place > limit);
    const findings: RuleFinding[] = [];
    if (missed.length) {
      const first = missed[0];
      findings.push({
        ...(missed.length === 1 ? { tool: first.tool } : {}),
        confidence: 'unsure',
        message: `${count(missed.length, 'tool')} of ${num(tools.length)} ${missed.length === 1 ? "doesn't" : "don't"} come up in the top ${limit} when searched for by ${missed.length === 1 ? 'its' : 'their'} own name. Clients that defer a menu this size let the model search it, and a search returns ${limit} tools unless the model asks for more, so an agent looking for ${missed.length === 1 ? 'it' : 'them'} can be shown other tools instead. Ranked the way a BM25 tool search ranks them (${read}${profile?.searchReads ? `, the description up to character ${num(profile.searchReads.value)}, all ${profile.label}'s search reads` : ''}); a client's own search can rank a little differently.`,
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
        .filter((r) => r.place === undefined || r.place > limit);
      for (const r of lost) {
        findings.push({
          tool: r.n,
          severity: 'warn',
          confidence: 'unsure',
          message: `routes.yml says “${keyword}” should reach ${r.n}, but a tool search for “${keyword}” ${r.place === undefined ? "doesn't return it at all" : `puts it at ${r.place}`}, past the ${limit} a search returns by default. A client that defers tools may never show it.`,
          detail: [`ahead of it: ${names(r.ahead.slice(0, 5), 5)}`, `${r.n}: ${clip(tools.find((t) => t.name === r.n)?.description ?? '', 120)}`],
          fix: `Put the words of “${keyword}” in ${r.n}'s name or the start of its description, or take them out of the tools ahead of it.`,
        });
      }
    }
    return findings;
  },
};

/** A client whose search toolmenu can rank: it defers tools, and its result count is known. */
function ranks(client: string): boolean {
  const profile = profileOf(client);
  return Boolean(profile?.defers && profile.defers.value !== 'none' && (profile.searchLimit || client === 'claude-code'));
}

export const clientDifference: Rule = {
  id: 'search/client-difference',
  scope: 'agent',
  severity: 'info',
  summary: "A tool one client's search finds by its own name and another's misses",
  run(ctx) {
    const clients = (ctx.clients ?? []).filter(ranks);
    if (clients.length < 2 || ctx.menu.tools.length < 2) return [];
    const tools = ctx.menu.tools;
    const runs = clients.map((client) => {
      const { limit, places } = ownNamePlaces(kept(tools, ctx), tools, client, profileOf(client)?.searchReads?.value);
      return { client, label: profileOf(client)!.label, limit, at: new Map(places.map((p) => [p.tool, p])) };
    });
    const differ: { tool: string; query: string; line: string }[] = [];
    for (const [tool, first] of runs[0].at) {
      const verdicts = runs.map((r) => {
        const p = r.at.get(tool);
        const found = p?.place !== undefined && p.place <= r.limit;
        return { r, place: p?.place, found };
      });
      if (verdicts.every((v) => v.found) || verdicts.every((v) => !v.found)) continue;
      const line = verdicts.map((v) => `${v.r.label}: ${v.place === undefined ? 'not returned' : `${v.place}${ordinal(v.place)}`} (top ${v.r.limit}: ${v.found ? 'found' : 'missed'})`).join(' · ');
      differ.push({ tool, query: first.query, line });
    }
    if (!differ.length) return [];
    const one = differ.length === 1;
    return [
      {
        ...(one ? { tool: differ[0].tool } : {}),
        confidence: 'unsure',
        message: `${count(differ.length, 'tool')} ${one ? 'is' : 'are'} found by ${one ? 'its' : 'their'} own name in one client's tool search and missed in another's: the clients read different parts of a tool and return a different number of results (${runs.map((r) => `${r.label}: top ${r.limit}`).join(', ')}). An agent in the client that misses ${one ? 'it' : 'them'} can be shown other tools instead.`,
        detail: differ.slice(0, 12).map((d) => `${d.tool} (“${d.query}”): ${d.line}`).concat(differ.length > 12 ? [`and ${num(differ.length - 12)} more`] : []),
        fix: "Put the words of each tool's name early in its own description, so every client's search ranks it first: a search that reads argument descriptions (Claude's) can be outranked by words many tools share in their arguments.",
      },
    ];
  },
};

function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}
