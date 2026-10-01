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
  /** How this run reached the server, as the command line ends: `-- node server.js` or the URL. For next steps. */
  server?: string;
  /** Where clients are assumed to cut tool descriptions (description/buried). */
  descriptionLimit?: number | string;
  /** Tools (names or globs) the client sends uncut, so description/buried skips them. */
  fullDescriptions?: string[];
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
