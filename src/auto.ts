import { synthesizeArgs } from './args.js';
import { MAX_UNLOCKS, unlockers, type Scenario, type Step } from './session.js';
import type { Menu, MenuTool } from './types.js';
import { COLLECTION_VERBS, LOOKUP_VERBS, verbOf } from './words.js';

export interface AutoOptions {
  /** Also call read-only tools marked openWorldHint: true (web search, fetch, scraping). */
  openWorld?: boolean;
  /** At most this many calls (default 20). */
  maxCalls?: number;
}

export type SkipReason = 'not read-only' | 'open world' | 'needs values' | 'over the call budget';

export interface AutoPlan {
  scenario: Scenario;
  called: string[];
  skipped: { tool: string; reason: SkipReason; missing?: string[] }[];
}

/**
 * A scenario built from the menu, no hand-written steps: every read-only tool
 * whose required arguments the schema can fill, cheapest first (no arguments,
 * then lists and searches, then single lookups, then the rest), then the first
 * call again, which should change nothing. Never a tool that isn't marked
 * readOnlyHint, whatever allow_writes says.
 */
export function autoScenario(menu: Menu, options: AutoOptions = {}): AutoPlan {
  const maxCalls = options.maxCalls ?? 20;
  const skipped: AutoPlan['skipped'] = [];
  const candidates: { tool: MenuTool; args: Record<string, unknown>; rank: number }[] = [];
  // Read-only unlocks with every value in an enum: each value, outside the call
  // budget, so the tools behind every toolset are seen (GitHub: 19 toolsets).
  // Called even when marked openWorldHint, without --open-world: an unlock changes
  // the menu, which is what a session watches, and spends no search credits. A
  // server whose every tool calls an outside service marks its unlock that way too,
  // and --auto then tested nothing.
  const unlocks = unlockers(menu.tools).filter((u) => {
    const a = u.tool.annotations ?? {};
    const required = u.tool.inputSchema?.required ?? [];
    return u.param && u.values.length && a.readOnlyHint === true && required.every((p) => p === u.param);
  });
  const unlocking = new Set(unlocks.map((u) => u.tool.name));
  for (const tool of menu.tools) {
    if (unlocking.has(tool.name)) continue;
    const a = tool.annotations ?? {};
    if (a.readOnlyHint !== true) {
      skipped.push({ tool: tool.name, reason: 'not read-only' });
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
    const filled = synthesizeArgs(tool.inputSchema);
    if (!filled.ok) {
      skipped.push({ tool: tool.name, reason: 'needs values', missing: filled.missing });
      continue;
    }
    candidates.push({ tool, args: filled.args, rank: rank(tool, filled.args) });
  }
  candidates.sort((x, y) => x.rank - y.rank);
  const chosen = candidates.slice(0, maxCalls);
  for (const c of candidates.slice(maxCalls)) skipped.push({ tool: c.tool.name, reason: 'over the call budget' });

  const steps: Step[] = [{ kind: 'list' }];
  for (const c of chosen) steps.push({ kind: 'call', tool: c.tool.name, args: c.args });
  for (const u of unlocks) {
    const array = u.tool.inputSchema?.properties?.[u.param!]?.type === 'array';
    const values = u.values.slice(0, MAX_UNLOCKS);
    for (const v of values) steps.push({ kind: 'call', tool: u.tool.name, args: { [u.param!]: array ? [v] : v } });
    // The same unlock again should change nothing, as in the --init starter.
    steps.push({ kind: 'call', tool: u.tool.name, args: { [u.param!]: array ? [values[0]] : values[0] } });
  }
  if (chosen.length) steps.push({ kind: 'call', tool: chosen[0].tool.name, args: chosen[0].args });
  return { scenario: { allowWrites: false, steps }, called: [...chosen.map((c) => c.tool.name), ...unlocks.map((u) => u.tool.name)], skipped };
}

function rank(tool: MenuTool, args: Record<string, unknown>): number {
  if (Object.keys(args).length === 0) return 0;
  const verb = verbOf(tool.name);
  if (verb && COLLECTION_VERBS.has(verb)) return 1;
  if (verb && LOOKUP_VERBS.has(verb)) return 2;
  return 3;
}

/** The plan as a scenario file, to commit and run again with --scenario. */
export function scenarioYaml(plan: AutoPlan, serverName?: string): string {
  const lines = [
    `# Written by \`toolmenu session --auto\`${serverName ? ` for ${serverName}` : ''}: every read-only tool whose`,
    '# required arguments the schema could fill. Edit freely.',
    'allow_writes: false',
    'steps:',
  ];
  for (const step of plan.scenario.steps) {
    if (step.kind === 'list') lines.push('  - list');
    else if (step.kind === 'call') {
      lines.push(`  - call: ${step.tool}`);
      if (Object.keys(step.args).length) lines.push(`    args: ${JSON.stringify(step.args)}`);
    }
  }
  const needs = plan.skipped.filter((s) => s.reason === 'needs values');
  if (needs.length) {
    lines.push('', '  # Read-only tools that need values the schema doesn\'t give:');
    for (const s of needs.slice(0, 15)) lines.push(`  # - call: ${s.tool}`, `  #   args: { ${s.missing!.map((m) => `${m}: TODO`).join(', ')} }`);
  }
  return lines.join('\n') + '\n';
}
