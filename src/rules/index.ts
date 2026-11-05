import type { Finding, Severity } from '../types.js';
import { SEVERITY_RANK } from '../types.js';
import { buried, cut, lateInstruction } from './description.js';
import { connectionVariance, hostSpecific, nondeterministic, processVariance } from './determinism.js';
import { authoredIds } from './ids.js';
import { clientName } from './clients.js';
import { invalidCredential } from './auth.js';
import { networkDependent } from './network.js';
import { capabilityDependent } from './capabilities.js';
import { listSchema, listVariance } from './lists.js';
import { handleLifetime } from './handles.js';
import { authVariance, cacheScopePublic } from './identities.js';
import { route, sharedWord, vagueId } from './naming.js';
import { cacheHints, deprecated, discover, duplicateName, extensionId, schema, serverInfo, taskRequired, toolsCapability } from './spec.js';
import { noDryRun, readOnlyMismatch, unannotated } from './write.js';
import { gated } from './gated.js';
import { xMcpHeader } from './headers.js';
import { schemaRef } from './refs.js';
import { findable } from './search.js';
import { appsAppOnlyListed, appsLegacyKey, appsResource, appsVisibility } from './apps.js';
import { agentMenu } from '../apps.js';
import { serverCard } from './card.js';
import type { Rule, RuleContext } from './rule.js';

export type { Rule, RuleContext } from './rule.js';

export const MENU_RULES: Rule[] = [
  nondeterministic,
  duplicateName,
  gated,
  processVariance,
  connectionVariance,
  hostSpecific,
  vagueId,
  sharedWord,
  route,
  clientName,
  findable,
  authoredIds,
  handleLifetime,
  buried,
  cut,
  lateInstruction,
  noDryRun,
  unannotated,
  readOnlyMismatch,
  schema,
  xMcpHeader,
  schemaRef,
  toolsCapability,
  discover,
  deprecated,
  cacheHints,
  authVariance,
  invalidCredential,
  networkDependent,
  capabilityDependent,
  listVariance,
  listSchema,
  cacheScopePublic,
  serverInfo,
  extensionId,
  taskRequired,
  serverCard,
  appsResource,
  appsLegacyKey,
  appsVisibility,
  appsAppOnlyListed,
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
  // The menu as an MCP Apps host shows it to the agent: app-only tools left out.
  const shown = agentMenu(ctx.menu).shown;
  for (const rule of rules) {
    const configured = settings.rules?.[rule.id] ?? (RULE_ALIASES[rule.id] ? settings.rules?.[RULE_ALIASES[rule.id]] : undefined);
    if (configured === 'off') continue;
    if (rule.since && (!ctx.protocolVersion || ctx.protocolVersion < rule.since)) continue;
    for (const f of rule.run({ ...ctx, ...(rule.scope === 'agent' ? { menu: shown } : {}), isIgnored })) {
      if (f.tool && isIgnored(f.tool)) continue;
      findings.push({ rule: rule.id, ...f, severity: configured ?? f.severity ?? rule.severity });
    }
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
