import { compareMenus, type ToolChange } from '../compare.js';
import { describeToolDifference, firstDifference } from '../difference.js';
import { serverWords } from '../failures.js';
import { toolDefinition } from '../menu.js';
import type { MenuTool, Severity } from '../types.js';
import { count, type Rule, type RuleContext, type RuleFinding } from './rule.js';

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

const EDITS = new Set<ToolChange['kind']>(['description', 'inputSchema', 'outputSchema', 'annotations', 'other', 'serialization']);
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** One value that differs inside a tool, as a path a server author can search for. */
interface Spot {
  tool: string;
  /** `list_transactions.end_date.default`: parameters are named without `inputSchema.properties`. */
  where: string;
  before: unknown;
  after: unknown;
  reordered: boolean;
}

/** Where each edited tool first differs between two menus. */
function spots(before: MenuTool[], after: MenuTool[], changes: ToolChange[]): Spot[] {
  const byName = new Map(before.map((t) => [t.name, t]));
  const edited = new Set(changes.filter((c) => EDITS.has(c.kind)).map((c) => c.tool));
  const out: Spot[] = [];
  for (const t of after.filter((x) => edited.has(x.name))) {
    const d = firstDifference(toolDefinition(byName.get(t.name)!), toolDefinition(t));
    const path = (d?.path ?? '').replace(/^inputSchema\.properties\./, '');
    out.push({ tool: t.name, where: path ? `${t.name}.${path}` : t.name, before: d?.before, after: d?.after, reordered: !!d?.reordered });
  }
  return out;
}

const isTime = (s: Spot) => TIMESTAMP.test(String(s.before)) && TIMESTAMP.test(String(s.after));

/** "list_transactions.end_date.default" or "a.b, c.d and 3 more places". */
function placesOf(found: Spot[]): string {
  const shown = found.slice(0, 2).map((s) => s.where).join(', ');
  return found.length > 2 ? `${shown} and ${found.length - 2} more ${found.length - 2 === 1 ? 'place' : 'places'}` : shown;
}

/** What differs, in words, after the first sentence of the message. */
function whatDiffers(changes: ToolChange[], found: Spot[]): string {
  const time = found.filter(isTime);
  if (time.length) return `${placesOf(time)} ${time.length === 1 ? 'is a timestamp' : 'are timestamps'}, taken when the menu is built.`;
  const sorted = found.filter((s) => s.reordered);
  if (sorted.length) return `${placesOf(sorted)} ${sorted.length === 1 ? 'holds' : 'hold'} the same items in a different order.`;
  if (found.length) return `It differs in ${placesOf(found)}.`;
  const tools = [...new Set(changes.filter((c) => c.kind === 'added' || c.kind === 'removed').map((c) => c.tool))];
  if (tools.length) return `The tool set itself changed: ${tools.slice(0, 3).join(', ')}${tools.length > 3 ? ` and ${tools.length - 3} more` : ''}.`;
  return '';
}

/** One step for the server author, for the most telling difference. */
function fixFor(changes: ToolChange[], found: Spot[], who: 'call' | 'process' | 'connection'): string {
  const time = found.find(isTime);
  if (time) return `Build ${time.where} from a fixed value, not the current time: leave it out, or say "defaults to now" in the description.`;
  const sorted = found.filter((s) => s.reordered);
  if (sorted.length) return `Sort the items of ${sorted[0].where}${sorted.length > 1 ? ` (and the ${count(sorted.length - 1, 'other place')} listed)` : ''} when building the menu (sorted(), not a set or a map), so every ${who} lists them in the same order.`;
  if (changes.some((c) => c.kind === 'added' || c.kind === 'removed')) {
    return 'Serve the same tools on every list; if the set really depends on state, send notifications/tools/list_changed when it changes.';
  }
  if (changes.every((c) => c.kind === 'moved')) return 'Return the tools in a fixed order: keep them in a list, or sort them by name before answering tools/list.';
  if (changes.every((c) => c.kind === 'serialization' || c.kind === 'moved')) return 'Build each tool object with its keys in a fixed order, so the bytes match as well as the content.';
  return `Build ${found[0]?.where ?? 'the menu'} from fixed values: nothing from the clock, a random ID, a counter or the environment.`;
}

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
    const found = spots(ctx.menu.tools, ctx.secondList, changes);
    const tools = [...new Set(changes.map((c) => c.tool))];
    return [
      {
        ...(tools.length === 1 ? { tool: tools[0] } : {}),
        message: onlyOrder
          ? 'Two identical tools/list calls, back to back, returned the tools in a different order, so a cached prompt with the tool list rarely matches the next one: every conversation can miss the prompt cache. The spec says servers SHOULD keep the order stable.'
          : `Two identical tools/list calls, back to back, returned different menus, so a cached prompt with the tool list rarely matches the next one: every conversation can miss the prompt cache. ${whatDiffers(changes, found)}`.trim(),
        detail: detailFor(ctx.menu.tools, ctx.secondList, changes),
        fix: fixFor(changes, found, 'call'),
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
  const found = spots(main, other, changes);
  const reordered = found.some((s) => s.reordered);
  const stdio = opts.transport === 'stdio';
  const message = [
    stdio
      ? 'A second server process, started the same way, served a different menu, so every restart, and every client that starts its own copy, gets a tool list that no cached prompt matches.'
      : `A second connection with the same credentials got a different menu, so clients can't share a cached tool list.${opts.modern ? ' On 2026-07-28 the tool set MUST NOT vary per connection.' : ''}`,
    whatDiffers(changes, found),
    reordered
      ? 'Likely a set or a map iterated in hash order.' +
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
    fix: fixFor(changes, found, stdio ? 'process' : 'connection'),
  };
}

/**
 * The places menu/nondeterministic reports, when the second list differs too:
 * a probe that differs only there has the same cause, and says so instead of
 * repeating it.
 */
function listSpots(ctx: RuleContext): Set<string> | undefined {
  if (!ctx.secondList) return undefined;
  const changes = compareMenus(ctx.menu.tools, ctx.secondList);
  if (changes.length === 0) return undefined;
  return new Set([...changes.filter((c) => !EDITS.has(c.kind)).map((c) => `${c.kind}:${c.tool}`), ...spots(ctx.menu.tools, ctx.secondList, changes).map((s) => s.where)]);
}

function varianceRule(id: 'menu/process-variance' | 'menu/connection-variance', transport: 'stdio' | 'http'): Rule {
  const other = transport === 'stdio' ? 'server process' : 'connection';
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
          out.push({
            severity: 'info',
            message: `Couldn't ${transport === 'stdio' ? 'start a second server process' : 'open a second connection'} to compare menus, so this wasn't checked: ${serverWords(probe.error, 200)}`,
            fix: transport === 'stdio'
              ? 'If the server can only run once at a time (a lock, a port), rerun with --processes 1 to skip this check.'
              : 'If the server allows one connection at a time, rerun with --processes 1 to skip this check.',
          });
          continue;
        }
        const f = varianceFinding(ctx.menu.tools, probe.tools ?? [], { transport, modern: ctx.era === 'modern', wrapper: !!ctx.wrapper });
        if (f) {
          const { rule: _r, ...rest } = f;
          // Same places as the second tools/list call: one cause, reported by menu/nondeterministic.
          const same = listSpots(ctx);
          const changes = compareMenus(ctx.menu.tools, probe.tools ?? []);
          const here = [...changes.filter((c) => !EDITS.has(c.kind)).map((c) => `${c.kind}:${c.tool}`), ...spots(ctx.menu.tools, probe.tools ?? [], changes).map((s) => s.where)];
          if (same && here.every((w) => same.has(w))) {
            out.push({
              ...rest,
              message: `A second ${other} served a different menu too, in the same ${here.length === 1 ? 'place' : 'places'} menu/nondeterministic reports: a menu that changes on every call changes on every ${transport === 'stdio' ? 'restart' : 'connection'} as well. Same cause, same fix.`,
              fix: 'Fix menu/nondeterministic; this goes away with it.',
            });
          } else {
            out.push(rest);
          }
          break; // one finding: a second differing probe says nothing new
        }
      }
      return out;
    },
  };
}

export const processVariance = varianceRule('menu/process-variance', 'stdio');
export const connectionVariance = varianceRule('menu/connection-variance', 'http');
