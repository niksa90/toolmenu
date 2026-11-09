/*
 * session/output-schema: a tool that declares an outputSchema promises its results.
 * 2025-06-18 and later: "If an output schema is provided, servers MUST provide
 * structured results that conform to this schema", and clients SHOULD validate
 * them; the official TypeScript SDK client does, and throws on a result that has no
 * structuredContent or one that doesn't match. Checked on every call that answered
 * (not isError), so it needs a session that calls the tool.
 */
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { JsonSchema } from '../types.js';

const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv | Ajv2020) => void;

/** The protocol version output schemas came in. */
export const OUTPUT_SCHEMA_SINCE = '2025-06-18';

type Validate = ((data: unknown) => boolean) & { errors?: { instancePath: string; keyword?: string; message?: string }[] | null };
const validators = new WeakMap<object, Validate>();

/**
 * What's wrong with a successful result against the tool's outputSchema, or
 * undefined when it conforms (or the schema can't be compiled: then it's the
 * schema that's broken, which spec/schema reports, not the result).
 */
export function outputProblem(schema: JsonSchema, result: { structuredContent?: unknown }): string | undefined {
  return outputCheck(schema, result)?.problem;
}

/**
 * The same, and whether only `format` checks failed (a URI, a date): many validators
 * skip format unless told to, so such a result may well pass a client.
 */
export function outputCheck(schema: JsonSchema, result: { structuredContent?: unknown }): { problem: string; formatOnly: boolean } | undefined {
  if (result.structuredContent === undefined) return { problem: 'returned no structuredContent, although the tool declares an outputSchema', formatOnly: false };
  let validate = validators.get(schema);
  if (!validate) {
    const draft2020 = typeof schema.$schema !== 'string' || schema.$schema.includes('2020-12');
    const ajv = draft2020 ? new Ajv2020({ strict: false, allErrors: true }) : new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    try {
      validate = ajv.compile(schema as object) as unknown as Validate;
    } catch {
      return undefined;
    }
    validators.set(schema, validate);
  }
  if (validate(result.structuredContent)) return undefined;
  const all = validate.errors ?? [];
  const errors = all.slice(0, 3).map((e) => `${e.instancePath || '(the result)'} ${e.message ?? 'is invalid'}`);
  return { problem: `returned structuredContent that doesn't match its outputSchema: ${errors.join('; ')}`, formatOnly: all.length > 0 && all.every((e) => e.keyword === 'format') };
}
