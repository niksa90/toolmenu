import { canonical } from './compare.js';
import { countTokens } from './menu.js';
import type { JsonSchema, Menu } from './types.js';

export interface Breakdown {
  total: number;
  /** The biggest tools, with their share of the menu and what their tokens are spent on. */
  top: { name: string; tokens: number; share: number; description: number; schema: number }[];
  /** Enums with many values. */
  enums: { tool: string; param: string; values: number; tokens: number }[];
  /** The same parameter, byte for byte, in several tools: paid once per tool. */
  repeated: { param: string; tokens: number; tools: number; total: number }[];
}

const TOP = 5;
const BIG_ENUM = 20;
const REPEATED_MIN_TOKENS = 30;
const REPEATED_MIN_TOOLS = 3;

/** Where a menu's tokens go. Estimates, like every count in toolmenu. */
export function breakdown(menu: Menu): Breakdown {
  const total = menu.totalTokens || 1;
  const top = [...menu.tools]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP)
    .map((t) => ({
      name: t.name,
      tokens: t.tokens,
      share: t.tokens / total,
      description: t.description ? countTokens(JSON.stringify(t.description)) : 0,
      schema: t.inputSchema ? countTokens(JSON.stringify(t.inputSchema)) : 0,
    }));

  const enums: Breakdown['enums'] = [];
  const seen = new Map<string, { param: string; tokens: number; tools: Set<string> }>();
  for (const tool of menu.tools) {
    for (const [param, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
      const values = enumValues(schema);
      if (values.length >= BIG_ENUM) enums.push({ tool: tool.name, param, values: values.length, tokens: countTokens(JSON.stringify(values)) });
      const key = `${param}\u0000${canonical(schema)}`;
      const entry = seen.get(key) ?? { param, tokens: countTokens(JSON.stringify({ [param]: schema })), tools: new Set<string>() };
      entry.tools.add(tool.name);
      seen.set(key, entry);
    }
  }
  const repeated = [...seen.values()]
    .filter((e) => e.tokens >= REPEATED_MIN_TOKENS && e.tools.size >= REPEATED_MIN_TOOLS)
    .map((e) => ({ param: e.param, tokens: e.tokens, tools: e.tools.size, total: e.tokens * e.tools.size }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  enums.sort((a, b) => b.tokens - a.tokens);
  return { total: menu.totalTokens, top, enums: enums.slice(0, 5), repeated };
}

function enumValues(schema: JsonSchema): unknown[] {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.items?.enum)) return schema.items!.enum!;
  return [];
}

/** The breakdown as report lines, or none for a menu too small to need one. */
export function breakdownLines(b: Breakdown, tools: number): string[] {
  if (tools < 5) return [];
  const n = (x: number) => `~${x.toLocaleString('en-US')}`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const topShare = b.top.reduce((s, t) => s + t.share, 0);
  const lines = [`Where the tokens go (estimate): the top ${b.top.length} tools are ${pct(topShare)} of the menu`];
  for (const t of b.top) lines.push(`  ${pct(t.share).padStart(4)}  ${t.name} ${n(t.tokens)} (description ${n(t.description)}, schema ${n(t.schema)})`);
  for (const e of b.enums) lines.push(`  enum: ${e.tool}.${e.param} has ${e.values} values, ${n(e.tokens)} tokens`);
  for (const r of b.repeated) lines.push(`  repeated: ${r.param} (${n(r.tokens)}) in ${r.tools} tools, ${n(r.total)} in all`);
  return lines;
}
