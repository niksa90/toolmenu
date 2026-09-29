import type { MenuTool } from './types.js';
import { toolDefinition } from './menu.js';

export type ChangeKind =
  | 'added'
  | 'removed'
  | 'moved'
  | 'description'
  | 'inputSchema'
  | 'outputSchema'
  | 'annotations'
  | 'other'
  /** Same content, different bytes: key or property order changed. */
  | 'serialization';

export interface ToolChange {
  kind: ChangeKind;
  tool: string;
  /** Position in the newer menu (in the older one for `removed`). */
  position: number;
}

/** JSON with sorted object keys, so key order never counts as a change. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const FIELDS = ['description', 'inputSchema', 'outputSchema', 'annotations'] as const;

/** Which parts of one tool changed. Empty when the definitions are identical. */
export function toolDiff(before: MenuTool, after: MenuTool): ChangeKind[] {
  const kinds: ChangeKind[] = [];
  for (const field of FIELDS) {
    if (canonical(before[field]) !== canonical(after[field])) kinds.push(field);
  }
  const rest = (t: MenuTool) => {
    const def = toolDefinition(t);
    for (const field of FIELDS) delete def[field];
    return canonical(def);
  };
  if (rest(before) !== rest(after)) kinds.push('other');
  // Clients send the tool as serialized, and prompt caches match bytes: a new key
  // or property order is a change even when the content is the same.
  if (kinds.length === 0 && JSON.stringify(toolDefinition(before)) !== JSON.stringify(toolDefinition(after))) kinds.push('serialization');
  return kinds;
}

/**
 * Each tool's identity in a list: its name, and for a name that repeats, which
 * occurrence it is. The second `search` pairs with the second `search`, so a
 * duplicate (menu/duplicate-name) isn't also read as a reorder.
 */
function identities(tools: MenuTool[]): string[] {
  const seen = new Map<string, number>();
  return tools.map((t) => {
    const n = seen.get(t.name) ?? 0;
    seen.set(t.name, n + 1);
    return n === 0 ? t.name : `${t.name}\u0000${n}`;
  });
}

export function compareMenus(before: MenuTool[], after: MenuTool[]): ToolChange[] {
  const changes: ToolChange[] = [];
  const beforeIds = identities(before);
  const afterIds = identities(after);
  const beforeById = new Map(before.map((t, i) => [beforeIds[i], { tool: t, index: i }]));
  const afterIdSet = new Set(afterIds);

  before.forEach((t, i) => {
    if (!afterIdSet.has(beforeIds[i])) changes.push({ kind: 'removed', tool: t.name, position: i });
  });

  // Tools present in both: the ones outside the longest run that kept its
  // relative order are the ones that moved.
  const common = after
    .map((t, i) => ({ name: t.name, afterIndex: i, beforeIndex: beforeById.get(afterIds[i])?.index }))
    .filter((c): c is { name: string; afterIndex: number; beforeIndex: number } => c.beforeIndex !== undefined);
  const kept = longestIncreasingRun(common.map((c) => c.beforeIndex));
  common.forEach((c, i) => {
    if (!kept.has(i)) changes.push({ kind: 'moved', tool: c.name, position: c.afterIndex });
  });

  after.forEach((t, i) => {
    const old = beforeById.get(afterIds[i]);
    if (!old) {
      changes.push({ kind: 'added', tool: t.name, position: i });
      return;
    }
    for (const kind of toolDiff(old.tool, t)) changes.push({ kind, tool: t.name, position: i });
  });

  return changes;
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasingRun(values: number[]): Set<number> {
  const tailIndex: number[] = [];
  const previous: number[] = new Array(values.length).fill(-1);
  values.forEach((v, i) => {
    let lo = 0;
    let hi = tailIndex.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tailIndex[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tailIndex[lo - 1];
    tailIndex[lo] = i;
  });
  const result = new Set<number>();
  let k = tailIndex.length ? tailIndex[tailIndex.length - 1] : -1;
  while (k !== -1) {
    result.add(k);
    k = previous[k];
  }
  return result;
}

export interface CacheBreak {
  /** First position where the newer menu stops matching the older one. */
  position: number;
  /**
   * Estimated tokens of the newer tool list from that position to the end.
   * A floor, not the cost: most clients send the tool list at the start of the
   * prompt (Claude's Messages API renders tools first), so everything after the
   * list, the system prompt and the whole conversation, is processed again too.
   */
  tokensAffected: number;
}

/**
 * Where the tool list itself stops matching between `before` and `after`.
 * Null when `after` only appends to `before`. That keeps the tool list a valid
 * prefix of itself, not the conversation's cache: see session/append.
 */
export function cacheBreak(before: MenuTool[], after: MenuTool[]): CacheBreak | null {
  let i = 0;
  // Byte-exact, not canonical: a prompt cache compares what was sent.
  while (i < before.length && i < after.length && JSON.stringify(toolDefinition(before[i])) === JSON.stringify(toolDefinition(after[i]))) {
    i++;
  }
  if (i === before.length) return null;
  const tokensAffected = after.slice(i).reduce((sum, t) => sum + t.tokens, 0);
  return { position: i, tokensAffected };
}
