import { canonical } from './compare.js';
import { countTokens } from './menu.js';
import type { JsonSchema, Menu } from './types.js';

export interface Breakdown {
  total: number;
  /** The biggest tools, with their share of the menu and what their tokens are spent on. */
  top: { name: string; tokens: number; share: number; description: number; schema: number }[];
  /** Enums with many values. */
  enums: { tool: string; param: string; values: number; tokens: number }[];
  /**
   * A block of schema, byte for byte the same content, at several places: inside
   * one tool (a `$defs` entry could hold it once) or across tools (paid once per
   * tool: a tool's schema can't refer to another's). The largest repeated block
   * only, not the pieces inside it.
   */
  repeated: Repeated[];
  /**
   * `$defs`/`definitions` entries that nothing in their tool refers to, followed
   * transitively: sent with every conversation, read by no one. Notion's server
   * 2.5.2 ships the same 9 in all 24 tools, 72% of its menu.
   */
  unusedDefs: { tools: number; tokens: number; examples: string[] };
}

export interface Repeated {
  /** The property it sits under (the first place it's found), for a label. */
  param: string;
  tokens: number;
  /** Places it appears, in all. */
  count: number;
  tools: number;
  /** tokens × count. */
  total: number;
  /** The most copies inside one tool, and that tool. */
  within: number;
  withinTool: string;
  /** Tokens a `$defs` entry could save inside the tools that repeat it (estimate). */
  saving: number;
  /** Up to three places, as `tool.path`. */
  where: string[];
}

const TOP = 5;
const BIG_ENUM = 20;
const REPEATED_MIN_TOKENS = 25;
const SCHEMA_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'not', 'items', 'additionalProperties', 'prefixItems', 'then', 'else', 'if', '$defs', 'definitions', 'patternProperties']);
/** Across tools only, a block has to be in this many to count (the same small parameter in two tools is normal). */
const REPEATED_MIN_TOOLS = 3;
/** What a `{"$ref": "#/$defs/Block"}` costs in place of a copy (estimate). */
const REF_TOKENS = countTokens(JSON.stringify({ $ref: '#/$defs/Block' }));

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
  for (const tool of menu.tools) {
    for (const [param, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
      const values = enumValues(schema);
      if (values.length >= BIG_ENUM) enums.push({ tool: tool.name, param, values: values.length, tokens: countTokens(JSON.stringify(values)) });
    }
  }
  enums.sort((a, b) => b.tokens - a.tokens);
  return { total: menu.totalTokens, top, enums: enums.slice(0, 5), repeated: repeatedBlocks(menu), unusedDefs: unusedDefs(menu) };
}

function unusedDefs(menu: Menu): Breakdown['unusedDefs'] {
  let tokens = 0;
  const tools: string[] = [];
  for (const tool of menu.tools) {
    const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
    const pools = (['$defs', 'definitions'] as const).filter((k) => schema[k] && typeof schema[k] === 'object');
    if (!pools.length) continue;
    const { $defs: _d, definitions: _df, ...rest } = schema;
    const used = new Set<string>();
    const queue = [JSON.stringify(rest)];
    while (queue.length) {
      for (const m of queue.pop()!.matchAll(/"\$ref"\s*:\s*"#\/(\$defs|definitions)\/([^"/]+)/g)) {
        const id = `${m[1]}/${decodeURIComponent(m[2]).replace(/~1/g, '/').replace(/~0/g, '~')}`;
        if (used.has(id)) continue;
        used.add(id);
        const [pool, name] = [m[1], id.slice(m[1].length + 1)];
        queue.push(JSON.stringify((schema[pool] as Record<string, unknown>)[name] ?? {}));
      }
    }
    let unused = 0;
    for (const pool of pools) {
      for (const [name, def] of Object.entries(schema[pool] as Record<string, unknown>)) {
        if (!used.has(`${pool}/${name}`)) unused += countTokens(JSON.stringify({ [name]: def }));
      }
    }
    if (unused > 0) {
      tokens += unused;
      tools.push(tool.name);
    }
  }
  return { tools: tools.length, tokens, examples: tools.slice(0, 3) };
}

interface Occurrence {
  tool: string;
  /** Readable: `.options.header`, `.rows[].id`, `.anyOf[1]`. */
  path: string;
  /** Fingerprints of the blocks this one sits inside, outermost first. */
  ancestors: string[];
}

/** Every sub-schema of every tool's inputSchema, fingerprinted, and the ones that repeat. */
function repeatedBlocks(menu: Menu): Repeated[] {
  const places = new Map<string, Occurrence[]>();
  const tokens = new Map<string, number>();
  /** `map`: a name → schema map (properties, $defs), not a schema itself. */
  const visit = (tool: string, node: unknown, path: string, map: boolean, ancestors: string[]): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => visit(tool, x, `${path}[${i}]`, false, ancestors));
      return;
    }
    let inner = ancestors;
    if (path !== '' && !map) {
      const key = canonical(node);
      if (!tokens.has(key)) tokens.set(key, countTokens(JSON.stringify(node)));
      places.set(key, [...(places.get(key) ?? []), { tool, path, ancestors }]);
      inner = [...ancestors, key];
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (map) visit(tool, v, `${path}.${k}`, false, inner);
      else if (k === 'properties') visit(tool, v, path, true, inner);
      else if (k === '$defs' || k === 'definitions' || k === 'patternProperties') visit(tool, v, `${path}.${k}`, true, inner);
      else if (k === 'items' && !Array.isArray(v)) visit(tool, v, `${path}[]`, false, inner);
      else visit(tool, v, `${path}.${k}`, false, inner);
    }
  };
  for (const tool of menu.tools) visit(tool.name, tool.inputSchema, '', false, []);

  const counts = new Map([...places].map(([k, occ]) => [k, occ.length]));
  const out: (Repeated & { waste: number })[] = [];
  for (const [key, occ] of places) {
    const size = tokens.get(key)!;
    if (occ.length < 2 || size < REPEATED_MIN_TOKENS) continue;
    // Inside a bigger block that repeats as often: that one is the finding.
    if (occ.every((o) => o.ancestors.some((a) => (tokens.get(a) ?? 0) >= REPEATED_MIN_TOKENS && (counts.get(a) ?? 0) >= occ.length))) continue;
    const perTool = new Map<string, number>();
    for (const o of occ) perTool.set(o.tool, (perTool.get(o.tool) ?? 0) + 1);
    const [withinTool, within] = [...perTool].sort((a, b) => b[1] - a[1])[0];
    if (within < 2 && perTool.size < REPEATED_MIN_TOOLS) continue;
    const saving = [...perTool.values()].filter((k) => k > 1).reduce((s, k) => s + Math.max(0, (k - 1) * size - k * REF_TOKENS), 0);
    // The nearest property name: `.freshness.anyOf[1]` is freshness.
    const label = occ[0].path.split(/[.[\]]+/).filter((s) => s && !/^\d+$/.test(s) && !SCHEMA_KEYWORDS.has(s)).pop() ?? occ[0].path;
    out.push({
      param: label,
      tokens: size,
      count: occ.length,
      tools: perTool.size,
      total: size * occ.length,
      within,
      withinTool,
      saving,
      where: occ.slice(0, 3).map((o) => `${o.tool}${o.path}`),
      waste: size * (occ.length - 1),
    });
  }
  return out
    .sort((a, b) => b.waste - a.waste)
    .slice(0, 5)
    .map(({ waste: _w, ...r }) => r);
}

function enumValues(schema: JsonSchema): unknown[] {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.items?.enum)) return schema.items!.enum!;
  return [];
}

/** One item of the breakdown, format-neutral: what it is, why it costs, what to do. */
interface Item {
  kind: 'top' | 'unused' | 'enum' | 'repeated' | 'note';
  /** The line itself: the numbers and where. */
  text: string;
  /** Why it matters, when the line alone doesn't say. */
  why?: string;
  /** The next step (SPEC §25), when there is one. */
  fix?: string;
}

const tok = (x: number) => `~${x.toLocaleString('en-US')}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const list = (names: string[], total: number) => `${names.join(', ')}${total > names.length ? ', …' : ''}`;

/** A tool's schema can't refer to another tool's: said once, after the repeated blocks that span tools. */
const ACROSS_TOOLS = "A tool's schema can't $ref another tool's, so a block shared across tools is paid once per tool: only a smaller block saves tokens there.";

function items(b: Breakdown, tools: number): { title: string; items: Item[] } | undefined {
  const u = b.unusedDefs;
  const unused: Item[] = u.tokens
    ? [{
        kind: 'unused',
        text: `unused $defs: ${tok(u.tokens)} tokens${b.total ? ` (${pct(u.tokens / b.total)} of the menu)` : ''} in ${u.tools} tool${u.tools === 1 ? '' : 's'} (${list(u.examples, u.tools)})`,
        why: 'Definitions nothing in their tool refers to: sent with every conversation, read by no one.',
        fix: "Remove the unreferenced $defs entries from each tool's inputSchema.",
      }]
    : [];
  // Two different blocks under the same name ("form") are told apart by where the first one is.
  const label = (r: Repeated) => (b.repeated.filter((x) => x.tools > 1 && x.param === r.param).length > 1 && r.where[0] ? `${r.param} at ${r.where[0]}` : r.param);
  const repeated: Item[] = b.repeated.map((r) => {
    if (r.tools === 1) {
      const places = list(r.where.map((w) => w.slice(r.withinTool.length + 1)), r.count);
      return { kind: 'repeated', text: `repeated: one ${tok(r.tokens)}-token block ×${r.count} in ${r.withinTool} (${places})${r.saving > 0 ? `: a $defs entry could save ${tok(r.saving)}` : ''}`, ...(r.saving > 0 ? { fix: `Move the block into ${r.withinTool}'s $defs once and $ref it.` } : {}) };
    }
    const inside = r.within > 1 ? `, ×${r.within} inside ${r.withinTool}${r.saving > 0 ? `: a $defs entry there could save ${tok(r.saving)}` : ''}` : '';
    return { kind: 'repeated', text: `repeated: ${label(r)} (${tok(r.tokens)} tokens) in ${r.tools} tools, ${tok(r.total)} in all${inside}` };
  });
  // A small menu gets no breakdown, but waste inside one tool is worth a line anyway.
  if (tools < 5) {
    const within = [...unused, ...repeated.filter((_, i) => b.repeated[i].within > 1)];
    return within.length ? { title: 'Where the tokens go (estimate):', items: within } : undefined;
  }
  const topShare = b.top.reduce((s, t) => s + t.share, 0);
  const width = Math.min(40, Math.max(...b.top.map((t) => t.name.length)));
  const top: Item[] = b.top.map((t) => ({ kind: 'top', text: `${pct(t.share).padStart(4)}  ${t.name.padEnd(width)}  ${tok(t.tokens).padStart(7)} tokens (description ${tok(t.description)}, schema ${tok(t.schema)})` }));
  const enums: Item[] = b.enums.map((e) => ({ kind: 'enum', text: `enum: ${e.tool}.${e.param} has ${e.values} values, ${tok(e.tokens)} tokens` }));
  const note: Item[] = b.repeated.some((r) => r.tools > 1) ? [{ kind: 'note', text: ACROSS_TOOLS }] : [];
  return { title: `Where the tokens go (estimate): the top ${b.top.length} tools are ${pct(topShare)} of the menu`, items: [...top, ...unused, ...enums, ...repeated, ...note] };
}

/** The breakdown as report lines, or none for a menu too small to need one. */
export function breakdownLines(b: Breakdown, tools: number): string[] {
  const found = items(b, tools);
  if (!found) return [];
  const lines = [found.title];
  for (const item of found.items) {
    lines.push(item.kind === 'note' ? `  (${item.text})` : `  ${item.text}`);
    if (item.why) lines.push(`      ${item.why}`);
    if (item.fix) lines.push(`      → Next: ${item.fix}`);
  }
  return lines;
}

/** The breakdown for a PR comment: a fold, the biggest tools as a table, the waste as a list. */
export function breakdownMarkdown(b: Breakdown, tools: number): string[] {
  const found = items(b, tools);
  if (!found) return [];
  const cell = (t: string) => t.replace(/\|/g, '\\|');
  const code = (t: string) => t.replace(/\$defs/g, '`$defs`');
  const lines = ['', `<details><summary>${found.title}</summary>`, ''];
  if (tools >= 5) {
    lines.push('| Share | Tool | Tokens | Description | Schema |', '|---:|---|---:|---:|---:|');
    for (const t of b.top) lines.push(`| ${pct(t.share)} | \`${cell(t.name)}\` | ${tok(t.tokens)} | ${tok(t.description)} | ${tok(t.schema)} |`);
    lines.push('');
  }
  for (const item of found.items.filter((i) => i.kind !== 'top' && i.kind !== 'note')) {
    lines.push(`- ${code(item.text)}${item.why ? `. ${code(item.why)}` : ''}${item.fix ? `<br>**→ Next:** ${code(item.fix)}` : ''}`);
  }
  for (const item of found.items.filter((i) => i.kind === 'note')) lines.push('', `_${code(item.text)}_`);
  lines.push('', '</details>');
  return lines;
}
