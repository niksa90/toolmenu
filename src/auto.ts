import { readFile } from 'node:fs/promises';
import { isMap, isNode, isScalar, parseDocument, type Document } from 'yaml';
import { synthesizeArgs } from './args.js';
import { MAX_UNLOCKS, unlockers, type Scenario, type Step } from './session.js';
import type { Menu, MenuTool } from './types.js';
import { COLLECTION_VERBS, LOOKUP_VERBS, verbOf, WRITE_VERBS } from './words.js';

/** A value the user gave: `raw` is the text as typed on the command line, when it was typed. */
export interface GivenValue {
  /** The text as typed, for fitValue: `42` for a string parameter is "42". */
  raw?: string;
  value: unknown;
  /** A values file's map grouped by tool: each field with its own text. */
  fields?: Record<string, GivenValue>;
}

export interface AutoOptions {
  /** Also call read-only tools marked openWorldHint: true (web search, fetch, scraping). */
  openWorld?: boolean;
  /** At most this many calls (default 20). */
  maxCalls?: number;
  /**
   * Only the calls: no list first, no repeat of the first call at the end. For
   * tools that appear mid-session, planned into a session already running.
   */
  callsOnly?: boolean;
  /**
   * Values for required parameters, by name (`repo_path`) or for one tool
   * (`get_issue.issue_key`). Used before anything is synthesized.
   */
  values?: Record<string, GivenValue>;
  /**
   * Tools the user says only read, although the server doesn't mark them
   * readOnlyHint. Exact names: a pattern would also cover tools a later release
   * adds, which nobody has looked at. A tool marked or named as a write is still
   * never called.
   */
  assumeReadOnly?: string[];
}

export type SkipReason = 'not read-only' | 'unmarked' | 'open world' | 'needs values' | 'over the call budget';

export interface AutoPlan {
  scenario: Scenario;
  called: string[];
  /** Called on the user's word (--assume-read-only): the server doesn't mark them readOnlyHint. */
  assumed: string[];
  /** Called with at least one value the user gave. */
  withValues: string[];
  skipped: { tool: string; reason: SkipReason; missing?: string[]; why?: string }[];
  /** --value and --assume-read-only entries that did nothing, and why. */
  ignored: { input: string; why: string }[];
  /** Calls counted against --max-calls (unlocks aren't). */
  spent: number;
}

/** What a session report shows about an --auto plan. */
export type AutoSummary = Pick<AutoPlan, 'called' | 'skipped'> &
  Partial<Pick<AutoPlan, 'assumed' | 'withValues' | 'ignored'>> & {
    maxCalls?: number;
    /** Guessed unlocks whose first value changed nothing, and how many calls to them were left out. */
    stopped?: { tool: string; calls: number }[];
  };

/** Marked or named as a write: never called on the user's word. Says why, or undefined. */
export function writeSign(tool: MenuTool): string | undefined {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === false) return 'the server marks it readOnlyHint: false';
  if (a.destructiveHint === true) return 'the server marks it destructiveHint: true';
  const verb = verbOf(tool.name);
  if (verb && WRITE_VERBS.has(verb)) return `its name starts with "${verb}", a write`;
  return undefined;
}

/**
 * A scenario built from the menu, no hand-written steps: every read-only tool
 * whose required arguments the user's values and the schema can fill, cheapest
 * first (no arguments, then lists and searches, then single lookups, then the
 * rest), then the first call again, which should change nothing. Never a tool that
 * isn't marked readOnlyHint, whatever allow_writes says, unless the user named it
 * in assumeReadOnly and nothing marks or names it as a write.
 */
export function autoScenario(menu: Menu, options: AutoOptions = {}): AutoPlan {
  const maxCalls = options.maxCalls ?? 20;
  const skipped: AutoPlan['skipped'] = [];
  const ignored: AutoPlan['ignored'] = [];
  const byName = new Map(menu.tools.map((t) => [t.name, t]));

  // --assume-read-only: exact names, and never a write.
  const assumed = new Set<string>();
  for (const name of options.assumeReadOnly ?? []) {
    const tool = byName.get(name);
    if (!tool) ignored.push({ input: `--assume-read-only ${name}`, why: 'no tool by that name in the menu' });
    else if (tool.annotations?.readOnlyHint === true) ignored.push({ input: `--assume-read-only ${name}`, why: 'the server already marks it readOnlyHint: true' });
    else if (writeSign(tool)) ignored.push({ input: `--assume-read-only ${name}`, why: `not called: ${writeSign(tool)}` });
    else assumed.add(name);
  }
  const readOnly = (t: MenuTool) => t.annotations?.readOnlyHint === true || assumed.has(t.name);

  const { perTool, ignored: unusedValues } = resolveValues(menu, options.values ?? {});
  ignored.push(...unusedValues);

  const candidates: { tool: MenuTool; args: Record<string, unknown>; rank: number; valued: boolean }[] = [];
  // Read-only unlocks with every value in an enum: each value, outside the call
  // budget, so the tools behind every toolset are seen (GitHub: 19 toolsets).
  // Called even when marked openWorldHint, without --open-world: an unlock changes
  // the menu, which is what a session watches, and spends no search credits. A
  // server whose every tool calls an outside service marks its unlock that way too,
  // and --auto then tested nothing.
  const unlocks = unlockers(menu.tools).filter((u) => {
    const required = u.tool.inputSchema?.required ?? [];
    return u.param && u.values.length && readOnly(u.tool) && required.every((p) => p === u.param);
  });
  const unlocking = new Set(unlocks.map((u) => u.tool.name));
  for (const tool of menu.tools) {
    if (unlocking.has(tool.name)) continue;
    const a = tool.annotations ?? {};
    if (!readOnly(tool)) {
      const write = writeSign(tool);
      skipped.push(write || a.readOnlyHint !== undefined ? { tool: tool.name, reason: 'not read-only', ...(write ? { why: write } : {}) } : { tool: tool.name, reason: 'unmarked' });
      continue;
    }
    // readOnlyHint is the server's own claim, and a read-only search still spends
    // credits on a paid API. Servers that mark a tool openWorldHint: true are the
    // web search, fetch and scraping ones (Exa, Firecrawl, Context7, Playwright):
    // opt-in. Unmarked tools are called: on GitHub, Atlassian or Notion that's
    // every read, of the account the credentials belong to (FINDINGS F13).
    if (a.openWorldHint === true && !options.openWorld) {
      skipped.push({ tool: tool.name, reason: 'open world' });
      continue;
    }
    const filled = synthesizeArgs(tool.inputSchema, perTool.get(tool.name));
    if (!filled.ok) {
      skipped.push({ tool: tool.name, reason: 'needs values', missing: filled.missing });
      continue;
    }
    candidates.push({ tool, args: filled.args, rank: rank(tool, filled.args), valued: Object.values(filled.sources).includes('value') });
  }
  candidates.sort((x, y) => x.rank - y.rank);
  const chosen = candidates.slice(0, maxCalls);
  for (const c of candidates.slice(maxCalls)) skipped.push({ tool: c.tool.name, reason: 'over the call budget' });

  const steps: Step[] = options.callsOnly ? [] : [{ kind: 'list' }];
  for (const c of chosen) steps.push({ kind: 'call', tool: c.tool.name, args: c.args });
  for (const u of unlocks) {
    const array = u.tool.inputSchema?.properties?.[u.param!]?.type === 'array';
    const values = u.values.slice(0, MAX_UNLOCKS);
    // Guessed from its schema alone (nothing says it unlocks tools): if the first
    // value changes nothing, the session doesn't spend a call on every other one.
    const tentative = u.claims ? {} : { tentative: true };
    for (const v of values) steps.push({ kind: 'call', tool: u.tool.name, args: { [u.param!]: array ? [v] : v }, ...tentative });
    // The same unlock again should change nothing, as in the --init starter.
    steps.push({ kind: 'call', tool: u.tool.name, args: { [u.param!]: array ? [values[0]] : values[0] }, ...tentative });
  }
  if (chosen.length && !options.callsOnly) steps.push({ kind: 'call', tool: chosen[0].tool.name, args: chosen[0].args });
  const called = [...chosen.map((c) => c.tool.name), ...unlocks.map((u) => u.tool.name)];
  return {
    scenario: { allowWrites: false, steps, ...(assumed.size ? { assumeReadOnly: [...assumed] } : {}) },
    called,
    assumed: called.filter((n) => assumed.has(n)),
    withValues: chosen.filter((c) => c.valued).map((c) => c.tool.name),
    skipped,
    ignored,
    spent: chosen.length,
  };
}

/**
 * The user's values, per tool. `param` fills that required parameter wherever a
 * tool has it; `tool.param` fills it, required or not, on that tool only (and
 * wins over a by-name value). A value no tool takes is reported, not dropped.
 */
function resolveValues(menu: Menu, values: Record<string, GivenValue>): { perTool: Map<string, Record<string, GivenValue>>; ignored: AutoPlan['ignored'] } {
  const perTool = new Map<string, Record<string, GivenValue>>();
  const ignored: AutoPlan['ignored'] = [];
  const set = (tool: string, param: string, v: GivenValue) => perTool.set(tool, { ...perTool.get(tool), [param]: v });
  const byName = new Map(menu.tools.map((t) => [t.name, t]));
  const targeted: [string, string, GivenValue][] = [];
  for (const [key, v] of Object.entries(values)) {
    // A values file can group by tool: `get_issue: { issue_key: ABC-1 }`.
    if (byName.has(key) && v.raw === undefined && v.value && typeof v.value === 'object' && !Array.isArray(v.value)) {
      for (const [param, pv] of Object.entries(v.value)) {
        if (!byName.get(key)!.inputSchema?.properties?.[param]) ignored.push({ input: `${key}.${param}`, why: `${key} has no parameter ${param}` });
        else targeted.push([key, param, v.fields?.[param] ?? { value: pv, ...(typeof pv === 'string' ? { raw: pv } : {}) }]);
      }
      continue;
    }
    const dot = key.lastIndexOf('.');
    const toolName = dot > 0 ? key.slice(0, dot) : '';
    if (toolName && byName.has(toolName)) {
      const param = key.slice(dot + 1);
      if (!byName.get(toolName)!.inputSchema?.properties?.[param]) ignored.push({ input: `--value ${key}`, why: `${toolName} has no parameter ${param}` });
      else targeted.push([toolName, param, v]);
      continue;
    }
    const takers = menu.tools.filter((t) => (t.inputSchema?.required ?? []).includes(key));
    if (takers.length) {
      for (const t of takers) set(t.name, key, v);
      continue;
    }
    const optional = menu.tools.filter((t) => t.inputSchema?.properties?.[key]).map((t) => t.name);
    ignored.push({
      input: `--value ${key}`,
      why: optional.length
        ? `no tool requires ${key}; to pass it where it's optional, name the tool (--value ${optional[0]}.${key}=…)`
        : toolName
          ? `no tool named ${toolName}, and no parameter named ${key}`
          : `no tool takes a parameter named ${key}`,
    });
  }
  for (const [tool, param, v] of targeted) set(tool, param, v);
  return { perTool, ignored };
}

/** `name=value` from --value: JSON when it parses (numbers, true, lists), the text otherwise. */
export function parseValueFlag(text: string): [string, GivenValue] {
  const eq = text.indexOf('=');
  if (eq <= 0) throw new Error(`--value ${text}: expected name=value or tool.name=value (e.g. --value repo_path=/src/app)`);
  const key = text.slice(0, eq).trim();
  const raw = text.slice(eq + 1);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // plain text
  }
  return [key, { raw, value }];
}

/** A values file: a YAML or JSON map, keys as in --value (`repo_path`, `get_issue.issue_key`). */
export async function loadValuesFile(path: string): Promise<Record<string, GivenValue>> {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(await readFile(path, 'utf8'));
    if (doc.errors.length) throw doc.errors[0];
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isMap(doc.contents)) throw new Error(`${path}: expected a map of parameter names to values (repo_path: /src/app)`);
  const data = doc.toJS() as Record<string, unknown>;
  const out: Record<string, GivenValue> = {};
  for (const pair of doc.contents.items) {
    const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
    // Grouped per tool (`get_issue: { issue_key: ABC-1 }`) is sorted out against the menu.
    const fields = isMap(pair.value)
      ? Object.fromEntries(pair.value.items.map((p) => [String(isScalar(p.key) ? p.key.value : p.key), given(p.value)]))
      : undefined;
    out[key] = { ...given(pair.value, data[key]), ...(fields ? { fields } : {}) };
  }
  return out;
}

/**
 * One value from a values file, with the text a scalar was written as: YAML reads
 * `42` as a number and `02134` as 2134, but for a string parameter the user meant
 * the text, as with --value.
 */
function given(node: unknown, value: unknown = isNode(node) ? node.toJSON() : node): GivenValue {
  const raw = isScalar(node) ? (node.source ?? (typeof node.value === 'string' ? node.value : undefined)) : undefined;
  return { value, ...(raw !== undefined ? { raw } : {}) };
}

/** --assume-read-only a,b --assume-read-only c: exact names, no patterns. */
export function parseAssumeReadOnly(flags: string[]): string[] {
  const names = flags.flatMap((f) => f.split(',')).map((s) => s.trim()).filter(Boolean);
  const pattern = names.find((n) => /[*?[\]]/.test(n));
  if (pattern) {
    throw new Error(`--assume-read-only takes exact tool names, not patterns (${pattern}): a pattern would also cover tools a later release adds, which nobody has checked. List the tools.`);
  }
  return [...new Set(names)];
}

function rank(tool: MenuTool, args: Record<string, unknown>): number {
  if (Object.keys(args).length === 0) return 0;
  const verb = verbOf(tool.name);
  if (verb && COLLECTION_VERBS.has(verb)) return 1;
  if (verb && LOOKUP_VERBS.has(verb)) return 2;
  return 3;
}

/** Parameters the skipped tools need, most needed first, with how many tools each fills. */
export function neededValues(skipped: AutoPlan['skipped']): { param: string; tools: string[] }[] {
  const by = new Map<string, string[]>();
  for (const s of skipped) if (s.reason === 'needs values') for (const m of s.missing ?? []) by.set(m, [...(by.get(m) ?? []), s.tool]);
  return [...by].map(([param, tools]) => ({ param, tools })).sort((a, b) => b.tools.length - a.tools.length || a.param.localeCompare(b.param));
}

/**
 * The one flag or two that would let --auto call more, as a next step: values for
 * the parameters most tools need, the unmarked tools to vouch for, --open-world.
 * Undefined when nothing was left out that a flag can reach.
 */
export function autoNextStep(auto: AutoSummary): string | undefined {
  const needs = neededValues(auto.skipped);
  const unmarked = auto.skipped.filter((s) => s.reason === 'unmarked').map((s) => s.tool);
  const openWorld = auto.skipped.filter((s) => s.reason === 'open world').length;
  const parts: string[] = [];
  if (needs.length) {
    const top = needs.slice(0, 3).map((n) => `--value ${n.param}=…`).join(' ');
    parts.push(needs.length > 3 ? `${top} (or --save-scenario auto.yml and fill in the other ${needs.length - 3})` : top);
  }
  if (unmarked.length) parts.push(`--assume-read-only ${list(unmarked, 4, ',')} for the ones that only read`);
  if (openWorld) parts.push('--open-world (may cost API credits)');
  return parts.length ? `Rerun with ${parts.join('; or ')}.` : undefined;
}

function list(names: string[], max: number, sep = ', '): string {
  return names.slice(0, max).join(sep) + (names.length > max ? `${sep === ',' ? ',' : sep}…` : '');
}

/**
 * What --auto called and what it left out, each with the flag that reaches it: the
 * header line of a session report, then one line per reason.
 */
export function autoSummary(auto: AutoSummary): string[] {
  const n = auto.called.length;
  const extras = [
    auto.withValues?.length ? `${auto.withValues.length} with your --value` : '',
    auto.assumed?.length ? `${auto.assumed.length} on your word, not marked read-only: ${list(auto.assumed, 6)}` : '',
  ].filter(Boolean);
  const lines = [`auto: called ${n} tool${n === 1 ? '' : 's'}${extras.length ? ` (${extras.join('; ')})` : ''}`];
  const skip = (reason: SkipReason) => auto.skipped.filter((s) => s.reason === reason);
  const rows: string[] = [];
  const needs = skip('needs values');
  if (needs.length) {
    const params = neededValues(auto.skipped);
    const shown = params.slice(0, 4).map((p) => `--value ${p.param}=… (${p.tools.length})`);
    rows.push(`${needs.length} need values the schema doesn't give → ${shown.join(', ')}${params.length > 4 ? `, and ${params.length - 4} more (--save-scenario lists them)` : ''}`);
  }
  const unmarked = skip('unmarked');
  if (unmarked.length) rows.push(`${unmarked.length} not marked read-only → --assume-read-only ${list(unmarked.map((s) => s.tool), 4, ',')} if they only read`);
  const writes = skip('not read-only');
  if (writes.length) rows.push(`${writes.length} marked or named as writes (never called)`);
  const openWorld = skip('open world');
  if (openWorld.length) rows.push(`${openWorld.length} marked openWorldHint → --open-world (may cost API credits)`);
  const over = skip('over the call budget');
  // Unlocks run outside the budget, so called.length would overshoot.
  if (over.length) rows.push(`${over.length} over the call budget → --max-calls ${(auto.maxCalls ?? 20) + over.length}`);
  rows.forEach((r, i) => lines.push(`${i === 0 ? 'not called: ' : '            '}${r}`));
  for (const x of auto.stopped ?? [])
    lines.push(`stopped: ${x.tool}: its first value changed nothing and it doesn't say it unlocks tools, so the other ${x.calls} call${x.calls === 1 ? ' was' : 's were'} left out (a scenario can still make them)`);
  for (const x of auto.ignored ?? []) lines.push(`ignored: ${x.input}: ${x.why}`);
  return lines;
}

/** The plan as a scenario file, to commit and run again with --scenario. */
export function scenarioYaml(plan: AutoPlan, serverName?: string): string {
  const lines = [
    `# Written by \`toolmenu session --auto\`${serverName ? ` for ${serverName}` : ''}: every read-only tool whose`,
    '# required arguments your values and the schema could fill. Edit freely.',
    'allow_writes: false',
  ];
  if (plan.assumed.length) {
    lines.push(
      '# Not marked readOnlyHint by the server; called because you said they only read:',
      `assume_read_only: [${plan.assumed.map((n) => JSON.stringify(n)).join(', ')}]`,
    );
  }
  lines.push('steps:');
  for (const step of plan.scenario.steps) {
    if (step.kind === 'list') lines.push('  - list');
    else if (step.kind === 'call') {
      lines.push(`  - call: ${step.tool}`);
      if (Object.keys(step.args).length) lines.push(`    args: ${JSON.stringify(step.args)}`);
    }
  }
  const needs = plan.skipped.filter((s) => s.reason === 'needs values');
  if (needs.length) {
    lines.push('', '  # Read-only tools that need values the schema doesn\'t give. Fill in the TODOs and uncomment:');
    for (const s of needs.slice(0, 15)) lines.push(`  # - call: ${s.tool}`, `  #   args: { ${s.missing!.map((m) => `${m}: TODO`).join(', ')} }`);
    if (needs.length > 15) lines.push(`  # …and ${needs.length - 15} more: ${needs.slice(15).map((s) => s.tool).join(', ')}`);
  }
  return lines.join('\n') + '\n';
}
