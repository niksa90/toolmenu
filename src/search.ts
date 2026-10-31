/*
 * A stand-in for the tool search clients run over deferred tools. Claude's
 * tool_search_tool_bm25 searches "tool names, descriptions, argument names, and
 * argument descriptions" and returns 5 tools unless the model asks for more
 * (platform.claude.com tool search docs). Its tokenizer and BM25 parameters
 * aren't published, so this uses the textbook ones: the ranks are close, not
 * exact, and findings built on them are unsure.
 */
import type { MenuTool } from './types.js';
import { singular, words } from './words.js';

/** How many tools a search returns when the model doesn't set a limit. */
export const SEARCH_LIMIT = 5;

// Words that carry no meaning in a query or a description.
const STOP = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'from', 'with', 'and', 'or', 'is', 'are', 'be',
  'this', 'that', 'it', 'its', 'as', 'use', 'when', 'if', 'you', 'your', 'can', 'will', 'not', 'any', 'all',
]);

const K1 = 1.2;
const B = 0.75;

/** The words a search sees in a tool: its name, description, and every argument's name and description. */
export function searchText(tool: MenuTool): string[] {
  const parts: string[] = [tool.name, tool.description ?? ''];
  const walk = (schema: unknown, depth: number) => {
    if (!schema || typeof schema !== 'object' || depth > 6) return;
    const s = schema as { properties?: Record<string, unknown>; items?: unknown; description?: unknown };
    for (const [name, prop] of Object.entries(s.properties ?? {})) {
      parts.push(name);
      const d = (prop as { description?: unknown } | null)?.description;
      if (typeof d === 'string') parts.push(d);
      walk(prop, depth + 1);
    }
    if (s.items) walk(s.items, depth + 1);
  };
  walk(tool.inputSchema, 0);
  return terms(parts.join(' '));
}

/** Lowercase, singular, without stop words: what a query and a document are compared on. */
export function terms(text: string): string[] {
  return words(text)
    .map(singular)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export interface SearchIndex {
  /** Tools ranked for a query, best first, with their scores. Tools that match no term are left out. */
  rank(query: string): { tool: string; score: number }[];
}

export function buildIndex(tools: MenuTool[]): SearchIndex {
  const docs = tools.map((t) => {
    const tf = new Map<string, number>();
    const text = searchText(t);
    for (const w of text) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { name: t.name, tf, length: text.length };
  });
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => {
    const n = df.get(w) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  return {
    rank(query) {
      const q = [...new Set(terms(query))];
      const out: { tool: string; score: number }[] = [];
      for (const d of docs) {
        let score = 0;
        for (const w of q) {
          const f = d.tf.get(w);
          if (!f) continue;
          score += idf(w) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / (avg || 1))));
        }
        if (score > 0) out.push({ tool: d.name, score });
      }
      // Ties keep the menu's order, as a stable search would.
      return out.sort((a, b) => b.score - a.score);
    },
  };
}

/**
 * Where a tool lands for a query: 1 is first. A tie counts in the tool's favour
 * (only tools that score strictly higher are ahead of it), so a miss is never a
 * coin flip. Undefined when the query matches nothing in the tool.
 */
export function placeOf(index: SearchIndex, query: string, tool: string): { place?: number; ahead: string[] } {
  const ranked = index.rank(query);
  const mine = ranked.find((r) => r.tool === tool);
  if (!mine) return { ahead: ranked.slice(0, SEARCH_LIMIT).map((r) => r.tool) };
  const ahead = ranked.filter((r) => r.score > mine.score + 1e-9).map((r) => r.tool);
  return { place: ahead.length + 1, ahead };
}
