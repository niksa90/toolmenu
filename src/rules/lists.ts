import { LIST_INFO, listChanges, type ListKind, type ListRead } from '../lists.js';
import { count, names, type Rule, type RuleFinding } from './rule.js';
import { resultValidator } from './spec.js';

/*
 * snapshot --lists: prompts/list, resources/list and resources/templates/list,
 * checked like tools/list. 2026-07-28 makes them cacheable (ttlMs and cacheScope
 * required, SEP-2549) and they no longer vary per connection.
 */

/** What snapshot read of the other lists, for these rules. */
export interface ListsContext {
  /** Each list read twice on one connection, and once from a second process (stdio) or connection (HTTP). */
  read: { kind: ListKind; first: ListRead; second?: ListRead; probe?: ListRead }[];
  /** Lists asked for that the server declares no capability for. */
  undeclared: ListKind[];
}

const RESULT: Record<ListKind, string> = { prompts: 'ListPromptsResult', resources: 'ListResourcesResult', resourceTemplates: 'ListResourceTemplatesResult' };

export const listVariance: Rule = {
  id: 'lists/variance',
  severity: 'warn',
  summary: 'Prompts and resources lists are the same every time they are listed, and from a fresh process or connection',
  run(ctx) {
    const findings: RuleFinding[] = [];
    for (const r of ctx.lists?.read ?? []) {
      const info = LIST_INFO[r.kind];
      if (r.first.error) continue;
      const again = r.second && !r.second.error ? listChanges(r.kind, r.first.items, r.second.items) : [];
      if (again.length) {
        findings.push({
          message: `${info.method} differs between two calls on one connection: ${count(again.length, 'change')}. A client that caches it (ttlMs) or compares it to decide whether to refresh sees a new list every time.`,
          detail: again.slice(0, 8).concat(again.length > 8 ? [`…and ${again.length - 8} more`] : []),
          fix: `Build ${info.method} the same way every time: a stable order and no per-call values (timestamps, counters).`,
        });
      }
      const fresh = r.probe && !r.probe.error ? listChanges(r.kind, r.first.items, r.probe.items) : [];
      if (fresh.length && !again.length) {
        const where = ctx.transport === 'http' ? 'connection' : 'process';
        findings.push({
          message: `${info.method} from a second ${where} differs from the first: ${count(fresh.length, 'change')}. 2026-07-28 lists no longer vary per connection, so clients and caches treat one ${where}'s list as everyone's.`,
          detail: fresh.slice(0, 8).concat(fresh.length > 8 ? [`…and ${fresh.length - 8} more`] : []),
          fix: `Build ${info.method} from what's the same for every ${where}: no per-start ordering (a set, a hash map), no per-${where} state.`,
        });
      }
    }
    return findings;
  },
};

export const listSchema: Rule = {
  id: 'lists/schema',
  severity: 'error',
  summary: 'Prompts and resources list results match the official schema for their protocol version',
  run(ctx) {
    if (!ctx.protocolVersion) return [];
    const findings: RuleFinding[] = [];
    for (const r of ctx.lists?.read ?? []) {
      const info = LIST_INFO[r.kind];
      if (r.first.error) {
        findings.push({
          severity: 'warn',
          message: `The server declares ${info.capability}, but ${info.method} failed: ${r.first.error}. Clients that load ${info.key === 'resourceTemplates' ? 'resource templates' : info.key} up front get an error instead.`,
          fix: `Answer ${info.method} (an empty list is fine), or stop declaring the ${info.capability} capability.`,
        });
        continue;
      }
      const validate = resultValidator(ctx.protocolVersion, RESULT[r.kind]);
      if (!validate) continue;
      r.first.pages.forEach((page, i) => {
        if (validate(page)) return;
        const errors = validate.errors ?? [];
        const missing = [...new Set(errors.filter((e) => !e.instancePath && e.params && 'missingProperty' in e.params).map((e) => String(e.params.missingProperty)))];
        findings.push({
          message: `The ${info.method} result${r.first.pages.length > 1 ? ` (page ${i + 1})` : ''} doesn't match the official ${ctx.protocolVersion} schema, so a strict client may refuse it.`,
          detail: errors.slice(0, 5).map((e) => `${e.instancePath || '(result)'} ${e.message}${e.params && 'missingProperty' in e.params ? `: ${e.params.missingProperty}` : ''}`).concat(errors.length > 5 ? [`…and ${errors.length - 5} more`] : []),
          fix: missing.length
            ? `Add ${missing.join(', ')} to the ${info.method} result${missing.some((m) => m === 'ttlMs' || m === 'cacheScope') ? ` (${ctx.protocolVersion} requires cache hints on it, SEP-2549)` : ''}.`
            : `Fix ${errors[0]?.instancePath || 'the result'} first (${errors[0]?.message ?? 'see above'}), then rerun.`,
        });
      });
    }
    return findings;
  },
};

export const listsUndeclared: Rule = {
  id: 'lists/undeclared',
  severity: 'info',
  summary: '--lists asked for a list the server declares no capability for',
  run(ctx) {
    const kinds = ctx.lists?.undeclared ?? [];
    if (!kinds.length) return [];
    const caps = [...new Set(kinds.map((k) => LIST_INFO[k].capability))];
    return [
      {
        message: `The server declares no ${names(caps)} capability, so ${names(kinds.map((k) => LIST_INFO[k].method))} ${kinds.length === 1 ? "wasn't" : "weren't"} read. Nothing to check there.`,
        fix: `Nothing to change if the server has no ${names(caps)}; leave ${names(caps)} out of --lists.`,
      },
    ];
  },
};
