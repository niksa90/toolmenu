import type { Finding, Severity } from '../types.js';
import { SEVERITY_RANK } from '../types.js';
import { buried, cut } from './description.js';
import { connectionVariance, nondeterministic, processVariance } from './determinism.js';
import { authoredIds } from './ids.js';
import { route, sharedWord, vagueId } from './naming.js';
import { cacheHints, deprecated, discover, schema } from './spec.js';
import { noDryRun, unannotated } from './write.js';
import type { Rule, RuleContext } from './rule.js';

export type { Rule, RuleContext } from './rule.js';

export const MENU_RULES: Rule[] = [
  nondeterministic,
  processVariance,
  connectionVariance,
  vagueId,
  sharedWord,
  route,
  authoredIds,
  buried,
  cut,
  noDryRun,
  unannotated,
  schema,
  discover,
  deprecated,
  cacheHints,
];

export interface RuleSettings {
  /** Per-rule severity override, or 'off'. */
  rules?: Record<string, Severity | 'off'>;
  /** Tool names or globs (`*`) whose findings are dropped. */
  ignore?: string[];
}

export function runRules(rules: Rule[], ctx: RuleContext, settings: RuleSettings = {}): Finding[] {
  const ignore = (settings.ignore ?? []).map(globToRegExp);
  const findings: Finding[] = [];
  for (const rule of rules) {
    const configured = settings.rules?.[rule.id];
    if (configured === 'off') continue;
    if (rule.since && (!ctx.protocolVersion || ctx.protocolVersion < rule.since)) continue;
    for (const f of rule.run(ctx)) {
      if (f.tool && ignore.some((re) => re.test(f.tool!))) continue;
      findings.push({ rule: rule.id, ...f, severity: configured ?? f.severity ?? rule.severity });
    }
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
