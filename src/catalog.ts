import type { Connection } from './connect.js';
import { toolTokens } from './menu.js';
import type { JsonSchema, MenuTool } from './types.js';
import { nouns, singular } from './words.js';

/**
 * Operations a server keeps behind a search tool instead of in its menu (search
 * and execute: Sentry's search_sentry_tools, Atlassian's discover). `diff` can't
 * see them in the menu, so snapshot --catalog asks the search tool a fixed set of
 * queries and keeps what comes back.
 */
export interface Catalog {
  /** The search tool asked. */
  tool: string;
  /** The queries asked, in order: the same ones every run, so runs compare. */
  queries: string[];
  /** Every operation found, by name. Not complete: a search returns its top matches. */
  operations: MenuTool[];
  /** Queries that failed (rate limits, errors): the catalog is partial where they would have looked. */
  failed?: { query: string; error: string }[];
}

export interface CatalogOptions {
  /** The search tool, when detection picks the wrong one. */
  tool?: string;
  /** The queries to ask. Default: derived from the menu. */
  queries?: string[];
  timeoutMs?: number;
  /** Pause between queries, ms (default 300): hosted servers rate-limit searches (Sentry did). */
  pauseMs?: number;
}

const QUERY_PARAM = /^(q|query|search|keywords?|text)$/i;
const SEARCH_NAME = /(search|find|list|discover)[\w-]*(tools?|operations?|actions?|capabilit)|^discover$|(tools?|operations?)[\w-]*(search|discover)/i;

/** The menu's catalog search tool: read-only, one required query, named like one. */
export function findCatalogTool(tools: MenuTool[]): MenuTool | undefined {
  return tools.find((t) => {
    if (t.annotations?.readOnlyHint !== true) return false;
    const required = t.inputSchema?.required ?? [];
    return SEARCH_NAME.test(t.name) && required.length === 1 && QUERY_PARAM.test(required[0]);
  });
}

/**
 * Queries derived from the menu, the same for the same menu: the nouns in its tool
 * names ("issue", "release", "page"), each asked as "list", "get", "create",
 * "update" and "delete".
 */
export function defaultQueries(tools: MenuTool[], max = 25): string[] {
  const counts = new Map<string, number>();
  for (const t of tools) for (const n of new Set(nouns(t.name).map(singular))) counts.set(n, (counts.get(n) ?? 0) + 1);
  const subjects = [...counts].filter(([n]) => n.length > 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  const queries: string[] = [];
  for (const noun of subjects) for (const verb of ['list', 'get', 'create', 'update', 'delete']) queries.push(`${verb} ${noun}`);
  return queries.slice(0, max);
}

/** Ask the search tool every query and collect the operations it returns. */
export async function readCatalog(conn: Connection, tools: MenuTool[], options: CatalogOptions = {}): Promise<Catalog> {
  const tool = options.tool ? tools.find((t) => t.name === options.tool) : findCatalogTool(tools);
  if (!tool) throw new Error(options.tool ? `--catalog: no tool named ${options.tool} in the menu.` : '--catalog: no catalog search tool in the menu (read-only, one required query, named like search_*_tools or discover). Name it with catalog.tool in the config.');
  const queryParam = tool.inputSchema!.required![0];
  const limit = limitArg(tool.inputSchema);
  const queries = options.queries ?? defaultQueries(tools);
  const found = new Map<string, MenuTool>();
  const failed: { query: string; error: string }[] = [];
  const pause = options.pauseMs ?? 300;
  for (const [i, query] of queries.entries()) {
    if (i > 0) await sleep(pause);
    // A rate limit is waited out (2 s, 4 s, 8 s); anything else, or a limit that
    // persists, leaves this query out and the catalog partial, never the snapshot
    // failed: diff treats operations not found as notices.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await conn.client.callTool({ name: tool.name, arguments: { [queryParam]: query, ...limit } }, { timeout: options.timeoutMs ?? 30_000 });
        const text = result.isError ? resultText(result) : '';
        if (result.isError && RATE_LIMIT.test(text) && attempt < 3) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        if (result.isError) failed.push({ query, error: text.slice(0, 200) || 'the tool returned an error' });
        else for (const op of operationsIn(result)) if (!found.has(op.name)) found.set(op.name, op);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        if (RATE_LIMIT.test(message) && attempt < 3) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        failed.push({ query, error: message.slice(0, 200) });
        break;
      }
    }
  }
  const operations = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { tool: tool.name, queries, operations, ...(failed.length ? { failed } : {}) };
}

const RATE_LIMIT = /rate.?limit|too many requests|\b429\b/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultText(result: { content?: unknown }): string {
  return (Array.isArray(result.content) ? result.content : []).map((c) => (c as { text?: string }).text ?? '').join(' ').trim();
}

/** Ask for as many results as the search allows (Sentry: limit up to 20). */
function limitArg(schema: JsonSchema | undefined): Record<string, number> {
  for (const [name, s] of Object.entries(schema?.properties ?? {})) {
    if (!/^(limit|max_?results|top_?k|count)$/i.test(name)) continue;
    const branches = [s, ...((s.anyOf ?? s.oneOf ?? []) as JsonSchema[])];
    const max = branches.map((b) => b.maximum).find((m): m is number => typeof m === 'number');
    if (max) return { [name]: max };
  }
  return {};
}

/**
 * Operation definitions in a search result: objects with a `name` and either a
 * JSON Schema (`inputSchema`, `input_schema`, `parameters`) or a list of
 * `inputs` (Atlassian), found anywhere in structuredContent or in text that
 * parses as JSON.
 */
export function operationsIn(result: { structuredContent?: unknown; content?: unknown }): MenuTool[] {
  const roots: unknown[] = [];
  if (result.structuredContent) roots.push(result.structuredContent);
  for (const part of Array.isArray(result.content) ? result.content : []) {
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    try {
      roots.push(JSON.parse(text));
    } catch {
      // prose, not a catalog
    }
  }
  const out = new Map<string, MenuTool>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const op = asOperation(v as Record<string, unknown>);
    if (op) {
      out.set(op.name, op);
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return [...out.values()];
}

function asOperation(o: Record<string, unknown>): MenuTool | undefined {
  if (typeof o.name !== 'string' || !o.name) return undefined;
  const schema = (o.inputSchema ?? o.input_schema ?? o.parameters) as JsonSchema | undefined;
  let inputSchema: JsonSchema | undefined;
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) inputSchema = schema;
  else if (Array.isArray(o.inputs)) inputSchema = fromInputs(o.inputs as Record<string, unknown>[]);
  else return undefined;
  const def: Record<string, unknown> = { name: o.name, ...(typeof o.description === 'string' ? { description: o.description } : {}), inputSchema };
  if (o.annotations && typeof o.annotations === 'object') def.annotations = o.annotations;
  return { ...(def as Omit<MenuTool, 'tokens'>), tokens: toolTokens(def) } as MenuTool;
}

/** Atlassian's `inputs: [{ name, type, required, description, minimum, … }]` as a JSON Schema. */
function fromInputs(inputs: Record<string, unknown>[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const i of inputs) {
    if (typeof i.name !== 'string') continue;
    // repairHint stays: it's text the agent reads, so a change to it is a change.
    const { name, required: req, integer, ...rest } = i;
    const p: JsonSchema = { ...(rest as JsonSchema) };
    if (integer === true && p.type === 'number') p.type = 'integer';
    properties[name] = p;
    if (req === true) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
