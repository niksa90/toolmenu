import type { MenuTool } from '../types.js';
import { indexSchema, isNetworkRef } from '../schema-ref.js';
import { count, names, type Rule, type RuleFinding } from './rule.js';

/*
 * $ref in a tool's schemas (2026-07-28, SEP-2106, basic/index.mdx "$ref
 * Resolution"): "Implementations MUST NOT automatically dereference $ref values
 * that resolve to a network URI", "Schemas that fail to validate due to an
 * unresolved external $ref SHOULD be rejected", and "Schemas MUST be valid".
 *
 * What clients do with one they can't resolve (checked against the official SDK
 * client in the tests): an outputSchema fails every call to the tool ("has an
 * invalid outputSchema: can't resolve reference"); an inputSchema still gets the
 * call through, but the schema the model reads is broken, and the SDK's own server
 * refuses to register it.
 */

export type Where = 'inputSchema' | 'outputSchema';

export interface RefFault {
  where: Where;
  /** Where the $ref sits: `filter.region`, `<items>`, `<$defs>.A`. */
  path: string;
  ref: string;
  /** network: an absolute http(s) URI, which clients must not fetch. missing: nothing in the schema it points to. */
  kind: 'network' | 'missing';
}

/** Every $ref in one schema that a client can't resolve from the schema itself. */
export function unresolvedRefs(schema: unknown, where: Where): RefFault[] {
  if (!schema || typeof schema !== 'object') return [];
  const index = indexSchema(schema);
  return index.refs
    .filter((r) => !index.resolve(r.ref, r.base))
    .map((r) => ({
      where,
      path: r.path.length ? r.path.join('.') : 'the schema root',
      ref: r.ref,
      kind: isNetworkRef(r.ref, r.base) ? ('network' as const) : ('missing' as const),
    }));
}

export function refFaults(tool: MenuTool): RefFault[] {
  return [...unresolvedRefs(tool.inputSchema, 'inputSchema'), ...unresolvedRefs(tool.outputSchema, 'outputSchema')];
}

export const schemaRef: Rule = {
  id: 'spec/ref',
  severity: 'error',
  since: '2026-07-28',
  summary: "Every $ref in a tool's schemas resolves inside the schema",
  run(ctx) {
    const findings: RuleFinding[] = [];
    for (const tool of ctx.menu.tools) {
      const faults = refFaults(tool);
      if (!faults.length) continue;
      const output = faults.filter((f) => f.where === 'outputSchema');
      const missingInput = faults.filter((f) => f.where === 'inputSchema' && f.kind === 'missing');
      const detail = faults.map((f) => `${f.where} ${f.path}: $ref "${f.ref}" ${f.kind === 'network' ? 'is a network URI, which clients must not fetch' : 'points to nothing in the schema'}`);
      const refs = names([...new Set(faults.map((f) => `"${f.ref}"`))], 3);
      if (output.length) {
        findings.push({
          tool: tool.name,
          message: `${tool.name}'s outputSchema has ${count(output.length, '$ref')} a client can't resolve (${names([...new Set(output.map((f) => `"${f.ref}"`))], 3)}), so the official SDK client fails every call to it ("has an invalid outputSchema: can't resolve reference"), however well the server answers. Clients must not fetch a network URI, so a $ref has to point inside the schema.`,
          detail,
          fix: `Put what the $ref points to in the outputSchema's own $defs and point the $ref there (#/$defs/…), then call ${tool.name} with an SDK client to confirm.`,
        });
      } else {
        findings.push({
          tool: tool.name,
          severity: missingInput.length ? 'error' : 'warn',
          message: missingInput.length
            ? `${tool.name}'s inputSchema has a $ref that points to nothing in the schema (${refs}), so the schema isn't valid: the spec requires schemas to be, the official SDK's server won't register it, and the model reads a parameter with no definition.`
            : `${tool.name}'s inputSchema points to a network URI (${refs}). Clients must not fetch it and should reject the schema rather than treat the parameter as unconstrained, so a strict client can refuse ${tool.name}, and any other sends the model a parameter with no definition.`,
          detail,
          fix: `Put what the $ref points to in the inputSchema's own $defs and point the $ref there (#/$defs/…).`,
        });
      }
    }
    return findings;
  },
};
