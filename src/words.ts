/** Lowercase words in a tool or parameter name: `listTeamAudits`, `list_team_audits` → list, team, audits. */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function singular(word: string): string {
  // status, analysis, address: not plurals
  if (/(us|ss|is)$/.test(word)) return word;
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && /(ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export const VERBS = new Set([
  'get', 'list', 'search', 'find', 'query', 'lookup', 'look', 'fetch', 'read', 'browse', 'resolve', 'retrieve',
  'create', 'add', 'new', 'insert', 'update', 'edit', 'patch', 'put', 'set', 'upsert', 'modify', 'change',
  'delete', 'remove', 'drop', 'purge', 'destroy', 'clear', 'revoke', 'cancel', 'archive', 'close',
  'send', 'post', 'publish', 'submit', 'write', 'save', 'upload', 'move', 'rename', 'copy', 'duplicate',
  'run', 'start', 'stop', 'execute', 'exec', 'open', 'check', 'count', 'describe', 'validate',
  'preview', 'plan', 'simulate', 'dry', 'unlock', 'enable', 'disable', 'assign', 'invite', 'approve',
  'toggle', 'trigger', 'subscribe', 'unsubscribe', 'notify', 'sync', 'import', 'export', 'download',
  'convert', 'generate', 'compute', 'calculate', 'print', 'echo', 'reset', 'refresh', 'restart',
  'take', 'install', 'uninstall', 'upgrade', 'navigate', 'resize', 'select', 'apply', 'scale', 'merge',
  'push', 'pull', 'inspect', 'analyze', 'emulate', 'handle', 'press', 'click', 'drag', 'fill', 'hover',
  'type', 'wait', 'evaluate', 'forward', 'reconnect', 'scrape', 'crawl', 'map', 'extract', 'upload',
]);

export const LOOKUP_VERBS = new Set(['list', 'search', 'find', 'query', 'lookup', 'look', 'get', 'fetch', 'read', 'browse', 'resolve', 'retrieve']);

/** Lookups that return collections: they hand out IDs even when they take one (get_block_children). */
export const COLLECTION_VERBS = new Set(['list', 'search', 'find', 'query', 'browse']);

export const WRITE_VERBS = new Set([
  'create', 'add', 'insert', 'update', 'edit', 'patch', 'put', 'set', 'upsert', 'modify', 'change',
  'delete', 'remove', 'drop', 'purge', 'destroy', 'clear', 'revoke', 'cancel', 'archive', 'close',
  'send', 'post', 'publish', 'submit', 'write', 'save', 'upload', 'move', 'rename', 'assign', 'invite', 'approve',
]);

/**
 * "a" or "an" for a word, by how it sounds, not its first letter: a user, a UUID,
 * a URL, a one-time code; an order, an update, an hour.
 */
export function article(word: string): 'a' | 'an' {
  const w = word.toLowerCase();
  // u said "you" (user, uuid, url, unique, usage, unit), and "one" said "won".
  if (/^(uu|url|uri|uni(?!n)|u[bcfgklmrstvz][aeiouy]|one\b|one[-_]|once)/.test(w)) return 'a';
  // A silent h: an hour, an honest answer.
  if (/^(hour|honest|honor|honour|heir)/.test(w)) return 'an';
  return /^[aeiou]/.test(w) ? 'an' : 'a';
}

/** Words too generic to tell tools apart. */
const GENERIC = new Set(['tool', 'mcp', 'api', 'data', 'info', 'item', 'object', 'value', 'result', 'detail', 'all', 'by', 'for', 'of', 'to', 'from', 'with', 'and', 'or', 'the', 'a', 'an', 'my']);

/** Words most of a server's tool names share (`firecrawl_`, `API-`, `browser_`): no information. */
export function commonWords(names: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of names) for (const w of new Set(words(name))) counts.set(w, (counts.get(w) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => names.length >= 4 && n >= names.length * 0.6).map(([w]) => w));
}

/**
 * Words a name's leading verb is read after: those most of the menu's names share
 * (commonWords), and a namespace prefix: a word, not a verb, that opens 3 or more
 * names and is followed by a verb in 3 or more of them. kubectl_create leads with
 * "create" although kubectl opens 10 of 23 names, under the 60% that makes it common.
 * percent_change keeps "percent": a prefix of one or two names is not a namespace.
 */
export function prefixWords(names: string[]): Set<string> {
  const out = commonWords(names);
  const opened = new Map<string, number>();
  for (const name of names) {
    const [first, second] = words(name);
    if (first === undefined || VERBS.has(first) || second === undefined || !VERBS.has(second)) continue;
    opened.set(first, (opened.get(first) ?? 0) + 1);
  }
  for (const [w, n] of opened) if (n >= 3) out.add(w);
  return out;
}

/** The tool's verb: the first word that is one, skipping prefixes like `API-`. */
export function verbOf(name: string): string | undefined {
  return words(name).find((w) => VERBS.has(w));
}

/**
 * The verb a name leads with, after any prefix most of the menu's tools share
 * (copilot_studio_clear_read_cache → clear): the verb of what the tool does, not one
 * in its object (score_status_update scores; "update" is what it scores).
 */
export function leadingVerb(name: string, common: Set<string> = new Set()): string | undefined {
  const rest = words(name).filter((w, i, all) => all.slice(0, i + 1).some((x) => !common.has(x)));
  const [first, second] = rest;
  if (first !== undefined && VERBS.has(first)) return first;
  // Object first, then the verb (browserbase_session_create, session_close): only a word
  // that can't be read as a noun, so percent_change still computes a change.
  return first !== undefined && second !== undefined && ONLY_VERBS.has(second) ? second : undefined;
}

/** Verbs that aren't also nouns in tool names: not change, update, set, post, patch, copy or plan. */
const ONLY_VERBS = new Set(['create', 'add', 'insert', 'upsert', 'modify', 'delete', 'remove', 'purge', 'destroy', 'revoke', 'cancel', 'close', 'send', 'publish', 'submit', 'upload', 'rename', 'assign', 'invite', 'approve', 'get', 'list', 'fetch', 'retrieve', 'describe']);

/** The nouns in a tool name, singular: `list_team_audits` → team, audit. */
export function nouns(name: string): string[] {
  return words(name)
    .filter((w) => w.length > 1 && !VERBS.has(w) && !/^\d+$/.test(w))
    .map(singular)
    .filter((w) => !GENERIC.has(w));
}

/** Levenshtein distance: edits that turn one string into the other. */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}
