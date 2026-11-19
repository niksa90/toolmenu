/*
 * scan, across servers: an agent with several servers loaded searches all their tools at
 * once. A tool its own server ranks in a client's top results can drop out when other
 * servers' tools are in the same search (an AimYear tool behind Jira's worklog tool for
 * "log past time workout"). Ranked the way each client's search ranks (search.ts,
 * ownNamePlaces), over the tools of every server the scan listed.
 */
import { profileOf } from '../clients.js';
import type { Routes } from '../routes.js';
import { agentMenu } from '../apps.js';
import { MIN_TOKENS, MIN_TOOLS, ownNamePlaces } from './search.js';
import { buildIndex, placeIn, placeOf, SEARCH_LIMIT } from '../search.js';
import type { ScanRow } from '../scan.js';
import { SEVERITY_RANK, type Finding, type MenuTool, type Severity } from '../types.js';

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
  // What the agent sees: an MCP Apps host keeps app-only tools out of its list (agentMenu).
  const servers = rows
    .filter((r) => r.menu && r.menu.tools.length)
    .map((row) => ({ row, tools: agentMenu(row.menu!).shown.tools }))
    .filter((s) => s.tools.length);
  if (servers.length < 2) return;
  const ignore = (settings.ignore ?? []).map(glob);
  const ignored = (tool: string) => ignore.some((re) => re.test(tool));
  // Each pooled tool keeps its own name and text, so ranking it among other servers' tools
  // searches what its own server's ranking searched; an id tells it apart (server and tool
  // names can both hold "/"). Codex's search adds the server's name (serverName), once.
  const pooled: MenuTool[] = [];
  const where = new Map<string, { server: string; tool: string }>();
  for (const { row, tools } of servers) {
    for (const t of tools) {
      const id = `#${pooled.length}`;
      pooled.push({ ...t, id, serverName: row.name });
      where.set(id, { server: row.name, tool: t.name });
    }
  }
  const shown = (id: string) => `${where.get(id)!.server}/${where.get(id)!.tool}`;
  const others = (ahead: string[], server: string) => ahead.filter((a) => where.get(a)?.server !== server).map(shown);
  // No --client: Claude's search, as search/findable ranks without one, and only for a pool
  // a client would defer (10+ tools and 10K+ tokens, or 30+). Clients given: those toolmenu
  // can rank, or none (OpenAI's search isn't documented, so it isn't guessed at).
  let targets: (string | undefined)[];
  if (clients.length) {
    targets = clients.filter(rankable);
    if (!targets.length) return;
  } else {
    const tokens = pooled.reduce((n, t) => n + (t.tokens ?? 0), 0);
    if (pooled.length < MIN_TOOLS || (tokens < MIN_TOKENS && pooled.length < 30)) return;
    targets = [undefined];
  }
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
    for (const { row, tools: shown } of servers) {
      const alone = ownNamePlaces(shown.filter((t) => !ignored(t.name)), shown, client, reads);
      const lost: { tool: string; line: string }[] = [];
      for (const p of alone.places) {
        if (p.place === undefined || p.place > limit) continue; // search/findable's, on its own
        const id = [...where].find(([, w]) => w.server === row.name && w.tool === p.tool)![0];
        const together = placeOf(index, p.query, id, limit);
        if (together.place !== undefined && together.place <= limit) continue;
        const ahead = others(together.ahead, row.name);
        if (!ahead.length) continue;
        lost.push({ tool: p.tool, line: `${p.tool} (“${p.query}”): ${p.place} on its own, ${together.place ?? 'not returned'} with the others, behind ${ahead.slice(0, 4).join(', ')}${ahead.length > 4 ? ` and ${ahead.length - 4} more` : ''}` });
      }
      if (lost.length) {
        const one = lost.length === 1;
        say(
          {
            ...(one ? { tool: lost[0].tool } : {}),
            severity: 'info',
            confidence: 'unsure',
            message: `${one ? '1 tool' : `${lost.length} tools`} of ${row.name} ${one ? 'comes' : 'come'} up in the top ${limit} for ${one ? 'its' : 'their'} own name on ${row.name}'s own, and ${one ? 'drops' : 'drop'} out when it's loaded with the other servers in this list (${total}): their tools rank ahead in ${label}. An agent with all of them loaded can be shown the other servers' tools instead.`,
            detail: lost.slice(0, 12).map((l) => l.line).concat(lost.length > 12 ? [`and ${lost.length - 12} more`] : []),
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
        // "server/tool" names one tool; a bare name, that tool on every server that has it.
        const ids = [...where].filter(([id, w]) => shown(id) === want || w.tool === want).map(([id]) => id);
        for (const id of ids) {
          const { server, tool } = where.get(id)!;
          const name = shown(id);
          const row = servers.find((s) => s.row.name === server)!.row;
          if (ignored(tool)) continue;
          const { place, ahead: aheadIds } = placeIn(ranked, id, limit);
          const ahead = aheadIds.map(shown);
          if (place !== undefined && place <= limit) continue;
          const theirs = others(aheadIds, server);
          say(
            {
              tool,
              severity: 'warn',
              confidence: 'unsure',
              message: `routes.yml says “${keyword}” should reach ${name}, but with every server in this list loaded (${total}), ${label} ${place === undefined ? "doesn't return it at all" : `puts it at ${place}`}, past the ${limit} a search returns${theirs.length ? ": other servers' tools rank ahead" : `: ${server}'s own tools rank ahead`}.`,
              detail: [`ahead of it: ${ahead.slice(0, 6).join(', ')}${ahead.length > 6 ? ` and ${ahead.length - 6} more` : ''}`],
              fix: `Put the words of “${keyword}” in ${tool}'s name or the start of its description, with a word the tools ahead of it lack (the product's name).`,
            },
            row,
          );
        }
      }
    }
  }
  for (const { row: r } of servers) r.findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}
