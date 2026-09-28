import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { Rule, RuleFinding } from './rule.js';

// ajv-formats ships CommonJS; under NodeNext its default import is the module object.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv | Ajv2020) => void;

const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url));
const validators = new Map<string, ReturnType<Ajv['compile']> | null>();

function listToolsValidator(version: string) {
  if (!validators.has(version)) {
    const file = `${SCHEMA_DIR}${version}.json`;
    if (!existsSync(file)) {
      validators.set(version, null);
    } else {
      const schema = JSON.parse(readFileSync(file, 'utf8'));
      // 2025-11-25 and later are draft 2020-12 with $defs; earlier ones are draft-07 with definitions.
      const modernDraft = String(schema.$schema).includes('2020-12');
      const ajv = modernDraft ? new Ajv2020({ strict: false, allErrors: true }) : new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      ajv.addSchema(schema, 'mcp');
      validators.set(version, ajv.compile({ $ref: `mcp#/${modernDraft ? '$defs' : 'definitions'}/ListToolsResult` }));
    }
  }
  return validators.get(version) ?? null;
}

export const schema: Rule = {
  id: 'spec/schema',
  severity: 'error',
  summary: 'tools/list results match the official schema for their protocol version',
  run(ctx) {
    if (!ctx.protocolVersion) return [];
    const validate = listToolsValidator(ctx.protocolVersion);
    if (!validate) {
      return [{ severity: 'info', message: `No official schema bundled for protocol ${ctx.protocolVersion}; schema check skipped.` }];
    }
    const findings: RuleFinding[] = [];
    if (ctx.clientError && ctx.pages.every((page) => validate(page))) {
      findings.push({ message: `The official MCP SDK client rejected the tools/list result: ${ctx.clientError.split('\n')[0]}` });
    }
    ctx.pages.forEach((page, i) => {
      if (validate(page)) return;
      const errors = validate.errors ?? [];
      findings.push({
        message: `tools/list result${ctx.pages.length > 1 ? ` (page ${i + 1})` : ''} doesn't match the ${ctx.protocolVersion} schema.`,
        detail: (ctx.clientError ? ['The official MCP SDK client rejects this result, so real clients will fail to list tools.'] : []).concat(errors.slice(0, 5).map((e) => `${e.instancePath || '(result)'} ${e.message}${e.params && 'missingProperty' in e.params ? `: ${e.params.missingProperty}` : ''}`)
          .concat(errors.length > 5 ? [`…and ${errors.length - 5} more`] : [])),
      });
    });
    return findings;
  },
};

export const discover: Rule = {
  id: 'spec/discover',
  severity: 'info',
  summary: 'Reports when the server only speaks the 2025-era protocol',
  run(ctx) {
    if (ctx.era !== 'legacy') return [];
    return [
      {
        message: `The server answered with protocol ${ctx.protocolVersion} and no working server/discover, so it isn't on 2026-07-28 yet. Rules for 2026-07-28 were skipped.`,
      },
    ];
  },
};

export const deprecated: Rule = {
  id: 'spec/deprecated',
  severity: 'info',
  since: '2026-07-28',
  summary: 'Deprecated features still advertised',
  run(ctx) {
    if ('logging' in ctx.capabilities) {
      return [{ message: 'Advertises the logging capability, which 2026-07-28 deprecates (SEP-2577). Log to stderr or use OpenTelemetry instead.' }];
    }
    return [];
  },
};

export const cacheHints: Rule = {
  id: 'spec/cache-hints',
  severity: 'info',
  since: '2026-07-28',
  summary: 'Cache metadata recommendations (not correctness errors)',
  run(ctx) {
    const findings: RuleFinding[] = [];
    const meta = ctx.menu.listMeta ?? {};
    if (meta.ttlMs === 0) {
      findings.push({
        message: 'tools/list has ttlMs: 0, so clients treat the list as immediately stale and may re-fetch it every time. Valid per spec (and the default in the official TypeScript SDK v2). If the tool set is stable, a positive ttlMs saves the polling.',
      });
    }
    if (meta.cacheScope === 'public' && ctx.usedAuth) {
      findings.push({
        message: 'tools/list is cacheScope "public" on a server that took credentials. Public means shared caches may serve it across authorization contexts. Fine only if the tool set never depends on the caller.',
      });
    }
    return findings;
  },
};
