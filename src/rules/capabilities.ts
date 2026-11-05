import { names, type Rule } from './rule.js';
import type { MenuTool } from '../types.js';
import { isAppOnly } from '../apps.js';

/**
 * snapshot lists the menu as a client that supports elicitation and MCP Apps, and once
 * more as one that declares neither. A server may list a tool only to clients that can
 * ask the user to confirm (github-mcp-server 1.14's delete_repository), or register
 * other tools, or other variants of them, for a host that renders apps (ext-apps:
 * "Servers MAY register different tool variants based on host capabilities"). Allowed;
 * worth knowing, because a client without the capability never sees those tools, and a
 * baseline made without it misses them. When the two differ, a third listing with
 * elicitation alone tells which capability each tool depends on.
 */
export interface PlainMenu {
  tools?: MenuTool[];
  error?: string;
  /** Listed with elicitation and without MCP Apps: set only when `tools` differs from the main menu. */
  elicitationOnly?: MenuTool[];
}

type Cause = 'elicitation' | 'apps' | 'either';

const CAN: Record<Cause, string> = {
  elicitation: 'supports elicitation (can ask the user to confirm)',
  apps: 'renders MCP Apps (declares io.modelcontextprotocol/ui)',
  either: 'supports elicitation and MCP Apps',
};
const WITHOUT: Record<Cause, string> = {
  elicitation: 'A client without elicitation',
  apps: 'A client without MCP Apps',
  either: 'A client with neither',
};

/** A tool's definition without toolmenu's token estimate. */
const definition = (t: MenuTool) => {
  const { tokens: _tokens, ...rest } = t;
  return JSON.stringify(rest);
};

/**
 * What the rule compares, between the main listing and a bare one: tools listed only
 * in the main one (app-only tools left out: listing those only to Apps hosts is what
 * ext-apps asks for), only in the bare one, and same-name tools defined otherwise.
 */
function compareListings(main: MenuTool[], bare: MenuTool[]) {
  const theirs = new Map(bare.map((t) => [t.name, t]));
  const mine = new Map(main.map((t) => [t.name, t]));
  return {
    theirs,
    mine,
    only: [...mine.keys()].filter((n) => !theirs.has(n) && !isAppOnly(mine.get(n)!)),
    without: [...theirs.keys()].filter((n) => !mine.has(n)),
    variants: [...mine.keys()].filter((n) => theirs.has(n) && definition(mine.get(n)!) !== definition(theirs.get(n)!)),
  };
}

/** Whether the rule has anything to say about these two listings: snapshot lists a third time only then. */
export function listingsDiffer(main: MenuTool[], bare: MenuTool[]): boolean {
  const { only, without, variants } = compareListings(main, bare);
  return only.length + without.length + variants.length > 0;
}

export const capabilityDependent: Rule = {
  id: 'menu/capability-dependent',
  severity: 'info',
  summary: 'The tools a client sees depend on whether it supports elicitation or MCP Apps',
  run(ctx) {
    const plain = ctx.plain?.tools;
    if (!plain) return [];
    const middle = ctx.plain?.elicitationOnly;
    const { mine, only, without, variants } = compareListings(ctx.menu.tools, plain);
    const halfway = middle ? new Map(middle.map((t) => [t.name, t])) : undefined;
    // Which capability brings a tool, or its variant: the one elicitation alone doesn't.
    const cause = (name: string, same: (m: MenuTool | undefined) => boolean): Cause => (!halfway ? 'either' : same(halfway.get(name)) ? 'elicitation' : 'apps');
    if (!only.length && !without.length && !variants.length) return [];

    const byCause = new Map<Cause, string[]>();
    for (const n of only) {
      const c = cause(n, (m) => m !== undefined);
      byCause.set(c, [...(byCause.get(c) ?? []), n]);
    }
    const variantCause = new Map<Cause, string[]>();
    for (const n of variants) {
      const c = cause(n, (m) => m !== undefined && definition(m) === definition(mine.get(n)!));
      variantCause.set(c, [...(variantCause.get(c) ?? []), n]);
    }
    const causes = new Set([...byCause.keys(), ...variantCause.keys()]);
    const overall: Cause = causes.size === 1 ? [...causes][0] : 'either';
    const parts: string[] = [];
    for (const [c, ns] of byCause) parts.push(`${names(ns, 10)} ${ns.length === 1 ? 'is' : 'are'} listed only to a client that ${CAN[c]}`);
    if (without.length) parts.push(`${names(without, 10)} ${without.length === 1 ? 'is' : 'are'} listed only to a client that doesn't`);
    for (const [c, ns] of variantCause) parts.push(`${names(ns, 10)} ${ns.length === 1 ? 'is' : 'are'} listed with another definition to a client that ${CAN[c]}`);
    const one = only.length + without.length + variants.length === 1;
    const sentence = parts.join('; ');
    return [
      {
        rule: 'menu/capability-dependent',
        severity: 'info',
        ...(one ? { tool: only[0] ?? without[0] ?? variants[0] } : {}),
        message: `${sentence}. ${WITHOUT[overall]} gets ${plain.length} ${plain.length === 1 ? 'tool' : 'tools'}${variants.length ? `, ${variants.length === 1 ? 'one' : 'some'} of them different` : ''}, not ${ctx.menu.tools.length}. The menu file holds the menu of a client with both, so diff sees ${only.length + variants.length === 1 ? 'that tool' : 'those tools'} as such a client gets ${only.length + variants.length === 1 ? 'it' : 'them'}.`,
        fix:
          overall === 'apps'
            ? 'Nothing to change if this is deliberate (a UI variant for Apps hosts). Keep a text-only variant that works without the UI, and say in the README which tools need an Apps host.'
            : 'Nothing to change if this is deliberate (a destructive tool that asks the user first, a UI variant for Apps hosts). Say in the README which tools need which client capability, so users of other clients know why they are missing.',
      },
    ];
  },
};
