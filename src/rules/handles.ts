import type { JsonSchema, MenuTool } from '../types.js';
import { singular, words } from '../words.js';
import { kept, names, type Rule, type RuleFinding } from './rule.js';

/*
 * Server-minted handles (2026-07-28, SEP-2567). With protocol sessions gone, a
 * server that keeps state across calls hands out a handle as an ordinary tool
 * result (`basket_id`) and takes it back as an argument. The spec asks for the
 * handle's retention "in the creation tool's description" ("baskets expire after
 * 24 hours of inactivity"), so a model knows when to make a new one.
 */

/**
 * Kinds that are server state for a while, never a lasting record: a session, a
 * basket or cart, a checkout, a lease or lock, or something called a handle.
 * Not drafts, runs, jobs or tasks: in real menus those are as often records that
 * stay (an email draft, a CI run, a planner task).
 */
const HANDLE_KINDS = new Set(['session', 'basket', 'cart', 'checkout', 'handle', 'lease', 'lock']);
const CREATE = new Set(['create', 'start', 'open', 'new', 'begin', 'init', 'initialize', 'acquire']);
/** How a handle parameter ends: session_id, sessionHandle, cart_token, or the kind alone. */
const HANDLE_SUFFIX = new Set(['id', 'ids', 'uuid', 'handle', 'token', 'key', 'ref']);

/**
 * Words that say how long a handle lasts, or that it lasts: "expires", "TTL",
 * "valid for 24 hours", "after 30 minutes of inactivity", "kept until closed",
 * "never expires".
 */
const LIFETIME =
  /\bexpir(?:e|es|ed|y|ing|ation)\b|\bttl\b|\btime[- ]to[- ]live\b|\bvalid (?:for|until)\b|\blasts?\b|\binactiv|\bidle\b|\btime(?:s|d)? ?out\b|\bretain|\bretention\b|\bkept (?:for|until)\b|\b(?:deleted|discarded|cleared|purged|removed) (?:after|when|on)\b|\bpersist|\bindefinite|\bnever expire|\buntil (?:it is |you )?(?:closed?|ended?|deleted?|released?)\b|\b\d+\s*(?:s|sec|seconds?|m|min|minutes?|h|hrs?|hours?|d|days?)\b/i;

/** The handle kind a tool creates, from its name: start_session → session, create-shopping-cart → cart. */
function createdKind(tool: MenuTool): string | undefined {
  const w = words(tool.name).map(singular);
  if (!w.length || !CREATE.has(w[0])) return undefined;
  return w.slice(1).find((x) => HANDLE_KINDS.has(x));
}

/** A call made with a handle that can't exist (session --auto): the parameter, and the kind of handle. */
export interface HandleProbe {
  param: string;
  kind: string;
  /**
   * --create-handles: a creating tool runs first, and this call gets the handle it
   * returned instead of a made-up one (the made-up one when it returned none).
   */
  fromCreated?: string;
}

/** Kinds --create-handles may create: scratch state that expires. Not a lock, lease or checkout. */
export const CREATABLE_KINDS = new Set(['session', 'basket', 'cart']);

/** The tool that creates handles of this kind, if the menu has one. */
export function creatorOf(tools: MenuTool[], kind: string): MenuTool | undefined {
  return tools.find((t) => createdKind(t) === kind);
}

/**
 * The handle a creating tool's result carries: a `<kind>_id` / `<kind>Id` / `id` in its
 * structured content, in JSON text, or written out ("session_id: s-1").
 */
export function handleFromResult(result: { structuredContent?: unknown; content?: unknown }, kind: string): string | undefined {
  // Compared without case, dashes or underscores: session_id, sessionId and session-id are one key.
  const norm = (k: string) => k.toLowerCase().replace(/[-_\s]/g, '');
  const keys = new Set([`${kind}id`, kind, `${kind}handle`, `${kind}token`, 'id', 'handle']);
  const find = (v: unknown, depth = 0): string | undefined => {
    if (!v || typeof v !== 'object' || depth > 3) return undefined;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!keys.has(norm(k))) continue;
      if (typeof x === 'string' && x) return x;
      if (typeof x === 'number') return String(x);
    }
    for (const x of Object.values(v as Record<string, unknown>)) {
      const r = find(x, depth + 1);
      if (r) return r;
    }
    return undefined;
  };
  const structured = find(result.structuredContent);
  if (structured) return structured;
  const texts = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]).filter((c) => c.type === 'text' && c.text).map((c) => c.text!) : [];
  for (const t of texts) {
    try {
      const r = find(JSON.parse(t));
      if (r) return r;
    } catch {
      // not JSON: look for "session_id: s-1" written out
    }
    const m = new RegExp(`\\b${kind}[_ -]?(?:id|handle|token)\\b["']?\\s*[:=]\\s*["']?([\\w.:-]+)`, 'i').exec(t);
    if (m) return m[1];
  }
  return undefined;
}

/** The handle kinds some tool in the menu creates. */
export function createdKinds(tools: MenuTool[]): Set<string> {
  return new Set(tools.map(createdKind).filter((k): k is string => !!k));
}

/** Parameters of a tool that take a handle of this kind: session_id, cartToken, `session`. */
export function handleParams(tool: MenuTool, kind: string): string[] {
  return Object.keys(tool.inputSchema?.properties ?? {}).filter((p) => {
    const w = words(p).map(singular);
    if (w.length === 1) return w[0] === kind;
    return w.at(-2) === kind && HANDLE_SUFFIX.has(w.at(-1)!);
  });
}

/** Text a creation tool gives about what it returns: its description, and its output schema's descriptions. */
function ownText(tool: MenuTool): string {
  const out: string[] = [tool.description ?? ''];
  const walk = (s: JsonSchema | undefined, depth: number) => {
    if (!s || depth > 4) return;
    if (typeof s.description === 'string') out.push(s.description);
    for (const child of Object.values(s.properties ?? {})) walk(child, depth + 1);
  };
  walk(tool.outputSchema, 0);
  return out.join('\n');
}

export const handleLifetime: Rule = {
  id: 'ids/handle-lifetime',
  severity: 'info',
  since: '2026-07-28',
  summary: "A tool that creates a handle should say how long it lasts",
  run(ctx) {
    const findings: RuleFinding[] = [];
    for (const tool of kept(ctx.menu.tools, ctx)) {
      const kind = createdKind(tool);
      if (!kind) continue;
      // A handle is passed back: some other tool takes it. Otherwise it's not a handle the model keeps.
      const users = ctx.menu.tools.filter((t) => t.name !== tool.name && handleParams(t, kind).length);
      if (!users.length) continue;
      if (LIFETIME.test(ownText(tool))) continue;
      const takers = users.map((t) => `${t.name}.${handleParams(t, kind)[0]}`);
      findings.push({
        tool: tool.name,
        confidence: 'unsure',
        message: `${tool.name} creates a ${kind} that ${takers.length === 1 ? takers[0] : `${takers.length} tools`} take${takers.length === 1 ? 's' : ''} back, but its description doesn't say how long the ${kind} lasts. 2026-07-28 asks for a handle's retention in the creation tool's description, so a model can tell an expired ${kind} from a wrong one and knows when to make a new one.`,
        ...(takers.length > 1 ? { detail: [`Taken by ${names(takers, 8)}.`] } : {}),
        fix: `Say in ${tool.name}'s description how long a ${kind} lasts ("${kind}s expire after 30 minutes of inactivity", or "a ${kind} lasts until it is closed"), and return a tool error that says so for an expired or unknown one.`,
      });
    }
    return findings;
  },
};
