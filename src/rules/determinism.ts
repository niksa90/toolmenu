import { compareMenus, type ToolChange } from '../compare.js';
import { describeToolDifference } from '../difference.js';
import type { MenuTool, Severity } from '../types.js';
import type { Rule, RuleFinding } from './rule.js';

const LABELS: Record<ToolChange['kind'], string> = {
  added: 'tool added',
  removed: 'tool removed',
  moved: 'order changed',
  description: 'description changed',
  inputSchema: 'inputSchema changed',
  outputSchema: 'outputSchema changed',
  annotations: 'annotations changed',
  other: 'definition changed',
  serialization: 'key order changed (same content, different bytes)',
};

export const nondeterministic: Rule = {
  id: 'menu/nondeterministic',
  severity: 'error',
  lesson: '05',
  summary: 'Two identical tools/list calls must return the same menu',
  run(ctx) {
    if (!ctx.secondList) return [];
    const changes = compareMenus(ctx.menu.tools, ctx.secondList);
    if (changes.length === 0) return [];
    const onlyOrder = changes.every((c) => c.kind === 'moved');
    return [
      {
        message: onlyOrder
          ? 'Two identical tools/list calls returned the tools in a different order. Every conversation can miss the prompt cache. The spec says servers SHOULD return a deterministic order.'
          : 'Two identical tools/list calls returned different menus. Every conversation can miss the prompt cache.',
        detail: detailFor(ctx.menu.tools, ctx.secondList, changes),
      },
    ];
  },
};

/** One line per change; edits say which value differs, down to the leaf. */
function detailFor(before: MenuTool[], after: MenuTool[], changes: ToolChange[]): string[] {
  const byName = new Map(before.map((t) => [t.name, t]));
  const edited = new Set(changes.filter((c) => EDITS.has(c.kind)).map((c) => c.tool));
  const lines = [
    ...changes.filter((c) => !EDITS.has(c.kind)).map((c) => `${LABELS[c.kind]}: ${c.tool} (position ${c.position})`),
    ...after.filter((t) => edited.has(t.name)).map((t) => describeToolDifference(byName.get(t.name)!, t)),
  ];
  return lines.slice(0, 10).concat(lines.length > 10 ? [`…and ${lines.length - 10} more`] : []);
}

/** What a second process or connection served, for the variance rules. */
export interface Probe {
  tools?: MenuTool[];
  /** Why the probe couldn't list tools, when it couldn't. */
  error?: string;
}

/**
 * The finding for a menu that differs between processes (stdio) or connections
 * (HTTP), shared by snapshot and session so both say the same thing at the same
 * severity. Undefined when the menus match.
 */
export function varianceFinding(
  main: MenuTool[],
  other: MenuTool[],
  opts: { transport: 'stdio' | 'http'; modern: boolean; wrapper: boolean },
): (RuleFinding & { rule: string; severity: Severity }) | undefined {
  const changes = compareMenus(main, other);
  if (changes.length === 0) return undefined;
  const detail = detailFor(main, other, changes);
  const reordered = detail.some((d) => d.includes('same ') && d.includes('different order'));
  const stdio = opts.transport === 'stdio';
  const message = [
    stdio
      ? 'A second server process, started the same way, served a different menu. Every restart, and every client that starts its own copy, gets a tool list that can\'t reuse a cached prompt.'
      : `A second connection with the same credentials got a different menu.${opts.modern ? ' On 2026-07-28 the tool set MUST NOT vary per-connection.' : ''} Clients can't share a cached menu.`,
    reordered
      ? 'The same items came out in a different order: likely a set or map iterated in hash order.' +
        (stdio ? ' (toolmenu runs the first process with PYTHONHASHSEED=0 and the second with 1, so a Python set shows up every time; Go and Rust maps vary per process on their own.)' : '')
      : '',
    opts.wrapper
      ? 'The server runs in a container: PYTHONHASHSEED and --env only reach it if passed through (docker run -e).'
      : '',
  ].filter(Boolean).join(' ');
  return {
    rule: stdio ? 'menu/process-variance' : 'menu/connection-variance',
    severity: stdio || opts.modern ? 'error' : 'warn',
    message,
    detail,
  };
}

const EDITS = new Set<ToolChange['kind']>(['description', 'inputSchema', 'outputSchema', 'annotations', 'other', 'serialization']);

function varianceRule(id: 'menu/process-variance' | 'menu/connection-variance', transport: 'stdio' | 'http'): Rule {
  return {
    id,
    severity: 'error',
    lesson: '05',
    summary: transport === 'stdio' ? 'A second server process serves the same menu' : 'A second connection gets the same menu',
    run(ctx) {
      if (ctx.transport !== transport || !ctx.probes?.length) return [];
      const out: RuleFinding[] = [];
      for (const probe of ctx.probes) {
        if (probe.error) {
          out.push({ severity: 'info', message: `Couldn't ${transport === 'stdio' ? 'start a second server process' : 'open a second connection'} to compare menus, so this wasn't checked: ${probe.error.split('\n')[0]}` });
          continue;
        }
        const f = varianceFinding(ctx.menu.tools, probe.tools ?? [], { transport, modern: ctx.era === 'modern', wrapper: !!ctx.wrapper });
        if (f) {
          const { rule: _r, ...rest } = f;
          out.push(rest);
          break; // one finding: a second differing probe says nothing new
        }
      }
      return out;
    },
  };
}

export const processVariance = varianceRule('menu/process-variance', 'stdio');
export const connectionVariance = varianceRule('menu/connection-variance', 'http');
