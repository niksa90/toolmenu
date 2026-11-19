/*
 * scan, across servers: an agent with several servers loaded searches all their tools at
 * once. A tool its own server ranks in a client's top results can drop out when other
 * servers' tools are in the same search (an AimYear tool behind Jira's worklog tool for
 * "log past time workout"). Ranked the way each client's search ranks (search.ts,
 * ownNamePlaces), over the tools of every server the scan listed.
 */
import { profileOf } from './clients.js';
import type { Routes } from './routes.js';
import { ownNamePlaces } from './rules/search.js';
import { buildIndex, placeIn, placeOf, SEARCH_LIMIT } from './search.js';
import type { ScanRow } from './scan.js';
import { SEVERITY_RANK, type Finding, type MenuTool, type Severity } from './types.js';

export const OUTRANKED = 'search/outranked';

interface Settings {
  rules?: Record<string, Severity | 'off'>;
  ignore?: string[];
}

/** A client toolmenu can rank: it defers tools, and its result count is known. undefined: Claude's search, the default. */
function rankable(client: string | undefined): boolean {
  if (client === undefined) return true;
  const p = profileOf(client);
  return Boolean(p?.defers && p.defers.value !== 'none' && (p.searchLimit || client === 'claude-code'));
}

function glob(g: string): RegExp {
  return new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

/** Adds search/outranked findings to the rows of a scan with two or more listed servers. */
export function crossServerFindings(rows: ScanRow[], clients: string[], routes: Routes | undefined, settings: Settings = {}): void {
  const configured = settings.rules?.[OUTRANKED];
  if (configured === 'off') return;
  const servers = rows.filter((r) => r.menu && r.menu.tools.length);
  if (servers.length < 2) return;
  const ignore = (settings.ignore ?? []).map(glob);
  const ignored = (tool: string) => ignore.some((re) => re.test(tool));
  const pooled: MenuTool[] = servers.flatMap((r) => r.menu!.tools.map((t) => ({ ...t, name: `${r.name}/${t.name}`, serverName: r.name })));
  const owner = new Map(pooled.map((t) => [t.name, t.serverName as string]));
  const others = (ahead: string[], server: string) => ahead.filter((a) => owner.get(a) !== server);
  const targets = clients.filter(rankable).length ? clients.filter(rankable) : [undefined];
  const total = `${pooled.length} tools from ${servers.length} servers`;

  for (const client of targets) {
    const label = client ? profileOf(client)!.label : "a BM25 tool search like Claude's";
    const limit = (client && profileOf(client)?.searchLimit?.value) || SEARCH_LIMIT;
    const fields = client === 'codex' ? 'codex' : 'claude';
    const reads = client ? profileOf(client)?.searchReads?.value : undefined;
    const index = buildIndex(pooled, { fields, descriptionChars: reads });
    const say = (f: Omit<Finding, 'rule'>, row: ScanRow) =>
      row.findings.push({ rule: 'search/outranked', ...f, severity: configured ?? f.severity, ...(client && targets.length > 1 ? { client, message: `For ${label}: ${f.message}` } : {}) });

    // Each tool by its own name: found when its server is alone, missed with the others.
    for (const row of servers) {
      const tools = row.menu!.tools.filter((t) => !ignored(t.name));
      const alone = ownNamePlaces(tools, row.menu!.tools, client, reads);
      const lost: string[] = [];
      for (const p of alone.places) {
        if (p.place === undefined || p.place > limit) continue; // search/findable's, on its own
        const together = placeOf(index, p.query, `${row.name}/${p.tool}`);
        if (together.place !== undefined && together.place <= limit) continue;
        const ahead = others(together.ahead, row.name);
        if (!ahead.length) continue;
        lost.push(`${p.tool} (“${p.query}”): ${p.place} on its own, ${together.place ?? 'not returned'} with the others, behind ${ahead.slice(0, 4).join(', ')}${ahead.length > 4 ? ` and ${ahead.length - 4} more` : ''}`);
      }
      if (lost.length) {
        const one = lost.length === 1;
        say(
          {
            ...(one ? { tool: lost[0].split(' ')[0] } : {}),
            severity: 'info',
            confidence: 'unsure',
            message: `${one ? '1 tool' : `${lost.length} tools`} of ${row.name} ${one ? 'comes' : 'come'} up in the top ${limit} for ${one ? 'its' : 'their'} own name on ${row.name}'s own, and ${one ? 'drops' : 'drop'} out when it's loaded with the other servers in this list (${total}): their tools rank ahead in ${label}. An agent with all of them loaded can be shown the other servers' tools instead.`,
            detail: lost.slice(0, 12).concat(lost.length > 12 ? [`and ${lost.length - 12} more`] : []),
            fix: `Give each of these tools a word the other servers' tools lack, early in its description: the product's name ("${row.name}") or the object it acts on, so a search for it ranks it above theirs.`,
          },
          row,
        );
      }
    }

    // routes.yml, across servers: a route's tool, named "server/tool" or "tool", in the top results.
    for (const [keyword, expectation] of Object.entries(routes ?? {})) {
      const ranked = index.rank(keyword);
      for (const want of expectation.must_match ?? []) {
        const names = want.includes('/') ? [want] : pooled.filter((t) => t.name.endsWith(`/${want}`)).map((t) => t.name);
        for (const name of names) {
          const row = servers.find((r) => r.name === owner.get(name));
          if (!row || ignored(name.slice(name.indexOf('/') + 1))) continue;
          const { place, ahead } = placeIn(ranked, name);
          if (place !== undefined && place <= limit) continue;
          const theirs = others(ahead, row.name);
          if (!theirs.length) continue; // only its own server's tools ahead: search/findable's routes check
          say(
            {
              tool: name.slice(name.indexOf('/') + 1),
              severity: 'warn',
              confidence: 'unsure',
              message: `routes.yml says “${keyword}” should reach ${name}, but with every server in this list loaded (${total}), ${label} ${place === undefined ? "doesn't return it at all" : `puts it at ${place}`}, past the ${limit} a search returns: other servers' tools rank ahead.`,
              detail: [`ahead of it: ${theirs.slice(0, 6).join(', ')}${theirs.length > 6 ? ` and ${theirs.length - 6} more` : ''}`],
              fix: `Put the words of “${keyword}” in ${name.slice(name.indexOf('/') + 1)}'s name or the start of its description, with a word the tools ahead of it lack (the product's name).`,
            },
            row,
          );
        }
      }
    }
  }
  for (const r of servers) r.findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}
