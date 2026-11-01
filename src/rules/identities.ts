import type { MenuTool } from '../types.js';
import { count, names, num, type Rule, type RuleFinding } from './rule.js';

/*
 * Menus that vary by credentials. 2026-07-28: the tool set "MAY vary by the
 * authorization presented on the request" (server/tools.mdx), and cacheScope
 * "public" lets shared caches serve a list across authorization contexts.
 * snapshot --as lists the menu once per identity (a set of headers or env vars).
 */

/** One identity's menu, as snapshot listed it: the first is the main one, whose menu is saved. */
export interface IdentityMenu {
  name: string;
  tools?: MenuTool[];
  tokens?: number;
  cacheScope?: unknown;
  /** Why it couldn't be listed (bad credentials, a refused connection). */
  error?: string;
}

/** What one identity's menu adds and lacks against the main one, and its token total. */
export interface IdentityDifference {
  name: string;
  adds: string[];
  lacks: string[];
  /** Tools both list whose definitions differ (a description or schema per role). */
  changed: string[];
  tokens: number;
}

export function identityDifferences(identities: IdentityMenu[]): IdentityDifference[] {
  const [main, ...others] = identities;
  if (!main?.tools) return [];
  const mine = new Map(main.tools.map((t) => [t.name, JSON.stringify({ d: t.description, i: t.inputSchema, o: t.outputSchema, a: t.annotations })]));
  return others
    .filter((o) => o.tools)
    .map((o) => {
      const theirs = new Map(o.tools!.map((t) => [t.name, JSON.stringify({ d: t.description, i: t.inputSchema, o: t.outputSchema, a: t.annotations })]));
      return {
        name: o.name,
        adds: [...theirs.keys()].filter((n) => !mine.has(n)),
        lacks: [...mine.keys()].filter((n) => !theirs.has(n)),
        changed: [...theirs].filter(([n, def]) => mine.has(n) && mine.get(n) !== def).map(([n]) => n),
        tokens: o.tokens ?? 0,
      };
    });
}

const differs = (d: IdentityDifference) => d.adds.length + d.lacks.length + d.changed.length > 0;

function describe(d: IdentityDifference, main: IdentityMenu): string {
  const parts = [
    d.adds.length ? `adds ${names(d.adds, 6)}` : '',
    d.lacks.length ? `lacks ${names(d.lacks, 6)}` : '',
    d.changed.length ? `${count(d.changed.length, 'tool')} defined differently (${names(d.changed, 4)})` : '',
  ].filter(Boolean);
  const delta = d.tokens - (main.tokens ?? 0);
  return `${d.name}: ${parts.join('; ')} (${num(d.tokens)} tokens, ${delta >= 0 ? '+' : ''}${num(delta)} against ${main.name})`;
}

export const authVariance: Rule = {
  id: 'menu/auth-variance',
  severity: 'info',
  summary: 'The menu differs between identities (allowed; says what differs)',
  run(ctx) {
    const identities = ctx.identities ?? [];
    if (identities.length < 2) return [];
    const [main] = identities;
    const findings: RuleFinding[] = [];
    const diffs = identityDifferences(identities);
    const varying = diffs.filter(differs);
    if (varying.length) {
      findings.push({
        message: `The menu differs by identity: ${varying.length === diffs.length && diffs.length === 1 ? `${varying[0].name} sees a different tool set than ${main.name}` : `${count(varying.length, 'identity', 'identities')} of ${num(diffs.length)} see a different tool set than ${main.name}`}. Allowed (the tool set may vary by authorization); each sees only its own, so a baseline of ${main.name}'s menu doesn't cover the others.`,
        detail: varying.map((d) => describe(d, main)),
        fix: `Keep a baseline per identity you care about: the first --as is the menu saved, so snapshot --as ${varying[0].name}:… --as ${main.name}:… --out menu.${varying[0].name}.json, and diff each one.`,
      });
    }
    const failed = identities.filter((i) => i.error);
    if (failed.length) {
      findings.push({
        message: failed.length === 1
          ? `${failed[0].name} couldn't be listed, so its menu is not compared (${failed[0].error!.replace(/[.\s]+$/, '')}).`
          : `${names(failed.map((i) => i.name))} couldn't be listed, so their menus are not compared.`,
        ...(failed.length > 1 ? { detail: failed.map((i) => `${i.name}: ${i.error!.replace(/[.\s]+$/, '')}`) } : {}),
        fix: 'Check the credentials given with --as for that identity.',
      });
    }
    return findings;
  },
};

export const cacheScopePublic: Rule = {
  id: 'spec/cache-scope-public',
  severity: 'warn',
  since: '2026-07-28',
  summary: 'A list marked cacheScope "public" that differs by identity',
  run(ctx) {
    const identities = ctx.identities ?? [];
    const varying = identityDifferences(identities).filter(differs);
    if (!varying.length) return [];
    const listed = identities.filter((i) => i.tools);
    const publicOnes = listed.filter((i) => i.cacheScope === 'public').map((i) => i.name);
    if (!publicOnes.length) return [];
    return [
      {
        message: `tools/list says cacheScope: "public"${publicOnes.length < listed.length ? ` (for ${names(publicOnes)})` : ''}, but the tool set differs by identity. Public lets shared caches serve one caller's list to another, across authorization contexts: a client can be shown tools its credentials can't use, or miss ones they can.`,
        detail: varying.map((d) => describe(d, identities[0])),
        fix: 'Set cacheScope: "private" on tools/list when the tools depend on who is asking.',
      },
    ];
  },
};
