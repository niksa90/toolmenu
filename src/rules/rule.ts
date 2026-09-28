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
  /** Where clients are assumed to cut tool descriptions (description/buried). */
  descriptionLimit?: number | string;
  /** Tools (names or globs) the client sends uncut, so description/buried skips them. */
  fullDescriptions?: string[];
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
