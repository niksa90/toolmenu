import { compareMenus } from '../compare.js';
import type { MenuTool } from '../types.js';
import { names, type Rule } from './rule.js';

/**
 * snapshot --offline-check: the menu from one more stdio process whose proxy variables
 * point at a port nothing listens on. A server that builds its menu from what it
 * fetches at start (inite-visibility: 3 tools offline, 10 online) serves another menu
 * on a machine without the network (CI behind a firewall, an air-gapped install), so
 * a baseline made on one doesn't match the other, and neither do prompt caches.
 * One-sided: a server that ignores the proxy variables still reaches the network
 * where the machine has direct access, and then the menus match; that's no pass.
 */
export interface OfflineMenu {
  tools?: MenuTool[];
  /** It didn't start, or didn't list, with the network cut off. */
  error?: string;
  /** Started through npx, uvx, pnpm dlx, bunx: the launcher may need the network itself. */
  launcher?: boolean;
}

export const networkDependent: Rule = {
  id: 'menu/network-dependent',
  severity: 'warn',
  summary: 'The menu is the same with the network cut off',
  run(ctx) {
    const offline = ctx.offline;
    if (!offline) return [];
    if (offline.error) {
      return [
        {
          rule: 'menu/network-dependent',
          severity: 'info',
          message: `The server didn't start or list its tools with the network cut off: ${offline.error.replace(/^The /, 'the ')}. A machine without the network (CI behind a firewall, an air-gapped install) gets no menu from it.${offline.launcher ? ' It starts through a package runner, which may need the network itself to fetch the package: run the installed command to check the server alone.' : ''}`,
          fix: 'If the server needs the network only for some tools, start without it and say so in those tools\' errors; if it needs it to start, say so in its README.',
          confidence: 'unsure',
        },
      ];
    }
    const mine = ctx.menu.tools;
    const theirs = offline.tools ?? [];
    const changes = compareMenus(mine, theirs);
    if (!changes.length) return [];
    const have = new Set(mine.map((t) => t.name));
    const got = new Set(theirs.map((t) => t.name));
    const gone = mine.filter((t) => !got.has(t.name)).map((t) => t.name);
    const added = theirs.filter((t) => !have.has(t.name)).map((t) => t.name);
    const changed = [...new Set(changes.map((c) => c.tool).filter((n): n is string => !!n && have.has(n) && got.has(n)))];
    // A menu that already differs between two processes with the network (menu/process-variance):
    // only tools missing or added offline are this rule's, not order or definitions.
    const varies = (ctx.probes ?? []).some((p) => p.tools && compareMenus(mine, p.tools).length > 0);
    if (varies && !gone.length && !added.length) return [];
    return [
      {
        rule: 'menu/network-dependent',
        severity: 'warn',
        message: `With the network cut off, the server serves a different menu: ${theirs.length === mine.length ? `the same ${mine.length} tools` : `${theirs.length} ${theirs.length === 1 ? 'tool' : 'tools'}, not ${mine.length}`}${gone.length || added.length || changed.length ? ` (${[gone.length ? `${gone.length} missing` : '', added.length ? `${added.length} only offline` : '', changed.length ? `${changed.length} defined differently` : ''].filter(Boolean).join(', ')})` : ', in another order'}. On a machine without the network (CI behind a firewall, an air-gapped install) agents get that menu, a baseline made with the network doesn't match it, and neither do prompt caches.`,
        detail: [
          ...(gone.length ? [`missing offline: ${names(gone, 10)}`] : []),
          ...(added.length ? [`only offline: ${names(added, 10)}`] : []),
          ...(changed.length ? [`defined differently: ${names(changed, 10)}`] : []),
          ...(varies ? ['The menu also differs between two processes with the network (menu/process-variance), so part of this may be that.'] : []),
        ],
        fix: 'Serve the same tool list either way: list every tool at start, and have a tool that needs the network say so in its error when it can\'t reach it.',
      },
    ];
  },
};
