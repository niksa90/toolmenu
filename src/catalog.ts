import type { Connection } from './connect.js';
import { toolTokens } from './menu.js';
import type { Finding, JsonSchema, MenuTool } from './types.js';
import { classifyFailure, RATE_LIMITED, tooMany, type FailureClass } from './failures.js';
import { nouns, singular } from './words.js';

/**
 * Operations a server keeps out of its menu, where `diff` can't see them:
 *
 * - behind a search tool (search and execute: Sentry's search_sentry_tools,
 *   Atlassian's discover). snapshot --catalog asks it a fixed set of queries and
 *   crawls by the names that come back.
 * - behind command routers: one tool per area that takes a `command` and its
 *   `parameters`, and lists its commands when called with a flag like `learn: true`
 *   (Azure's namespace mode). snapshot --catalog calls each router once, in that
 *   listing mode only, and never with a command.
 *
 * Both keep operations in the same shape, so `diff` compares them the same way.
 */
export interface Catalog {
  /** The search tool asked; for routers, the router (one) or "the command routers" (several). */
  tool: string;
  /** The queries asked, in order: the same ones every run, so runs compare. Empty for routers: see `routers`. */
  queries: string[];
  /** Every operation found, by name. From a search, not complete: a search returns its top matches. */
  operations: MenuTool[];
  /** Queries (or routers, by name) that failed: the catalog is partial where they would have looked. */
  failed?: { query: string; error: string }[];
  /** Routers only: each router called, in menu order, the exact arguments sent, and how many operations it listed. */
  routers?: { tool: string; arguments: Record<string, unknown>; operations: number; duplicates?: { command: string; kept: string[] }[] }[];
  /** Routers only: tools that look like routers but weren't called, and why. */
  skipped?: { tool: string; reason: string }[];
}

export interface CatalogOptions {
  /** The search tool, when detection picks the wrong one. */
  tool?: string;
  /**
   * The command routers to read, by name, when detection misses them: every router
   * to call (detection is then off). Each still needs a listing flag and an optional
   * command, or it isn't called.
   */
  routers?: string[];
  /** The queries to ask. Default: derived from the menu. */
  queries?: string[];
  timeoutMs?: number;
  /** Pause between queries, ms (default 300): hosted servers rate-limit searches (Sentry did). */
  pauseMs?: number;
  /** Follow the catalog's own words: search for each operation found or mentioned (default true). */
  crawl?: boolean;
  /** At most this many queries (default 200). */
  maxQueries?: number;
  /** Stop after this many queries in a row find nothing new (default 20): the catalog is exhausted. */
  stopAfter?: number;
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

/**
 * Read the operations behind the menu: from the search tool (named, or detected),
 * else from the command routers (named, or detected).
 */
export async function readCatalog(conn: Connection, tools: MenuTool[], options: CatalogOptions = {}): Promise<Catalog> {
  if (options.tool && options.routers?.length) {
    throw new Error(`--catalog: the config names both a search tool (catalog.tool: ${options.tool}) and routers (catalog.routers), and a menu file keeps one catalog.\n→ Next: Keep the one the server's operations are behind, and remove the other from toolmenu.config.json.`);
  }
  if (options.routers?.length) return readRouters(conn, namedRouters(tools, options.routers), [], options);
  if (options.tool) {
    const named = tools.find((t) => t.name === options.tool);
    if (!named) throw new Error(`--catalog: the config names ${options.tool} as the search tool (catalog.tool), but the menu has no tool by that name (${tools.length} tools listed).${nearby(options.tool, tools)}\n→ Next: Fix the name in toolmenu.config.json; the menu file from a plain snapshot lists every tool name.`);
    return readSearch(conn, tools, named, options);
  }
  const search = findCatalogTool(tools);
  if (search) return readSearch(conn, tools, search, options);
  const { usable, skipped } = findRouters(tools);
  if (usable.length) return readRouters(conn, usable, skipped, options);
  if (skipped.length) {
    throw new Error(
      `--catalog: ${plural(skipped.length, 'tool')} look${skipped.length === 1 ? 's' : ''} like command routers, but none can list its commands without being given one, so toolmenu called nothing.\n` +
        skipped.map((s) => `  ${s.tool}: ${s.reason}`).join('\n') +
        `\n→ Next: Nothing to read safely here; if a router gains a listing mode that needs no command, name it in catalog.routers.`,
    );
  }
  throw new Error(
    `--catalog: nothing to read in this menu of ${plural(tools.length, 'tool')}: no catalog search tool (read-only, one required query, named like search_*_tools or discover) and no command router (a command parameter plus a listing flag like learn, described as a router).\n` +
      `→ Next: If the operations are behind one of these tools, name it in toolmenu.config.json: "catalog": { "tool": "<search tool>" } or "catalog": { "routers": ["<router>"] }.`,
  );
}

/** Ask the search tool every query and collect the operations it returns. */
async function readSearch(conn: Connection, tools: MenuTool[], tool: MenuTool, options: CatalogOptions): Promise<Catalog> {
  const queryParam = tool.inputSchema?.required?.[0];
  if (!queryParam || !tool.inputSchema?.properties?.[queryParam]) {
    throw new Error(`--catalog: ${tool.name} is named as the search tool, but its schema has no required query parameter, so there is nothing to put a search in.\n→ Next: Name the tool that takes the search query in catalog.tool, or catalog.routers if ${tool.name} is a command router.`);
  }
  const limit = limitArg(tool.inputSchema);
  // Seeds, then the catalog's own words: every operation found or mentioned is
  // searched for by name, which finds it and its neighbours. Breadth first, in the
  // order found, so the same catalog gives the same queries.
  const queue = [...new Set(options.queries ?? [...describedExamples(tool), ...defaultQueries(tools)])];
  const crawl = options.crawl ?? true;
  // Crawl until the catalog stops yielding: a small one ends early, a big one
  // (Atlassian's ~300 operations) goes on, up to the cap.
  const maxQueries = options.maxQueries ?? 200;
  const stopAfter = options.stopAfter ?? 20;
  let dry = 0;
  const asked: string[] = [];
  const queued = new Set(queue);
  const enqueue = (name: string) => {
    const q = phrase(name);
    if (crawl && q && !queued.has(q)) {
      queued.add(q);
      queue.push(q);
    }
  };
  const found = new Map<string, MenuTool>();
  const failed: { query: string; error: string }[] = [];
  const pause = options.pauseMs ?? 300;
  while (queue.length && asked.length < maxQueries && dry < stopAfter) {
    const query = queue.shift()!;
    if (asked.length > 0) await sleep(pause);
    asked.push(query);
    // A rate limit is waited out; anything else, or a limit that persists, leaves
    // this query out and the catalog partial, never the snapshot failed: diff
    // treats operations not found as notices.
    const answer = await callPatiently(conn, tool.name, { [queryParam]: query, ...limit }, options.timeoutMs);
    if ('error' in answer) failed.push({ query, error: answer.error });
    else {
      const before = found.size;
      for (const op of operationsIn(answer.result)) {
        if (found.has(op.name)) continue;
        found.set(op.name, op);
        enqueue(op.name);
      }
      for (const name of mentionedNames(answer.result)) if (!found.has(name)) enqueue(name);
      dry = found.size > before ? 0 : dry + 1;
    }
  }
  const operations = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { tool: tool.name, queries: asked, operations, ...(failed.length ? { failed } : {}) };
}

// ── Command routers ────────────────────────────────────────────────────────────
//
// A router is one tool that fronts many commands: `{ command, parameters }` runs
// one, a boolean flag lists them all (Azure: "This tool is a hierarchical MCP
// command router… Set "learn=true" to discover available sub commands."). The
// heuristic, all four required for detection:
//   1. a string parameter named command (or subcommand, operation);
//   2. an object parameter for its arguments (parameters, params, arguments, args);
//   3. a boolean listing flag (learn, discover, help, list_commands);
//   4. the tool's or the flag's description says so: "router", "sub commands",
//      "child tools".
// catalog.routers names routers detection misses; they need 1 and 3.
//
// Safety: the only call made is the listing call, `{ <flag>: true }` plus a fixed
// "list the commands" phrase in any other required free-text parameter. It never
// carries the command or its arguments, so there is nothing for the router to run.
// That holds whatever the annotations say: a router's annotations describe the
// commands behind it (Azure's carry no hints at all), not its listing mode. A router
// whose command or arguments are required, or that requires anything toolmenu would
// have to guess (an enum, a number), isn't called.

const COMMAND_PARAM = /^(command|sub_?command|operation)$/i;
const ARGS_PARAM = /^(parameters|params|arguments|args)$/i;
const LISTING_FLAG = /^(learn|discover|help|list_?commands)$/i;
const ROUTER_WORDS = /\brouter\b|\bsub[- ]?commands?\b|\bchild (tools|commands)\b/i;
/** What goes in a required free-text parameter (Azure's `intent`): a request to list, nothing to act on. */
export const LISTING_PHRASE = 'List the available commands and their parameters.';

export interface RouterCall {
  tool: MenuTool;
  /** The exact arguments sent: the listing flag and fixed phrases, never a command. */
  arguments: Record<string, unknown>;
}

type Shape = { call: RouterCall } | { reason: string };

function hasType(schema: JsonSchema | undefined, type: string): boolean {
  const t = schema?.type;
  return Array.isArray(t) ? t.includes(type) : t === type;
}

/**
 * How to list a router's commands safely, or why it can't be. `named`: the config
 * named it, so the description's wording isn't needed. Undefined: not a router.
 */
export function routerShape(tool: MenuTool, named = false): Shape | undefined {
  const props = tool.inputSchema?.properties ?? {};
  const keys = Object.keys(props);
  const command = keys.find((k) => COMMAND_PARAM.test(k) && hasType(props[k], 'string'));
  const args = keys.find((k) => ARGS_PARAM.test(k) && hasType(props[k], 'object'));
  const flag = keys.find((k) => LISTING_FLAG.test(k) && hasType(props[k], 'boolean'));
  const words = ROUTER_WORDS.test(`${tool.description ?? ''} ${flag ? String(props[flag].description ?? '') : ''}`);
  if (!named && !(command && args && flag && words)) return undefined;
  if (!flag) return { reason: `it has no boolean listing flag (learn, discover, help or list_commands), so there's no way to ask for its commands without running one` };
  if (!command) return { reason: `it has no command parameter (command, subcommand or operation), so it doesn't look like a router to call in listing mode` };
  const required = tool.inputSchema?.required ?? [];
  const arguments_: Record<string, unknown> = { [flag]: true };
  for (const r of required) {
    if (r === flag) continue;
    // By name, whatever the type: a required `args` string or a second command
    // (`subcommand` beside `command`) is still a command or its arguments.
    if (COMMAND_PARAM.test(r) || ARGS_PARAM.test(r)) return { reason: `its ${r} parameter is required, so even a listing call would have to name ${COMMAND_PARAM.test(r) ? 'a command' : 'arguments for one'}` };
    const p = props[r];
    if (!p || !hasType(p, 'string') || p.enum || p.const !== undefined || p.pattern || p.format) {
      return { reason: `it requires ${r}, which isn't free text, and toolmenu won't guess a value in a call to a tool that runs commands` };
    }
    arguments_[r] = LISTING_PHRASE;
  }
  return { call: { tool, arguments: arguments_ } };
}

/** The routers in a menu (menu order), and those that look like routers but can't be listed safely. */
export function findRouters(tools: MenuTool[]): { usable: RouterCall[]; skipped: { tool: string; reason: string }[] } {
  const usable: RouterCall[] = [];
  const skipped: { tool: string; reason: string }[] = [];
  for (const t of tools) {
    const shape = routerShape(t);
    if (!shape) continue;
    if ('call' in shape) usable.push(shape.call);
    else skipped.push({ tool: t.name, reason: shape.reason });
  }
  return { usable, skipped };
}

function namedRouters(tools: MenuTool[], names: string[]): RouterCall[] {
  return [...new Set(names)].map((name) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`--catalog: the config names ${name} as a command router (catalog.routers), but the menu has no tool by that name (${plural(tools.length, 'tool')} listed).${nearby(name, tools)}\n→ Next: Fix the name in toolmenu.config.json; the menu file from a plain snapshot lists every tool name.`);
    const shape = routerShape(t, true)!;
    if ('reason' in shape) throw new Error(`--catalog: ${name} is named as a command router (catalog.routers), but toolmenu won't call it: ${shape.reason}.\n→ Next: Remove ${name} from catalog.routers; if its operations sit behind a search tool instead, name that in catalog.tool.`);
    return shape.call;
  });
}

/**
 * Call each router once in its listing mode, paced like the search crawl, and keep
 * the operations it lists. A router that fails leaves its operations out, never the
 * snapshot failed.
 */
async function readRouters(conn: Connection, routers: RouterCall[], skipped: { tool: string; reason: string }[], options: CatalogOptions): Promise<Catalog> {
  const pause = options.pauseMs ?? 300;
  const found = new Map<string, MenuTool>();
  const failed: { query: string; error: string }[] = [];
  const called: NonNullable<Catalog['routers']> = [];
  for (const [i, { tool, arguments: args }] of routers.entries()) {
    if (i > 0) await sleep(pause);
    // The listing call. Checked here too, so no change above can make it run a
    // command: routerShape never lets such a call through, so reaching this is a bug.
    const carried = Object.keys(args).find((k) => COMMAND_PARAM.test(k) || ARGS_PARAM.test(k) || (args[k] !== true && args[k] !== LISTING_PHRASE));
    if (carried) throw new Error(`--catalog: stopped before calling ${tool.name}: its listing call would have carried ${carried}, and a listing call only ever carries the flag and the fixed phrase. Nothing was sent. This is a toolmenu bug.\n→ Next: Report it at https://github.com/niksa90/toolmenu/issues with the tool's inputSchema.`);
    const answer = await callPatiently(conn, tool.name, args, options.timeoutMs);
    let ops: MenuTool[] = [];
    if ('error' in answer) failed.push({ query: tool.name, error: answer.error });
    else {
      // Keyed by command first: it's what an agent passes. Every definition is
      // kept, even two under one name.
      ops = operationsIn(answer.result, { nameKeys: ['command', 'name'], embedded: true, keepAll: true });
      if (!ops.length && !listsNothing(answer.result)) failed.push({ query: tool.name, error: `${UNREADABLE} toolmenu could read: ${quote(resultText(answer.result))}` });
    }
    // Every operation is kept as router.command, however many routers there are
    // and whichever answered this run, so its name is the same from run to run
    // and a router that fails doesn't rename another's operations. A command a
    // router lists twice with different definitions is kept twice, the second
    // as router.command#2, and said so.
    const seen = new Map<string, number>();
    const duplicates = new Map<string, string[]>();
    for (const op of ops) {
      let name = `${tool.name}.${op.name}`;
      const n = (seen.get(op.name) ?? 0) + 1;
      seen.set(op.name, n);
      if (n > 1) {
        let k = n;
        while (found.has(`${name}#${k}`)) k++;
        name = `${name}#${k}`;
        duplicates.set(op.name, [...(duplicates.get(op.name) ?? [`${tool.name}.${op.name}`]), name]);
      }
      found.set(name, { ...op, name, tokens: toolTokens({ ...op, name }) });
    }
    called.push({ tool: tool.name, arguments: args, operations: ops.length, ...(duplicates.size ? { duplicates: [...duplicates].map(([command, kept]) => ({ command, kept })) } : {}) });
  }
  const operations = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    tool: routers.length === 1 ? routers[0].tool.name : 'the command routers',
    queries: [],
    operations,
    ...(failed.length ? { failed } : {}),
    routers: called,
    ...(skipped.length ? { skipped } : {}),
  };
}

/** A tool call, sent again after a wait while it's refused for being too many (2, 4, 8 s). */
async function callPatiently(conn: Connection, name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<{ result: { structuredContent?: unknown; content?: unknown } } | { error: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await conn.client.callTool({ name, arguments: args }, { timeout: timeoutMs });
      const text = result.isError ? resultText(result) : '';
      if (result.isError && RATE_LIMITED.test(text) && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      return result.isError ? { error: text.slice(0, 200) || 'the tool returned an error' } : { result };
    } catch (error) {
      if (tooMany(error) && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      return { error: (error instanceof Error ? error.message.split('\n')[0] : String(error)).slice(0, 200) };
    }
  }
}

// ── What the read says ─────────────────────────────────────────────────────────

// How a router's failure reads, by what its words suggest: [one router, several].
type RouterFailure = FailureClass | 'unreadable';
const FAILED_AS: Record<RouterFailure, { what: [string, string]; fix: string }> = {
  auth: {
    what: ['wanted credentials before it would list its commands', 'wanted credentials before they would list their commands'],
    fix: "Rerun with the server's credentials (--env for a stdio server, --header for HTTP); if these routers aren't yours to watch, ignore this.",
  },
  environment: {
    what: ["needs something this machine doesn't have", "need something this machine doesn't have"],
    fix: 'Install what the error names where toolmenu starts the server (the same container or CI image), then rerun.',
  },
  network: {
    what: ["couldn't reach the network", "couldn't reach the network"],
    fix: 'Rerun where the server can reach its upstream services.',
  },
  'not-found': {
    what: ['answered "not found"', 'answered "not found"'],
    fix: 'Check the server is set up for this account or site, then rerun.',
  },
  'invalid-arguments': {
    what: ["rejected the listing call's arguments", "rejected the listing call's arguments"],
    fix: "Read the router's own words above; if it lists its commands another way, name the right tool in catalog.tool or catalog.routers.",
  },
  unreadable: {
    what: ['answered, but not with a command list toolmenu could read', 'answered, but not with a command list toolmenu could read'],
    fix: 'If the router lists its commands in another format, open an issue at https://github.com/niksa90/toolmenu/issues with its answer; toolmenu reads JSON objects with a name or command and an inputSchema.',
  },
  other: {
    what: ['answered the listing call with an error', 'answered the listing call with an error'],
    fix: "Read the server's words above and rerun; each failure leaves out only that router's part of the catalog.",
  },
};

// Credentials in words failures.ts doesn't know: Azure's "ChainedTokenCredential
// failed to retrieve a token from the included credentials".
const CREDENTIALS = /\bcredentials?\b|failed to (retrieve|acquire|get|obtain) (a |an )?(access )?token|\b(sign|log)[ -]?in (is )?required\b|az(ure)? login/i;
const UNREADABLE = 'answered without a command list';

function failureClass(error: string): RouterFailure {
  if (error.startsWith(UNREADABLE)) return 'unreadable';
  const c = classifyFailure(error);
  return c === 'other' && CREDENTIALS.test(error) ? 'auth' : c;
}

/** A server's error on one line, at most 160 characters. */
function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? t.slice(0, 159) + '…' : t;
}

/**
 * Findings about the read itself: what was called (catalog/read), what failed
 * (catalog/failed, one per cause) and what was left alone (catalog/skipped).
 */
export function catalogFindings(catalog: Catalog): Finding[] {
  const out: Finding[] = [];
  const n = catalog.operations.length;
  const failed = catalog.failed ?? [];
  if (!catalog.routers) {
    out.push({
      rule: 'catalog/read',
      severity: 'info',
      tool: catalog.tool,
      message: `Read ${plural(n, 'operation')} behind ${catalog.tool} with ${plural(catalog.queries.length, 'search', 'searches')}, saved in the menu file for diff. A search returns its top matches, so this is what the searches reached, not a guaranteed full list.`,
    });
    if (failed.length) {
      out.push({
        rule: 'catalog/failed',
        severity: 'info',
        tool: catalog.tool,
        message: `${plural(failed.length, 'search', 'searches')} of ${catalog.queries.length} failed, so the catalog is partial where they would have looked.`,
        detail: failed.slice(0, 5).map((f) => `"${f.query}": ${oneLine(f.error)}`).concat(failed.length > 5 ? [`… and ${failed.length - 5} more`] : []),
        fix: tooManyIn(failed) ? 'Rerun later, or raise catalog.pauseMs so the searches stay under the rate limit.' : 'Rerun; if the same searches fail again, the server\'s words above say why.',
      });
    }
    return out;
  }
  const routers = catalog.routers;
  const listing = routers.map((r) => JSON.stringify(r.arguments));
  const oneCall = listing.every((a) => a === listing[0]);
  out.push({
    rule: 'catalog/read',
    severity: 'info',
    ...(routers.length === 1 ? { tool: routers[0].tool } : {}),
    message: `Read ${plural(n, 'operation')} behind ${routers.length === 1 ? `the command router ${routers[0].tool}` : `${routers.length} command routers`}, saved in the menu file for diff. Each router was called once, in its listing mode, and never with a command.`,
    detail: [
      oneCall ? `Called with ${listing[0]}` : `Called with: ${routers.map((r, i) => `${r.tool} ${listing[i]}`).join('; ')}`,
      listedLine(routers),
      ...routers.flatMap((r) => (r.duplicates ?? []).map((d) => `${r.tool} listed ${d.command} ${d.kept.length === 2 ? 'twice' : `${d.kept.length} times`}, with different definitions; kept each, as ${d.kept.join(', ')}`)),
    ],
  });
  const byClass = new Map<RouterFailure, { query: string; error: string }[]>();
  for (const f of failed) {
    const c = failureClass(f.error);
    byClass.set(c, [...(byClass.get(c) ?? []), f]);
  }
  for (const [c, fs] of byClass) {
    const verb = FAILED_AS[c].what[fs.length === 1 ? 0 : 1];
    out.push({
      rule: 'catalog/failed',
      severity: 'info',
      ...(fs.length === 1 ? { tool: fs[0].query } : {}),
      message: `${plural(fs.length, 'router')} ${verb}: ${fs.map((f) => f.query).join(', ')}. ${fs.length === 1 ? 'Its' : 'Their'} operations aren't in the catalog, so diff can't see them.`,
      detail: fs.map((f) => `${f.query}: ${oneLine(f.error)}`),
      fix: FAILED_AS[c].fix,
      // The cause is read from the server's words, which can mislead.
      ...(c === 'other' || c === 'unreadable' ? {} : { confidence: 'unsure' as const }),
    });
  }
  if (catalog.skipped?.length) {
    out.push({
      rule: 'catalog/skipped',
      severity: 'info',
      message: `${plural(catalog.skipped.length, 'tool')} look${catalog.skipped.length === 1 ? 's' : ''} like command routers but weren't called, because listing ${catalog.skipped.length === 1 ? 'its' : 'their'} commands safely isn't possible: ${catalog.skipped.map((s) => s.tool).join(', ')}.`,
      detail: catalog.skipped.map((s) => `${s.tool}: ${s.reason}`),
      fix: 'If their operations matter, ask the server for a listing mode that needs no command (toolmenu never sends one), then name them in catalog.routers.',
      confidence: 'unsure',
    });
  }
  return out;
}

/** Which routers listed the most, and how many listed anything. */
function listedLine(routers: NonNullable<Catalog['routers']>): string {
  const some = routers.filter((r) => r.operations > 0);
  if (!some.length) return 'Listed: nothing';
  const top = [...some].sort((a, b) => b.operations - a.operations || a.tool.localeCompare(b.tool)).slice(0, 8);
  const rest = some.length - top.length;
  return `Listed: ${top.map((r) => `${r.tool} ${r.operations}`).join(', ')}${rest ? `, and ${rest} more ${rest === 1 ? 'router' : 'routers'} (each router's count is in the menu file)` : ''}`;
}

function tooManyIn(failed: { error: string }[]): boolean {
  return failed.some((f) => RATE_LIMITED.test(f.error));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The first 120 characters of a text, quoted. */
function quote(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? `“${t.length > 120 ? `${t.slice(0, 119)}…` : t}”` : '(an empty answer)';
}

/** " Did you mean x?" when a tool's name is one letter case or separator away. */
function nearby(name: string, tools: MenuTool[]): string {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = tools.find((t) => key(t.name) === key(name));
  return hit ? ` Did you mean ${hit.name}?` : '';
}

/** An operation name as a search phrase: listJiraIssueWorklogs → "list jira issue worklogs". */
function phrase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join(' ');
}

/**
 * Example queries the search tool's own schema suggests: Atlassian's discover
 * documents its query with "transition a jira issue", "list confluence spaces"…
 */
function describedExamples(tool: MenuTool): string[] {
  const text = [tool.description ?? '', ...Object.values(tool.inputSchema?.properties ?? {}).map((p) => String(p.description ?? ''))].join(' ');
  return [...text.matchAll(/["“]([a-z][a-z0-9 ,'-]{5,60})["”]/g)].map((m) => m[1]).filter((q) => q.includes(' '));
}


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
export function operationsIn(result: { structuredContent?: unknown; content?: unknown }, options: { nameKeys?: string[]; embedded?: boolean; keepAll?: boolean } = {}): MenuTool[] {
  const nameKeys = options.nameKeys ?? ['name'];
  const roots = jsonRoots(result, options.embedded);
  // keepAll: two definitions under one name are both kept (the same one twice, once).
  const out = new Map<string, MenuTool>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const op = asOperation(v as Record<string, unknown>, nameKeys);
    if (op) {
      out.set(options.keepAll ? JSON.stringify(op) : op.name, op);
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return [...out.values()];
}

/** The JSON in a result: its structuredContent, and each text part's. */
function jsonRoots(result: { structuredContent?: unknown; content?: unknown }, embedded = false): unknown[] {
  const roots: unknown[] = [];
  if (result.structuredContent) roots.push(result.structuredContent);
  for (const part of Array.isArray(result.content) ? result.content : []) {
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    const value = embedded ? embeddedJson(text) : leadingJson(text);
    if (value !== undefined) roots.push(value);
  }
  return roots;
}

/** A router's answer that is a readable, empty command list: `[]`, or `{ "commands": [] }`. */
export function listsNothing(result: { structuredContent?: unknown; content?: unknown }): boolean {
  const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
  return jsonRoots(result, true).some((r) => empty(r) || (!!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length > 0 && Object.values(r).every(empty)));
}

/**
 * The JSON value a text starts with, ignoring what follows: Atlassian's discover
 * returns its results as JSON and then a prose list of related operations, which
 * makes the whole text invalid JSON.
 */
export function leadingJson(text: string): unknown {
  const trimmed = text.trimStart();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const at = /position (\d+)/.exec(error instanceof Error ? error.message : '');
    if (!at) return undefined;
    try {
      return JSON.parse(trimmed.slice(0, Number(at[1])));
    } catch {
      return undefined;
    }
  }
}

/**
 * The first JSON value in a text that opens with prose: Azure's routers answer
 * "Here are the available commands… \n[{"command":…}]". The text itself when it
 * starts with JSON; else each line that starts with [ or {, in order.
 */
export function embeddedJson(text: string): unknown {
  const leading = leadingJson(text);
  if (leading !== undefined) return leading;
  let tries = 0;
  for (const m of text.matchAll(/\n[ \t]*(?=[[{])/g)) {
    if (++tries > 50) break;
    const value = leadingJson(text.slice(m.index + m[0].length));
    if (value !== undefined && typeof value === 'object') return value;
  }
  return undefined;
}

/**
 * Operation names a result mentions without defining them: lines like
 * "createJiraBoard — Create a new company-managed…" after Atlassian's JSON. Each
 * is worth a search of its own.
 */
export function mentionedNames(result: { content?: unknown }): string[] {
  const names = new Set<string>();
  for (const part of Array.isArray(result.content) ? result.content : []) {
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(/^[ \t]*[-*]?[ \t]*`?([A-Za-z][A-Za-z0-9_.-]{2,80})`?[ \t]+(?:—|–|-{1,2}|:)[ \t]/gm)) names.add(m[1]);
  }
  return [...names];
}

function asOperation(o: Record<string, unknown>, nameKeys: string[] = ['name']): MenuTool | undefined {
  const name = nameKeys.map((k) => o[k]).find((v): v is string => typeof v === 'string' && v.length > 0);
  if (!name) return undefined;
  const schema = (o.inputSchema ?? o.input_schema ?? o.parameters) as JsonSchema | undefined;
  let inputSchema: JsonSchema | undefined;
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) inputSchema = schema;
  else if (Array.isArray(o.inputs)) inputSchema = fromInputs(o.inputs as Record<string, unknown>[]);
  else return undefined;
  const def: Record<string, unknown> = { name, ...(typeof o.description === 'string' ? { description: o.description } : {}), inputSchema };
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
