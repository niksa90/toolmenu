import { canonical } from './compare.js';
import { toolDefinition } from './menu.js';
import type { MenuTool } from './types.js';

export interface Difference {
  /** JSON path of the first value that differs, from the tool (`inputSchema.properties.fields.default`). */
  path: string;
  before: unknown;
  after: unknown;
  /** Same items in a different order: a comma-separated string or an array. */
  reordered: boolean;
}

/** The first leaf where two values differ, depth first, keys in sorted order. Undefined when equal. */
export function firstDifference(a: unknown, b: unknown, path = ''): Difference | undefined {
  if (canonical(a) === canonical(b)) return undefined;
  if (isObject(a) && isObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const found = firstDifference(a[key], b[key], join(path, key));
      if (found) return found;
    }
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && !samePermutation(a, b)) {
    for (let i = 0; i < a.length; i++) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (found) return found;
    }
  }
  return { path, before: a, after: b, reordered: samePermutation(a, b) };
}

/** Different order, same items: arrays, or strings that are comma-separated lists. */
function samePermutation(a: unknown, b: unknown): boolean {
  const items = (v: unknown): string[] | undefined => {
    if (Array.isArray(v)) return v.map((x) => canonical(x));
    if (typeof v === 'string' && v.includes(',')) return v.split(',').map((s) => s.trim());
    return undefined;
  };
  const x = items(a);
  const y = items(b);
  if (!x || !y || x.length !== y.length || x.length < 2) return false;
  return canonical([...x].sort()) === canonical([...y].sort()) && canonical(x) !== canonical(y);
}

/**
 * One line saying what differs in a tool between two menus, for a finding's
 * detail: `jira_get_issue: inputSchema.properties.fields.default: same 11 items,
 * different order ("assignee,…" vs "issuetype,…")`.
 */
export function describeToolDifference(before: MenuTool, after: MenuTool): string {
  const a = toolDefinition(before);
  const b = toolDefinition(after);
  const d = firstDifference(a, b);
  if (!d) {
    return JSON.stringify(a) === JSON.stringify(b)
      ? `${after.name}: identical`
      : `${after.name}: same content, keys in a different order (the bytes differ)`;
  }
  const where = d.path || '(the whole tool)';
  if (d.reordered) {
    const n = Array.isArray(d.before) ? d.before.length : String(d.before).split(',').length;
    return `${after.name}: ${where}: same ${n} items, different order (${show(d.before)} vs ${show(d.after)}). Sort them.`;
  }
  return `${after.name}: ${where}: ${show(d.before)} vs ${show(d.after)}`;
}

function show(value: unknown): string {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function join(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
}
