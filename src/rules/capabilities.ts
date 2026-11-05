import { names, type Rule } from './rule.js';
import type { MenuTool } from '../types.js';

/**
 * snapshot lists the menu as a client that supports elicitation, and once more as one
 * that doesn't. A server may list a tool only to clients that can ask the user to
 * confirm: github-mcp-server 1.14 lists delete_repository only then. Allowed, and a
 * good use of elicitation; worth knowing, because a client without it (or a check
 * that declares nothing, as toolmenu before 0.22) never sees those tools, and a
 * baseline made that way misses them.
 */
export interface PlainMenu {
  tools?: MenuTool[];
  error?: string;
}

export const capabilityDependent: Rule = {
  id: 'menu/capability-dependent',
  severity: 'info',
  summary: 'The tools a client sees depend on whether it supports elicitation',
  run(ctx) {
    const plain = ctx.plain?.tools;
    if (!plain) return [];
    const mine = new Set(ctx.menu.tools.map((t) => t.name));
    const theirs = new Set(plain.map((t) => t.name));
    const only = [...mine].filter((n) => !theirs.has(n));
    const without = [...theirs].filter((n) => !mine.has(n));
    if (!only.length && !without.length) return [];
    return [
      {
        rule: 'menu/capability-dependent',
        severity: 'info',
        ...(only.length + without.length === 1 ? { tool: only[0] ?? without[0] } : {}),
        message: `${only.length ? `${names(only, 10)} ${only.length === 1 ? 'is' : 'are'} listed only to a client that supports elicitation (can ask the user to confirm)` : ''}${only.length && without.length ? '; ' : ''}${without.length ? `${names(without, 10)} ${without.length === 1 ? 'is' : 'are'} listed only to a client that doesn't` : ''}. A client without elicitation gets ${plain.length} ${plain.length === 1 ? 'tool' : 'tools'}, not ${ctx.menu.tools.length}. The menu file holds the elicitation client's menu, so diff sees ${only.length === 1 ? 'that tool' : 'those tools'} too.`,
        fix: 'Nothing to change if this is deliberate (a destructive tool that asks the user first). Say in the README which tools need a client with elicitation, so users of other clients know why they are missing.',
      },
    ];
  },
};
