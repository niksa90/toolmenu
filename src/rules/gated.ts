import { unlockers } from '../session.js';
import { singular, words } from '../words.js';
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
    // with every toolset still has its unlock, and lists audits' tools under "audits".
    // A value matches a tool when every word of it is in the tool's name.
    const unlocking = new Set(found.map((u) => u.tool.name));
    const listed = ctx.menu.tools.filter((t) => !unlocking.has(t.name)).map((t) => new Set(words(t.name).map(singular)));
    const missing = (value: unknown) => {
      const want = words(String(value)).map(singular);
      return want.length > 0 && !listed.some((have) => want.every((w) => have.has(w)));
    };
    const gaps = found.map((u) => ({ u, missing: u.values.filter(missing).map(String) })).filter((g) => g.missing.length);
    if (!gaps.length) return [];
    const { u: first, missing: absent } = gaps[0];
    const more = gaps.slice(1).map((g) => g.u.tool.name);
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
