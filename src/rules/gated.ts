import { unlockers } from '../session.js';
import { singular, VERBS, words } from '../words.js';
import { names, type Rule } from './rule.js';

/**
 * A server that unlocks tools and says its list can change may have served only
 * its starting set. A baseline made from that misses every tool behind the unlock,
 * so a diff can't see their breaking changes (a real server: 18 of 115 tools).
 */
export const gated: Rule = {
  id: 'menu/gated',
  severity: 'warn',
  summary: 'The menu may be only the starting set of a server that unlocks more tools',
  run(ctx) {
    const listChanged = (ctx.capabilities.tools as { listChanged?: boolean } | undefined)?.listChanged === true;
    if (!listChanged) return [];
    // Only an unlock whose parameter lists what it unlocks (an enum of toolsets or
    // domains), the kind session --auto walks: "Enables Cross-Region Restore on a
    // vault" turns on a feature, not tools (Azure, 418 tools).
    const found = unlockers(ctx.menu.tools).filter((u) => u.param && u.values.length);
    if (!found.length) return [];
    // A value whose tools are already listed adds nothing: the same server started
    // with every toolset still has its unlock. Where the tools are named
    // namespace-first (content_get, group_list), a value matches a tool whose first
    // name part is the value: an always-on home_getGroups or search_groups isn't
    // the groups domain's. Where they're named verb-first (list_team_audits), every
    // word of the value in the tool's name will do.
    const unlocking = new Set(found.map((u) => u.tool.name));
    const tools = ctx.menu.tools.filter((t) => !unlocking.has(t.name));
    const firstPart = (name: string) => words(name.split(/[_\-.\s]/)[0] ?? '').map(singular);
    const namespaced = tools.filter((t) => !VERBS.has(singular(words(t.name)[0] ?? ''))).length * 2 > tools.length;
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => w === b[i]);
    const missing = (value: unknown) => {
      const want = words(String(value)).map(singular);
      if (!want.length) return false;
      return namespaced
        ? !tools.some((t) => same(firstPart(t.name), want))
        : !tools.some((t) => {
            const have = new Set(words(t.name).map(singular));
            return want.every((w) => have.has(w));
          });
    };
    const gaps = found.map((u) => ({ u, missing: u.values.filter(missing).map(String) })).filter((g) => g.missing.length);
    if (!gaps.length) return [];
    const { u: first, missing: absent } = gaps[0];
    const more = gaps.slice(1).map((g) => g.u.tool.name);
    // Most values matched: the menu is likely complete, with a few toolsets named for
    // something else (insights → report_get). A hint, not a warning.
    if (absent.length * 2 <= first.values.length) {
      return [
        {
          tool: first.tool.name,
          severity: 'info',
          confidence: 'unsure',
          message: `${first.tool.name} unlocks tools and the server says its tool list can change (listChanged); ${absent.length} of ${first.values.length} values (${names(absent, 5)}) match no tool by name. If their tools are named differently, the menu is complete; if not, it lacks them.`,
          detail: [`unlock: ${first.tool.name} (${first.param}: ${names(first.values.map(String), 12)}); no tool named for: ${names(absent, 8)}${more.length ? `; also ${names(more, 4)}` : ''}`],
          fix: `If ${names(absent, 3)} ${absent.length === 1 ? 'has' : 'have'} tools under other names, nothing to do. Otherwise commit every tool a session sees as the baseline: toolmenu session --auto --union-out menu.json ${ctx.server ?? '-- <the command that starts the server>'}.`,
        },
      ];
    }
    return [
      {
        tool: first.tool.name,
        confidence: 'unsure',
        message: `${first.tool.name} looks like it unlocks more tools, and the server says its tool list can change (listChanged), but no tool in this menu matches ${names(absent, 5)}, so this menu of ${ctx.menu.tools.length} tools may be only the starting set. A baseline made from it misses the tools behind the unlock, and a diff against it can't see their breaking changes.`,
        detail: [`unlock: ${first.tool.name} (${first.param}: ${names(first.values.map(String), 8)}); no tool named for: ${names(absent, 8)}${more.length ? `; also ${names(more, 4)}` : ''}`],
        fix: `Commit every tool a session sees as the baseline instead: toolmenu session --auto --union-out menu.json ${ctx.server ?? '-- <the command that starts the server>'} (it calls each value of ${first.tool.name}). If the server already lists every tool under other names, turn this off with rules: { "menu/gated": "off" }.`,
      },
    ];
  },
};
