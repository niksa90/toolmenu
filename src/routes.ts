import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { MenuTool } from './types.js';
import { singular, words } from './words.js';

export type Routes = Record<string, { must_match?: string[]; must_not_match?: string[] }>;

export async function loadRoutes(path: string): Promise<Routes> {
  const data = parse(await readFile(path, 'utf8')) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${path}: expected a map of keyword → { must_match, must_not_match }`);
  }
  for (const [keyword, value] of Object.entries(data)) {
    const v = value as Record<string, unknown>;
    for (const key of ['must_match', 'must_not_match']) {
      if (v?.[key] !== undefined && !(Array.isArray(v[key]) && (v[key] as unknown[]).every((x) => typeof x === 'string'))) {
        throw new Error(`${path}: "${keyword}.${key}" must be a list of tool names`);
      }
    }
  }
  return data as Routes;
}

/** Words that don't decide a route: "forms per team" needs form, team. */
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'per', 'by', 'to', 'in', 'on', 'at', 'from', 'with', 'and', 'or', 'my', 'our', 'your', 'every', 'each']);

/** The words of a keyword that have to be there for a tool to match it. */
export function routeWords(keyword: string): string[] {
  const all = words(keyword).map(singular);
  const content = all.filter((w) => !STOP.has(w));
  return content.length > 0 ? content : all;
}

/**
 * How strongly each tool matches a keyword. Deterministic, no LLM, the way a
 * keyword or BM25 tool search sees it (it can't read "not"):
 * - name: 1 per route word in the tool name, plus 2 if the name has them all
 *   (a one-word route in the name scores 3);
 * - description: 1 per mention of the exact phrase (up to 3), or 1 if the name
 *   and description have every word between them but never as the phrase.
 * Singular and plural count as the same word.
 */
export function routeScores(keyword: string, tools: MenuTool[]): Map<string, number> {
  const phrase = words(keyword).map(singular);
  const wanted = routeWords(keyword);
  const scores = new Map<string, number>();
  for (const tool of tools) {
    const nameWords = new Set(words(tool.name).map(singular));
    const hits = wanted.filter((w) => nameWords.has(w)).length;
    const inName = wanted.length > 0 && hits === wanted.length;
    const descWords = words(tool.description ?? '').map(singular);
    let mentions = 0;
    for (let i = 0; i + phrase.length <= descWords.length; i++) {
      if (phrase.every((w, k) => descWords[i + k] === w)) mentions++;
    }
    const everywhere = new Set([...nameWords, ...descWords]);
    const scattered = !inName && wanted.length > 0 && wanted.every((w) => everywhere.has(w)) ? 1 : 0;
    // A name that only half-matches doesn't count unless the words are all there somewhere.
    const name = inName ? hits + 2 : scattered ? hits : 0;
    scores.set(tool.name, name + Math.max(Math.min(mentions, 3), scattered));
  }
  return scores;
}

/** Keyword words a tool has nowhere in its name or description. */
export function missingWords(keyword: string, tool: MenuTool): string[] {
  const have = new Set([...words(tool.name), ...words(tool.description ?? '')].map(singular));
  return routeWords(keyword).filter((w) => !have.has(w));
}

/** The sentence where a tool's description mentions the keyword next to a "not", if it does. */
export function negatedMention(keyword: string, tool: MenuTool): string | undefined {
  const text = tool.description ?? '';
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const ws = words(sentence).map(singular);
    const wanted = routeWords(keyword);
    if (!wanted.every((w) => ws.includes(w))) continue;
    if (/\b(?:not|never|no|isn'?t|aren'?t|doesn'?t|don'?t|without|unlike|rather than|instead of)\b/i.test(sentence)) {
      return sentence.trim().replace(/\s+/g, ' ');
    }
  }
  return undefined;
}
