import type { Finding, Severity } from '../types.js';
import { SEVERITY_RANK } from '../types.js';
import { buried, cut, lateInstruction } from './description.js';
import { connectionVariance, hostSpecific, nondeterministic, processVariance } from './determinism.js';
import { authoredIds } from './ids.js';
import { route, sharedWord, vagueId } from './naming.js';
import { cacheHints, deprecated, discover, duplicateName, schema, serverInfo, toolsCapability } from './spec.js';
import { noDryRun, unannotated } from './write.js';
import type { Rule, RuleContext } from './rule.js';

export type { Rule, RuleContext } from './rule.js';

export const MENU_RULES: Rule[] = [
  nondeterministic,
  duplicateName,
  processVariance,
  connectionVariance,
  hostSpecific,
  vagueId,
  sharedWord,
  route,
  authoredIds,
  buried,
  cut,
  lateInstruction,
  noDryRun,
  unannotated,
  schema,
  toolsCapability,
  discover,
  deprecated,
  cacheHints,
  serverInfo,
];

/**
 * Rules split out of an older one. A setting for the old id still applies to the
 * new one unless the new id is set itself: before 0.13, description/cut held
 * the late-instruction hint too, and `"description/cut": "off"` turned both off.
 */
export const RULE_ALIASES: Record<string, string> = { 'description/late-instruction': 'description/cut' };

export interface RuleSettings {
  /** Per-rule severity override, or 'off'. */
  rules?: Record<string, Severity | 'off'>;
  /** Tool names or globs (`*`) whose findings are dropped. */
  ignore?: string[];
}

export function runRules(rules: Rule[], ctx: RuleContext, settings: RuleSettings = {}): Finding[] {
  const ignore = (settings.ignore ?? []).map(globToRegExp);
  const isIgnored = (tool: string) => ignore.some((re) => re.test(tool));
  const findings: Finding[] = [];
  for (const rule of rules) {
    const configured = settings.rules?.[rule.id] ?? (RULE_ALIASES[rule.id] ? settings.rules?.[RULE_ALIASES[rule.id]] : undefined);
    if (configured === 'off') continue;
    if (rule.since && (!ctx.protocolVersion || ctx.protocolVersion < rule.since)) continue;
    for (const f of rule.run({ ...ctx, isIgnored })) {
      if (f.tool && isIgnored(f.tool)) continue;
      findings.push({ rule: rule.id, ...f, severity: configured ?? f.severity ?? rule.severity });
    }
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
