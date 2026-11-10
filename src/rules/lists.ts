import { LIST_INFO, listChanges, type ListKind, type ListRead } from '../lists.js';
import { classifyFailure, SETUP_FAILURES } from '../failures.js';
import type { UnreadReason } from '../resource-read.js';
import { clip, count, names, num, type Rule, type RuleFinding } from './rule.js';
import { resultValidator, sdkIssues } from './spec.js';

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
        const said = r.first.error.replace(/[.\s]+$/, '');
        const failure = classifyFailure(r.first.error, { code: r.first.code });
        if (r.first.code === -32601 || /method not (?:found|supported|implemented)/i.test(r.first.error)) {
          // A server that declares resources but answers one of their methods with Method not found.
          findings.push({
            severity: 'info',
            message: `The server declares ${info.capability} but answers ${info.method} with Method not found (-32601), so a client that asks for ${info.key === 'resourceTemplates' ? 'resource templates' : info.key} gets an error, not an empty list.`,
            fix: `Answer ${info.method} with an empty list if there are none.`,
          });
        } else if (SETUP_FAILURES.has(failure)) {
          // Credentials, this machine, a missing app: a failure of the setup, not of the server.
          findings.push({
            severity: 'info',
            message: `${info.method} couldn't be read here (${said}), so it wasn't checked: a setup problem, not the server's.`,
            fix: `Rerun where ${info.method} can answer (credentials, the app or data it needs) to check it.`,
          });
        } else {
          findings.push({
            severity: 'warn',
            message: `The server declares ${info.capability}, but ${info.method} failed: ${said}. Clients that load ${info.key === 'resourceTemplates' ? 'resource templates' : info.key} up front get an error instead.`,
            fix: `Answer ${info.method} (an empty list is fine), or stop declaring the ${info.capability} capability.`,
          });
        }
        continue;
      }
      if (r.first.truncated) {
        // Not a defect: said so that no one reads the checks as covering the whole list.
        findings.push({
          severity: 'info',
          message: `${info.method} has more than ${r.first.pages.length} pages; toolmenu read the first ${r.first.pages.length} (${r.first.items.length} items), so the checks and the menu file cover those only.`,
          fix: 'Nothing to change for this; a client that loads the whole list up front pays for every page.',
        });
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

/*
 * snapshot --read-resources: resources/read on each listed resource (resource-read.ts).
 * A failure that is the server's is lists/resource-unreadable; a result a client would
 * refuse is lists/resource-read-schema; everything the run didn't or couldn't check is
 * lists/resource-unread, so a clean result is never read as covering more than it did.
 */

/** URIs as detail lines, the first `max` and a count of the rest. */
function listed(lines: string[], max = 8): string[] {
  return lines.slice(0, max).concat(lines.length > max ? [`…and ${num(lines.length - max)} more`] : []);
}

/** A URI in a message: a server's text, on one line and not endless. */
const shown = (uri: string) => clip(uri, 160);

export const resourceUnreadable: Rule = {
  id: 'lists/resource-unreadable',
  severity: 'warn',
  summary: 'Every resource resources/list names can be read with resources/read (snapshot --read-resources)',
  run(ctx) {
    const reads = ctx.resourceReads?.reads ?? [];
    const findings: RuleFinding[] = [];
    const missingCode = ctx.protocolVersion && ctx.protocolVersion >= '2026-07-28' ? '-32602' : '-32002';
    const total = `${num(reads.length)} read`;

    const failed = reads.filter((r) => r.outcome === 'error' && !r.unread);
    if (failed.length) {
      const said = (r: (typeof failed)[number]) => `${clip(r.error || 'no message', 120)}${r.code !== undefined ? ` (${r.code})` : ''}`;
      const one = failed.length === 1;
      findings.push({
        message: one
          ? `resources/list names ${shown(failed[0].uri)}, but resources/read of it failed: ${said(failed[0])}. A client that offers the list gets an error when this one is picked.`
          : `resources/list names ${count(failed.length, 'resource')} that resources/read fails on (of ${total}). A client that offers the list gets an error when one of them is picked.`,
        ...(one ? {} : { detail: listed(failed.map((r) => `${shown(r.uri)}: ${said(r)}`)) }),
        fix: `Make resources/read answer every URI resources/list returns, or leave the ones it can't serve out of the list.`,
      });
    }

    const bodies = reads.filter((r) => r.outcome === 'ok' && r.errorBody && !r.unread);
    if (bodies.length) {
      const one = bodies.length === 1;
      const keys = [...new Set(bodies.flatMap((r) => r.errorBody!))].sort().join(', ');
      findings.push({
        confidence: 'unsure',
        message: `${one ? `resources/read of ${shown(bodies[0].uri)} succeeds, but its content is` : `resources/read succeeds for ${count(bodies.length, 'listed resource')} (of ${total}) whose content is`} only a JSON object saying an error (keys: ${keys}). A client takes that for the resource and hands it to the user or the agent as content. A guess from the shape: toolmenu doesn't read meaning into content.`,
        ...(one ? {} : { detail: listed(bodies.map((r) => shown(r.uri))) }),
        fix: `If the read failed, answer with a JSON-RPC error (${missingCode} for a resource that doesn't exist) so a client can tell; if that object is the resource, turn this rule off for the server.`,
      });
    }

    const empty = reads.filter((r) => r.outcome === 'ok' && r.items === 0);
    if (empty.length) {
      const one = empty.length === 1;
      findings.push({
        severity: 'info',
        message: `${one ? `resources/read of ${shown(empty[0].uri)} returns` : `resources/read returns, for ${count(empty.length, 'listed resource')} (of ${total}),`} an empty contents array. A client can't tell a resource with nothing in it from one that isn't there.`,
        ...(one ? {} : { detail: listed(empty.map((r) => shown(r.uri))) }),
        fix: `Return one item with empty text for an empty resource, and a JSON-RPC error (${missingCode}) for one that doesn't exist.`,
      });
    }
    return findings;
  },
};

export const resourceReadSchema: Rule = {
  id: 'lists/resource-read-schema',
  severity: 'error',
  summary: 'resources/read results match the official schema for the negotiated protocol version (snapshot --read-resources)',
  run(ctx) {
    if (!ctx.protocolVersion || !ctx.resourceReads?.schemaChecked) return [];
    const reads = ctx.resourceReads.reads;
    const findings: RuleFinding[] = [];
    const invalid = reads.filter((r) => r.schemaErrors?.length);
    if (invalid.length) {
      // Positions in a contents array differ per resource; the rule broken doesn't.
      const one = invalid.length === 1;
      const lines = [...new Set(invalid.flatMap((r) => r.schemaErrors!.map((l) => (one ? l : l.replace(/\/contents\/\d+/g, '/contents/N')))))];
      const missing = [...new Set(invalid.flatMap((r) => r.missing ?? []))];
      const hints = missing.some((m) => m === 'ttlMs' || m === 'cacheScope');
      findings.push({
        message: `The resources/read result ${one ? `for ${shown(invalid[0].uri)} doesn't` : `doesn't match for ${count(invalid.length, 'resource')} of ${num(reads.length)} read: they don't`} match the official ${ctx.protocolVersion} schema, so a strict client may refuse ${one ? 'it' : 'them'}.`,
        detail: listed(lines, 5).concat(one ? [] : [`e.g. ${shown(invalid[0].uri)}`]),
        fix: missing.length
          ? `Add ${missing.join(', ')} to the resources/read result${hints ? ` (${ctx.protocolVersion} requires cache hints on it, SEP-2549)` : ''}.`
          : `Fix ${lines[0]?.split(' ')[0] || 'the result'} first (${lines[0]?.split(' ').slice(1).join(' ') || 'see above'}), then rerun.`,
      });
    }
    // The server's result is what the schema asks for, and the official client still refused it.
    const refused = reads.filter((r) => r.outcome === 'ok' && r.clientError && !r.schemaErrors?.length);
    if (refused.length) {
      const said = sdkIssues(refused[0].clientError!);
      const one = refused.length === 1;
      findings.push({
        message: `The official MCP SDK client rejected the resources/read result ${one ? `for ${shown(refused[0].uri)}` : `for ${count(refused.length, 'resource')} of ${num(reads.length)} read`}, so clients built on it can't read ${one ? 'it' : 'them'}. The result does match the ${ctx.protocolVersion} schema; the SDK said: ${said.summary}`,
        ...(said.detail.length || !one ? { detail: said.detail.concat(one ? [] : listed(refused.map((r) => shown(r.uri)))) } : {}),
        fix: 'Fix what the SDK names above, then read the resource with the official client to confirm.',
      });
    }
    return findings;
  },
};

const UNREAD_WORDS: Record<UnreadReason, string> = {
  auth: 'need credentials this run lacks',
  payment: 'need payment',
  network: "need a network this run couldn't reach",
  client: "need a client capability toolmenu doesn't declare",
  environment: 'need something this machine lacks',
  'rate-limit': 'the server refused for too many requests, so toolmenu stopped reading',
  timeout: "didn't answer in time",
  'input-required': 'the server asked for input first (InputRequiredResult)',
  budget: 'the time for the reads ran out',
  bytes: 'enough content had arrived already',
  'max-reads': 'over --max-reads',
  'declared-size': 'the listing declares a size too large to read',
  web: 'http(s) URLs, which a client fetches itself',
  gone: 'gone from the list by its second reading',
};

export const resourceUnread: Rule = {
  id: 'lists/resource-unread',
  severity: 'info',
  summary: 'Says which listed resources snapshot --read-resources did not check, and why',
  run(ctx) {
    const pass = ctx.resourceReads;
    if (!pass) return [];
    const by = new Map<UnreadReason, string[]>();
    const add = (reason: UnreadReason, uris: string[]) => by.set(reason, [...(by.get(reason) ?? []), ...uris]);
    for (const r of pass.reads) if (r.unread) add(r.unread, [r.uri]);
    for (const s of pass.skipped) add(s.reason, s.uris);
    const unread = [...by.values()].reduce((n, u) => n + u.length, 0);
    if (!unread && !pass.truncated) return [];
    const checked = pass.reads.filter((r) => !r.unread).length;
    const detail = [...by].map(([reason, uris]) => `${num(uris.length)}: ${UNREAD_WORDS[reason]} (${names(uris.map(shown), 3)})`);
    if (pass.truncated) detail.push('resources/list was cut at the page limit: resources past it were never listed, so never read');
    const credentials = by.has('auth');
    return [
      {
        message: unread
          ? `resources/read wasn't checked for ${num(unread)} of ${count(pass.listed, 'listed resource')} (${num(checked)} checked), so no finding about them doesn't mean they can be read.`
          : `resources/read was checked for the ${count(pass.listed, 'resource')} toolmenu listed; resources/list has more pages than it read.`,
        detail,
        fix: credentials
          ? 'Rerun with the credentials the resources need (--header, --env) to check them.'
          : by.has('budget') || by.has('max-reads') || by.has('timeout') || by.has('rate-limit')
            ? 'Rerun against a server instance of your own, without --max-reads, to check the rest.'
            : 'Nothing to change on the server for this.',
      },
    ];
  },
};
