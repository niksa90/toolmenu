import type { MenuTool } from '../types.js';
import { COLLECTION_VERBS, LOOKUP_VERBS, VERBS, WRITE_VERBS, commonWords, nouns, singular, verbOf, words } from '../words.js';
import { missingWords, negatedMention, routeScores } from '../routes.js';
import { kept, names, type Rule, type RuleFinding } from './rule.js';

// Not `ref`: in real menus it's a git ref (GitHub ×4), a name with a meaning of its own.
const VAGUE_IDS = /^(id|ids|uuid|uuids|identifier|identifiers)$/i;

export const vagueId: Rule = {
  id: 'naming/vague-id',
  severity: 'warn',
  lesson: '04',
  summary: 'ID parameters say which kind of thing they identify',
  run(ctx) {
    const common = commonWords(ctx.menu.tools.map((t) => t.name));
    const found: { tool: string; param: string; where: string; suggestion?: string }[] = [];
    for (const tool of kept(ctx.menu.tools, ctx)) {
      const params = Object.keys(tool.inputSchema?.properties ?? {});
      for (const param of params.filter((p) => VAGUE_IDS.test(p))) {
        found.push({ tool: tool.name, param, where: `${tool.name}.${param}`, suggestion: betterName(tool.name, param, params, common) });
      }
    }
    if (found.length === 0) return [];
    const one = found.length === 1;
    const example = found.find((f) => f.suggestion) ?? found[0];
    const tools = [...new Set(found.map((f) => f.tool))];
    const said = names([...new Set(found.map((f) => `"${f.param}"`))].slice(0, 4));
    // One finding: the same naming habit in 20 tools is one thing to change.
    return [
      {
        ...(tools.length === 1 ? { tool: tools[0] } : {}),
        confidence: 'unsure',
        message: `${one ? `${found[0].where} is` : `${found.length} parameters are`} called just ${said}, which doesn't say which kind of thing ${one ? 'it identifies' : 'each one identifies'}. An agent holding several kinds of ID has only the description to pick the right one.`,
        ...(one ? {} : { detail: found.map((f) => f.where + (f.suggestion ? ` (${f.suggestion}?)` : '')) }),
        fix: `Name ${one ? 'it' : 'each one'} after what it identifies${example.suggestion ? ` (${example.where} → ${example.suggestion})` : ' (form_id, not id)'}. If renaming would break callers, say in the parameter's description which kind of ID it takes and which tool returns it.`,
      },
    ];
  },
};

/** thing_id for get_thing.id, when the tool name has exactly one subject noun. */
function betterName(tool: string, param: string, params: string[], common: Set<string>): string | undefined {
  // Only where the verb acts on the thing itself: get_monitor.id is a monitor's,
  // check_crawl_status.id is a crawl job's, not a status's. Not on collection
  // verbs: list_comments.id is usually the post's, not a comment's.
  const verb = verbOf(tool);
  if (!verb || COLLECTION_VERBS.has(verb) || !(LOOKUP_VERBS.has(verb) || WRITE_VERBS.has(verb))) return undefined;
  const subject = [...new Set(nouns(tool).filter((n) => !common.has(n)))];
  if (subject.length !== 1) return undefined;
  const lower = param.toLowerCase();
  // Follow the tool's own style: formId next to other camelCase parameters.
  return params.some((p) => /[a-z][A-Z]/.test(p)) ? subject[0] + lower[0].toUpperCase() + lower.slice(1) : `${subject[0]}_${lower}`;
}

export const sharedWord: Rule = {
  id: 'naming/shared-word',
  severity: 'info',
  lesson: '04',
  summary: 'The same noun used for different things across tools',
  run(ctx) {
    const byNoun = new Map<string, MenuTool[]>();
    // Compared in the singular: "maps" in every name is as common as "map".
    const common = new Set([...commonWords(ctx.menu.tools.map((t) => t.name))].map(singular));
    const subject = (name: string) => nouns(name).filter((n) => !common.has(singular(n)));
    // A word that opens two or more tool names is a namespace (content_*, maps_*):
    // where it opens the name it isn't the tool's subject, so it isn't compared as
    // a shared word there. It still tells qualifiers apart (content_get_entry vs
    // context_get_entry both say "entry").
    const opens = new Map<string, number>();
    for (const tool of ctx.menu.tools) {
      const first = singular(words(tool.name)[0] ?? '');
      if (first) opens.set(first, (opens.get(first) ?? 0) + 1);
    }
    const namespace = (name: string) => {
      const first = singular(words(name)[0] ?? '');
      return (opens.get(first) ?? 0) >= 2 && !VERBS.has(first) ? first : undefined;
    };
    for (const tool of ctx.menu.tools) {
      for (const noun of new Set(subject(tool.name))) {
        if (noun === namespace(tool.name)) continue;
        byNoun.set(noun, [...(byNoun.get(noun) ?? []), tool]);
      }
    }
    // A word that opens the name of every tool it appears in is a group prefix
    // (task_*, content_*, user_*): a naming convention, not a collision.
    const firstWord = (name: string) => words(name).find((w) => !common.has(w));
    const groups: { noun: string; tools: string[] }[] = [];
    for (const [noun, tools] of byNoun) {
      if (tools.length > 1 && tools.every((t) => singular(firstWord(t.name) ?? '') === noun)) continue;
      // In every tool's name of a menu of three or more, it's the server's one subject
      // (DeepWiki: ask_wiki_question, read_wiki_contents, read_wiki_structure), not two
      // things sharing a word. Two tools are too few to tell: list_team_audits and
      // get_audit_trail are the clash this rule exists for.
      if (tools.length >= 3 && tools.length === ctx.menu.tools.length) continue;
      // Tools where the noun is qualified differently and neither qualifier set
      // contains the other: list_team_audits vs get_audit_trail.
      const qualifiers = tools.map((t) => ({ tool: t.name, rest: new Set(subject(t.name).filter((n) => n !== noun)) }));
      const clashes = new Set<string>();
      for (let i = 0; i < qualifiers.length; i++) {
        for (let j = i + 1; j < qualifiers.length; j++) {
          const a = qualifiers[i].rest;
          const b = qualifiers[j].rest;
          const aInB = [...a].every((n) => b.has(n));
          const bInA = [...b].every((n) => a.has(n));
          if (!aInB && !bInA) {
            clashes.add(qualifiers[i].tool);
            clashes.add(qualifiers[j].tool);
          }
        }
      }
      const shown = [...clashes].filter((t) => !ctx.isIgnored?.(t));
      if (shown.length > 1) groups.push({ noun, tools: shown });
    }
    if (groups.length === 0) return [];
    // One summary, not one finding per word: on a big server these are
    // review prompts, and a wall of them hides the findings that matter.
    const shown = groups.slice(0, 8);
    return [
      {
        confidence: 'unsure',
        message: `${groups.length === 1 ? `"${groups[0].noun}" appears` : `${groups.length} words appear`} in tool names that qualify ${groups.length === 1 ? 'it' : 'them'} differently, the way list_team_audits and get_audit_trail both say "audit". Where the word means two things, an agent asked about it can pick the wrong tool; where it means one, all is well.`,
        fix: 'For each word that means two things, rename one side or pin the right tool for the word in routes.yml, so a later rename can\'t quietly undo it.',
        detail: shown.map((g) => `"${g.noun}": ${g.tools.join(', ')}`).concat(groups.length > shown.length ? [`…and ${groups.length - shown.length} more (--json lists all)`] : []),
        words: groups,
      } as RuleFinding,
    ];
  },
};

export const route: Rule = {
  id: 'naming/route',
  severity: 'error',
  lesson: '04',
  summary: 'routes.yml expectations still hold',
  run(ctx) {
    if (!ctx.routes) return [];
    const findings: RuleFinding[] = [];
    const names = new Set(ctx.menu.tools.map((t) => t.name));
    const gated = Boolean((ctx.capabilities.tools as { listChanged?: boolean } | undefined)?.listChanged);
    for (const [keyword, expectation] of Object.entries(ctx.routes)) {
      const mustMatch = expectation.must_match ?? [];
      const mustNot = expectation.must_not_match ?? [];
      for (const name of [...mustMatch, ...mustNot]) {
        if (!names.has(name)) {
          // A server that announces list changes may unlock the tool later.
          findings.push(
            gated
              ? {
                  tool: name,
                  severity: 'info',
                  message: `routes.yml "${keyword}" names ${name}, which isn't in the menu yet. The server announces menu changes, so it may appear after an unlock.`,
                  fix: `If ${name} was renamed or removed, update routes.yml; if it comes with an unlock, check this route against the menu after it (toolmenu session).`,
                }
              : {
                  tool: name,
                  message: `routes.yml "${keyword}" names ${name}, which isn't in the menu, so this route can't be checked. Renamed or removed?`,
                  fix: `Update "${keyword}" in routes.yml to the tool's current name, or take ${name} out of it.`,
                },
          );
        }
      }
      const scores = routeScores(keyword, ctx.menu.tools);
      const byName = new Map(ctx.menu.tools.map((t) => [t.name, t]));
      const why = (bad: string): string => {
        const said = negatedMention(keyword, byName.get(bad)!);
        return said
          ? ` Its description says “${said.length > 160 ? said.slice(0, 157) + '…' : said}”: a disclaimer still puts the words in the tool, and keyword search can't read "not".`
          : '';
      };
      for (const good of mustMatch.filter((n) => names.has(n))) {
        const goodScore = scores.get(good) ?? 0;
        if (goodScore === 0) {
          const missing = missingWords(keyword, byName.get(good)!);
          findings.push({
            tool: good,
            message: missing.length > 0
              ? `"${keyword}" doesn't match ${good} at all, the tool routes.yml says it must reach: ${missing.map((w) => `"${w}"`).join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} in its name or description.`
              : `"${keyword}" doesn't match ${good} at all, the tool routes.yml says it must reach.`,
            fix: missing.length > 0
              ? `Use ${missing.map((w) => `"${w}"`).join(', ')} in the ${good} description, or change the route word in routes.yml to one it has.`
              : `Change the route word in routes.yml to one the name or description of ${good} has.`,
          });
          continue;
        }
        for (const bad of mustNot.filter((n) => names.has(n))) {
          const badScore = scores.get(bad) ?? 0;
          if (badScore >= goodScore) {
            findings.push({
              tool: good,
              message: `"${keyword}" matches ${bad} (score ${badScore}) at least as well as ${good} (score ${goodScore}), so an agent could route it to the wrong tool.${why(bad)}${badScore === goodScore && !why(bad) ? ' Neither the names nor the descriptions separate them.' : ''}`,
              fix: why(bad)
                ? `Say what ${bad} isn't for without the words "${keyword}" (name the other tool instead), or give ${good} more of them.`
                : `Give ${good} words for "${keyword}" in its name or description that ${bad} doesn't have.`,
            });
          }
        }
      }
      // With nothing to beat, must_not_match means: no match at all.
      if (mustMatch.length === 0) {
        for (const bad of mustNot.filter((n) => names.has(n))) {
          const badScore = scores.get(bad) ?? 0;
          if (badScore > 0) {
            findings.push({
              tool: bad,
              message: `"${keyword}" matches ${bad} (score ${badScore}), which routes.yml says must not match it.${why(bad)}`,
              fix: `Take "${keyword}" out of the name and description of ${bad}, or drop the route if the match is right after all.`,
            });
          }
        }
      }
    }
    return findings;
  },
};
