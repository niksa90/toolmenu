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
  | 'other';

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
  return kinds;
}

export function compareMenus(before: MenuTool[], after: MenuTool[]): ToolChange[] {
  const changes: ToolChange[] = [];
  const beforeByName = new Map(before.map((t, i) => [t.name, { tool: t, index: i }]));
  const afterNames = new Set(after.map((t) => t.name));

  before.forEach((t, i) => {
    if (!afterNames.has(t.name)) changes.push({ kind: 'removed', tool: t.name, position: i });
  });

  // Tools present in both: the ones outside the longest run that kept its
  // relative order are the ones that moved.
  const common = after
    .map((t, i) => ({ name: t.name, afterIndex: i, beforeIndex: beforeByName.get(t.name)?.index }))
    .filter((c): c is { name: string; afterIndex: number; beforeIndex: number } => c.beforeIndex !== undefined);
  const kept = longestIncreasingRun(common.map((c) => c.beforeIndex));
  common.forEach((c, i) => {
    if (!kept.has(i)) changes.push({ kind: 'moved', tool: c.name, position: c.afterIndex });
  });

  after.forEach((t, i) => {
    const old = beforeByName.get(t.name);
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
  /** Estimated tokens of the newer menu from that position to the end. */
  tokensAffected: number;
}

/**
 * Where a prompt cache holding `before` would stop matching `after`.
 * Null when `after` only appends to `before` (the cached prefix stays valid).
 */
export function cacheBreak(before: MenuTool[], after: MenuTool[]): CacheBreak | null {
  let i = 0;
  while (i < before.length && i < after.length && canonical(toolDefinition(before[i])) === canonical(toolDefinition(after[i]))) {
    i++;
  }
  if (i === before.length) return null;
  const tokensAffected = after.slice(i).reduce((sum, t) => sum + t.tokens, 0);
  return { position: i, tokensAffected };
}
