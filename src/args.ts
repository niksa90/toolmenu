import type { JsonSchema } from './types.js';

/** A value for a schema, or why there's none. */
export type Synthesized = { ok: true; value: unknown } | { ok: false };

// Fixed dates, not "now": the same menu gives the same calls on every run.
const DATE_TIME = '2026-01-01T00:00:00Z';
const DATE = '2026-01-01';
const SEARCH_WORDS = /^(q|query|search|search_?query|text|keywords?|terms?|prompt|question)$/i;

/**
 * A value the schema itself vouches for: `const`, `default`, `examples`, `enum`,
 * then by type and format. Never a guess at an ID or anything with a `pattern`:
 * a tool that needs one is skipped, not called with junk.
 */
export function synthesize(schema: JsonSchema | undefined, name = ''): Synthesized {
  if (!schema || typeof schema !== 'object') return { ok: false };
  if ('const' in schema) return { ok: true, value: schema.const };
  if ('default' in schema) return { ok: true, value: schema.default };
  if (Array.isArray(schema.examples) && schema.examples.length) return { ok: true, value: schema.examples[0] };
  if (schema.enum?.length) return { ok: true, value: schema.enum[0] };
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (!type && Array.isArray(branches)) {
    for (const b of branches) {
      const v = synthesize(b, name);
      if (v.ok) return v;
    }
    return { ok: false };
  }
  switch (type) {
    case 'boolean':
      return { ok: true, value: false };
    case 'integer':
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : undefined;
      return { ok: true, value: min ?? 1 };
    }
    case 'string': {
      if (typeof schema.pattern === 'string') return { ok: false };
      const format = typeof schema.format === 'string' ? schema.format : '';
      if (format === 'date-time') return { ok: true, value: DATE_TIME };
      if (format === 'date') return { ok: true, value: DATE };
      if (format === 'uri' || format === 'url') return { ok: true, value: 'https://example.com' };
      if (format === 'email') return { ok: true, value: 'user@example.com' };
      if (SEARCH_WORDS.test(name)) return { ok: true, value: 'test' };
      return { ok: false };
    }
    case 'array': {
      const item = synthesize(schema.items, name);
      if (item.ok) return { ok: true, value: [item.value] };
      return typeof schema.minItems === 'number' && schema.minItems > 0 ? { ok: false } : { ok: true, value: [] };
    }
    case 'object': {
      const args = synthesizeArgs(schema);
      return args.ok ? { ok: true, value: args.args } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

/** Arguments for a tool's required parameters, or the ones it can't fill. */
export function synthesizeArgs(schema: JsonSchema | undefined): { ok: true; args: Record<string, unknown> } | { ok: false; missing: string[] } {
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const param of schema?.required ?? []) {
    const v = synthesize(schema?.properties?.[param], param);
    if (v.ok) args[param] = v.value;
    else missing.push(param);
  }
  return missing.length ? { ok: false, missing } : { ok: true, args };
}
