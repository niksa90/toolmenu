import type { MenuTool } from '../types.js';
import { commonWords, nouns, singular, words } from '../words.js';
import { missingWords, negatedMention, routeScores } from '../routes.js';
import type { Rule, RuleFinding } from './rule.js';

// Not `ref`: in real menus it's a git ref (GitHub ×4), a name with a meaning of its own.
const VAGUE_IDS = /^(id|ids|uuid|uuids|identifier|identifiers)$/i;

export const vagueId: Rule = {
  id: 'naming/vague-id',
  severity: 'warn',
  lesson: '04',
  summary: 'ID parameters say which kind of thing they identify',
  run(ctx) {
    const findings: RuleFinding[] = [];
    for (const tool of ctx.menu.tools) {
      for (const param of Object.keys(tool.inputSchema?.properties ?? {})) {
        if (VAGUE_IDS.test(param)) {
          findings.push({
            tool: tool.name,
            message: `${tool.name}.${param}: says "${param}" but not which kind of thing it identifies. Name it after the thing (e.g. form_id) so the agent doesn't pass the wrong ID.`,
          });
        }
      }
    }
    return findings;
  },
};

export const sharedWord: Rule = {
  id: 'naming/shared-word',
  severity: 'info',
  lesson: '04',
  summary: 'The same noun used for different things across tools',
  run(ctx) {
    const byNoun = new Map<string, MenuTool[]>();
    const common = commonWords(ctx.menu.tools.map((t) => t.name));
    const subject = (name: string) => nouns(name).filter((n) => !common.has(n));
    for (const tool of ctx.menu.tools) {
      for (const noun of new Set(subject(tool.name))) {
        byNoun.set(noun, [...(byNoun.get(noun) ?? []), tool]);
      }
    }
    // A word that opens the name of every tool it appears in is a group prefix
    // (task_*, content_*, user_*): a naming convention, not a collision.
    const firstWord = (name: string) => words(name).find((w) => !common.has(w));
    const groups: { noun: string; tools: string[] }[] = [];
    for (const [noun, tools] of byNoun) {
      if (tools.length > 1 && tools.every((t) => singular(firstWord(t.name) ?? '') === noun)) continue;
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
      if (clashes.size > 0) groups.push({ noun, tools: [...clashes] });
    }
    if (groups.length === 0) return [];
    // One summary, not one finding per word: on a big server these are
    // review prompts, and a wall of them hides the findings that matter.
    const shown = groups.slice(0, 8);
    return [
      {
        message: `${groups.length === 1 ? `"${groups[0].noun}" names` : `${groups.length} words name`} different things across tools. Worth a look where an agent could route a question to the wrong one; pin the ones that matter with routes.yml.`,
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
              ? { tool: name, severity: 'info', message: `routes.yml "${keyword}" names ${name}, which isn't in the menu yet. The server can change its menu, so it may appear after an unlock; if it was renamed or removed, update routes.yml. Check this route against the full menu.` }
              : { tool: name, message: `routes.yml "${keyword}" names ${name}, which isn't in the menu. Renamed or removed?` },
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
              ? `"${keyword}" doesn't match ${good} at all: ${missing.map((w) => `"${w}"`).join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} in its name or description.`
              : `"${keyword}" doesn't match ${good} at all.`,
          });
          continue;
        }
        for (const bad of mustNot.filter((n) => names.has(n))) {
          const badScore = scores.get(bad) ?? 0;
          if (badScore >= goodScore) {
            findings.push({
              tool: good,
              message: `"${keyword}" matches ${bad} (score ${badScore}) at least as well as ${good} (score ${goodScore}). An agent could route it to the wrong tool.${why(bad)}${badScore === goodScore && !why(bad) ? ' Neither the names nor the descriptions separate them: pick a route word only the right tool has, or give it one.' : ''}`,
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
            });
          }
        }
      }
    }
    return findings;
  },
};
