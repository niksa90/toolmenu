import type { JsonSchema } from './types.js';

/** A value for a schema, or why there's none. */
export type Synthesized = { ok: true; value: unknown } | { ok: false };

// Fixed dates, not "now": the same menu gives the same calls on every run.
const DATE_TIME = '2026-01-01T00:00:00Z';
const DATE = '2026-01-01';
const SEARCH_WORDS = /^(q|query|search|search_?query|text|keywords?|terms?|prompt|question)$/i;

/**
 * Does a value fit the schema's type, enum and const? Only the checks that catch a
 * default the server itself wouldn't accept (Microsoft Learn: `default: null` on a
 * `type: "string"`); patterns and formats are the server's business.
 */
export function fits(value: unknown, schema: JsonSchema | undefined): boolean {
  if (!schema || typeof schema !== 'object') return true;
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.enum?.length && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return false;
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(branches) && branches.length && !branches.some((b) => fits(value, b))) return false;
  if (schema.type === undefined) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some((t) => {
    switch (t) {
      case 'null':
        return value === null;
      case 'string':
        return typeof value === 'string';
      case 'boolean':
        return typeof value === 'boolean';
      case 'integer':
        return Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'array':
        return Array.isArray(value) && (!schema.items || value.every((v) => fits(v, schema.items)));
      case 'object':
        return !!value && typeof value === 'object' && !Array.isArray(value);
      default:
        return true;
    }
  });
}

/**
 * A value the schema itself vouches for: `const`, a `default` or `examples` value
 * that fits the type, `enum`, then by type and format. Never a guess at an ID or
 * anything with a `pattern`, and never an empty list for a list it has to fill: a
 * tool that needs one is skipped, not called with junk.
 */
export function synthesize(schema: JsonSchema | undefined, name = ''): Synthesized {
  if (!schema || typeof schema !== 'object') return { ok: false };
  if ('const' in schema) return { ok: true, value: schema.const };
  if ('default' in schema && fits(schema.default, schema)) return { ok: true, value: schema.default };
  const example = Array.isArray(schema.examples) ? schema.examples.find((e) => fits(e, schema)) : undefined;
  if (example !== undefined) return { ok: true, value: example };
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
      // A required list is there to be filled: `{"urls": []}` is refused by the
      // server (Exa's web_fetch_exa), or does nothing. No item, no call.
      const item = synthesize(schema.items, name);
      return item.ok ? { ok: true, value: [item.value] } : { ok: false };
    }
    case 'object': {
      const args = synthesizeArgs(schema);
      return args.ok ? { ok: true, value: args.args } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

/**
 * A value the user gave (--value), made to fit the parameter: `5` is the number 5
 * for an integer and the string "5" for a string; JSON that doesn't fit the type
 * falls back to the text as typed.
 */
export function fitValue(given: { raw?: string; value: unknown }, schema: JsonSchema | undefined): unknown {
  if (fits(given.value, schema)) return given.value;
  if (given.raw !== undefined && fits(given.raw, schema)) return given.raw;
  // A single value for a list: --value urls=https://… means ["https://…"].
  if (schema?.type === 'array' && fits([given.value], schema)) return [given.value];
  return given.value;
}

/** Where a tool's argument came from: the user (--value) or the schema. */
export type ArgSource = 'value' | 'schema';

/**
 * Arguments for a tool's required parameters, or the ones it can't fill. `given`:
 * values the user supplied for this tool, by parameter name; they come first, and
 * one for an optional parameter is passed too.
 */
export function synthesizeArgs(
  schema: JsonSchema | undefined,
  given: Record<string, { raw?: string; value: unknown }> = {},
): { ok: true; args: Record<string, unknown>; sources: Record<string, ArgSource> } | { ok: false; missing: string[] } {
  const args: Record<string, unknown> = {};
  const sources: Record<string, ArgSource> = {};
  const missing: string[] = [];
  const required = schema?.required ?? [];
  for (const param of required) {
    if (param in given) {
      args[param] = fitValue(given[param], schema?.properties?.[param]);
      sources[param] = 'value';
      continue;
    }
    const v = synthesize(schema?.properties?.[param], param);
    if (v.ok) {
      args[param] = v.value;
      sources[param] = 'schema';
    } else missing.push(param);
  }
  if (missing.length) return { ok: false, missing };
  for (const [param, g] of Object.entries(given)) {
    if (param in args || !schema?.properties || !(param in schema.properties)) continue;
    args[param] = fitValue(g, schema.properties[param]);
    sources[param] = 'value';
  }
  return { ok: true, args, sources };
}
