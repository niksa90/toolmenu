import { unlockers } from '../session.js';
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
    const first = found[0];
    const values = first.param && first.values.length ? ` (${first.param}: ${names(first.values.map(String), 5)})` : '';
    return [
      {
        tool: first.tool.name,
        confidence: 'unsure',
        message: `${first.tool.name} looks like it unlocks more tools, and the server says its tool list can change (listChanged), so this menu of ${ctx.menu.tools.length} tools may be only the starting set. A baseline made from it misses the tools behind the unlock, and a diff against it can't see their breaking changes.`,
        detail: [`unlock: ${first.tool.name}${values}${found.length > 1 ? `; also ${names(found.slice(1).map((u) => u.tool.name), 4)}` : ''}`],
        fix: `Commit every tool a session sees as the baseline instead: toolmenu session --auto --union-out menu.json ${ctx.server ?? "-- <the command that starts the server>"} (it calls each value of ${first.tool.name}). If the server already lists every tool, turn this off with rules: { "menu/gated": "off" }.`,
      },
    ];
  },
};
