/*
 * Prompts and resources: the other lists a client loads up front (2026-07-28:
 * cacheable like tools/list, SEP-2549, and no longer varying per connection).
 * snapshot --lists tools,prompts,resources reads them; the rules in
 * rules/lists.ts check them the way the menu rules check tools.
 */
import { quietExclusions, type Connection } from './connect.js';

export const LIST_KINDS = ['prompts', 'resources', 'resourceTemplates'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** The --lists words: `resources` reads both resources/list and resources/templates/list. */
export const LIST_WORDS = ['tools', 'prompts', 'resources'] as const;

/** Each list's JSON-RPC method, result key, the key that names an item, and its words. */
export const LIST_INFO: Record<ListKind, { method: string; key: string; id: string; one: string; capability: 'prompts' | 'resources' }> = {
  prompts: { method: 'prompts/list', key: 'prompts', id: 'name', one: 'prompt', capability: 'prompts' },
  resources: { method: 'resources/list', key: 'resources', id: 'uri', one: 'resource', capability: 'resources' },
  resourceTemplates: { method: 'resources/templates/list', key: 'resourceTemplates', id: 'uriTemplate', one: 'resource template', capability: 'resources' },
};

/** Pages read at most: a resources list can be a whole file tree. */
const MAX_PAGES = 50;

export interface ListRead {
  kind: ListKind;
  items: Record<string, unknown>[];
  /** Raw result pages, as received (spec/schema checks them). */
  pages: Record<string, unknown>[];
  listMeta: { ttlMs?: number; cacheScope?: string };
  /** Stopped at MAX_PAGES. */
  truncated?: boolean;
  /** Why it couldn't be read. */
  error?: string;
}

/** Read one list, page by page, as the server sends it. */
export async function readList(connection: Connection, kind: ListKind, timeoutMs?: number): Promise<ListRead> {
  const info = LIST_INFO[kind];
  const pages: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const mark = connection.wire.responses.length;
      const params = cursor ? { cursor } : undefined;
      const call = () => {
        const c = connection.client as unknown as Record<string, (p: unknown, o: unknown) => Promise<unknown>>;
        const fn = kind === 'prompts' ? 'listPrompts' : kind === 'resources' ? 'listResources' : 'listResourceTemplates';
        return c[fn].call(connection.client, params, { timeout: timeoutMs, cacheMode: 'bypass' });
      };
      let failed: unknown;
      await quietExclusions(call).catch((e) => (failed = e));
      // The page as the server sent it: the SDK may reject a result toolmenu still checks.
      const page = connection.wire.since(mark, info.method).at(-1)?.result as Record<string, unknown> | undefined;
      if (!page) throw failed ?? new Error(`no ${info.method} result`);
      pages.push(page);
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
      if (!cursor) break;
    }
  } catch (error) {
    return { kind, items: [], pages, listMeta: {}, error: (error instanceof Error ? error.message : String(error)).split('\n')[0] };
  }
  const first = pages[0] ?? {};
  return {
    kind,
    items: pages.flatMap((p) => (Array.isArray(p[info.key]) ? (p[info.key] as Record<string, unknown>[]) : [])),
    pages,
    listMeta: {
      ...(typeof first.ttlMs === 'number' ? { ttlMs: first.ttlMs } : {}),
      ...(typeof first.cacheScope === 'string' ? { cacheScope: first.cacheScope } : {}),
    },
    ...(cursor ? { truncated: true } : {}),
  };
}

/** The list kinds the --lists words ask for that the server declares a capability for, and the ones it doesn't. */
export function kindsToRead(words: string[], capabilities: Record<string, unknown>): { read: ListKind[]; undeclared: ListKind[] } {
  const wanted: ListKind[] = [...(words.includes('prompts') ? (['prompts'] as const) : []), ...(words.includes('resources') ? (['resources', 'resourceTemplates'] as const) : [])];
  return {
    read: wanted.filter((k) => capabilities[LIST_INFO[k].capability] !== undefined),
    undeclared: wanted.filter((k) => capabilities[LIST_INFO[k].capability] === undefined),
  };
}

/** Two reads of one list: what changed between them, by item id and in order. */
export function listChanges(kind: ListKind, before: Record<string, unknown>[], after: Record<string, unknown>[]): string[] {
  const id = (x: Record<string, unknown>) => String(x[LIST_INFO[kind].id] ?? JSON.stringify(x));
  const a = new Map(before.map((x) => [id(x), JSON.stringify(x)]));
  const b = new Map(after.map((x) => [id(x), JSON.stringify(x)]));
  const out: string[] = [];
  for (const k of a.keys()) if (!b.has(k)) out.push(`${k}: gone`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`${k}: new`);
  for (const [k, v] of b) if (a.has(k) && a.get(k) !== v) out.push(`${k}: ${sameKeys(a.get(k)!, v) ? 'key order changed' : 'changed'}`);
  if (!out.length && [...a.keys()].join('\n') !== [...b.keys()].join('\n')) out.push('same items, different order');
  return out;
}

function sameKeys(x: string, y: string): boolean {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => p.localeCompare(q)).map(([k, w]) => [k, sort(w)])) : v);
  return JSON.stringify(sort(JSON.parse(x))) === JSON.stringify(sort(JSON.parse(y)));
}
