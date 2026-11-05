import type { Era, Finding, Menu, MenuTool, Severity } from '../types.js';
import type { Routes } from '../routes.js';

export interface RuleContext {
  menu: Menu;
  /** The second `tools/list` from the same run, for the determinism check. */
  secondList?: MenuTool[];
  /** Raw `tools/list` result pages, as received. */
  pages: Record<string, unknown>[];
  /** Set when the official SDK client refused the tools/list result. */
  clientError?: string;
  protocolVersion?: string;
  era?: Era;
  capabilities: Record<string, unknown>;
  usedAuth: boolean;
  routes?: Routes;
  /** stdio or HTTP: which variance rule applies. */
  transport?: 'stdio' | 'http';
  /** Menus from fresh processes (stdio) or connections (HTTP), for the variance rules. */
  probes?: import('./determinism.js').Probe[];
  /** The stdio command is a container wrapper (docker run …): env vars may not reach the server. */
  wrapper?: boolean;
  /** serverInfo as the handshake sent it, when there was one (snapshot): spec/server-info. */
  serverInfo?: { name?: string; version?: string };
  /** How this run reached the server, as the command line ends: `-- node server.js` or the URL. For next steps. */
  server?: string;
  /** snapshot --as: each identity's menu, the main one first (menu/auth-variance, spec/cache-scope-public). */
  identities?: import('./identities.js').IdentityMenu[];
  /** snapshot --lists: the prompts and resources lists read (lists/* rules). */
  lists?: import('./lists.js').ListsContext;
  /** HTTP with credentials: what the server did with an invalid credential in their place. */
  invalidCredential?: import('./auth.js').InvalidCredential;
  /** snapshot --offline-check: the menu from a process with the network cut off. */
  offline?: import('./network.js').OfflineMenu;
  /** A later process or connection got 2026-07-28 while this one fell back to 2025 (spec/discover). */
  laterModern?: boolean;
  /** snapshot: the menu listed by a client that declares no elicitation support. */
  plain?: import('./capabilities.js').PlainMenu;
  /** --client: the client profile the menu is checked for (src/clients.ts). */
  client?: string;
  /** Where clients are assumed to cut tool descriptions (description/buried). */
  descriptionLimit?: number | string;
  /** Tools (names or globs) the client sends uncut, so description/buried skips them. */
  fullDescriptions?: string[];
  /** snapshot over HTTP: the Server Card at <url>/server-card, when the server answered with JSON there. */
  serverCard?: import('../card.js').CardRead;
  /** snapshot over HTTP: the URL connected to (no query), to find the card's remote for it. */
  serverUrl?: string;
  /** snapshot: what resources/read gave for each ui:// resource the tools name (MCP Apps). */
  appResources?: import('../apps.js').AppResource[];
  /**
   * Set by runRules from the `ignore` setting. Rules that sum many tools up in
   * one finding use it to leave ignored tools out of the summary; findings about
   * one tool are dropped by runRules itself.
   */
  isIgnored?: (tool: string) => boolean;
}

export type RuleFinding = Omit<Finding, 'rule' | 'severity'> & { severity?: Severity };

export interface Rule {
  id: string;
  severity: Severity;
  /** The failure in "I built 100+ tools for one MCP server" this rule comes from. */
  lesson?: string;
  /** Spec version the rule applies from. Skipped for older servers. */
  since?: string;
  summary: string;
  /**
   * 'agent': the rule is about what the agent reads (names, descriptions, schemas), so
   * it sees the menu without MCP Apps app-only tools (visibility without "model"),
   * which an Apps host keeps out of the agent's list. Rules about the wire see them all.
   */
  scope?: 'agent';
  run(ctx: RuleContext): RuleFinding[];
}

/** 2048 → "2,048". */
export function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** "1 tool", "3 tools". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** "a, b and c"; the first `max` and "and N more" when there are more. */
export function names(items: string[], max = Infinity): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${num(rest)} more`;
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** Text on one line, cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Tools the `ignore` setting doesn't drop, for findings that sum many tools up. */
export function kept<T extends { name: string }>(tools: T[], ctx: RuleContext): T[] {
  return ctx.isIgnored ? tools.filter((t) => !ctx.isIgnored!(t.name)) : tools;
}
