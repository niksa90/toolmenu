import type { MenuTool } from '../types.js';
import { count, names, num, type Rule } from './rule.js';

/** What an HTTP server answered to the same listing with an invalid credential. */
export interface InvalidCredential {
  /** It served a menu anyway. */
  tools?: MenuTool[];
  /** It refused with this HTTP status (401 or 403 is the answer a client can act on). */
  status?: number;
  /** It failed some other way. */
  error?: string;
}

/**
 * A credential that can't be valid, in place of the one this run used. A server that
 * answers it with a menu, not 401, gives a client whose token expired or was revoked
 * no reason to log in again: the agent just has fewer tools (Atlassian Rovo served 4
 * of its tools to any Authorization header, 2026-11-03).
 */
export const invalidCredential: Rule = {
  id: 'auth/invalid-accepted',
  severity: 'warn',
  summary: 'An invalid credential gets an auth error, not a menu',
  run(ctx) {
    const probe = ctx.invalidCredential;
    if (!probe?.tools) return [];
    const mine = ctx.menu.tools.map((t) => t.name);
    const theirs = probe.tools.map((t) => t.name);
    const same = theirs.length === mine.length && theirs.every((n) => mine.includes(n));
    return [
      {
        message: same
          ? `With an invalid credential in place of this run's, the server served the same ${count(theirs.length, 'tool')} instead of refusing (401). Listing doesn't check credentials, so a client learns its token expired or was revoked only when a call fails.`
          : `With an invalid credential in place of this run's, the server served ${count(theirs.length, 'tool')} (of ${num(mine.length)} with it) instead of refusing (401). A client whose token expired or was revoked gets a smaller menu, not an auth error, so it has no reason to ask the user to log in again; the agent just has fewer tools.`,
        detail: same ? [] : [`served to the invalid credential: ${names(theirs, 10)}`],
        fix: "Answer a request whose credential doesn't verify with 401 and a WWW-Authenticate header, even for tools that need no login: a client re-authenticates on 401. If some tools are meant to work without a login, serve them to requests with no credential, not to ones with a bad credential.",
      },
    ];
  },
};
