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
      return [
        {
          severity: 'info',
          message: `This toolmenu has no official schema for protocol ${ctx.protocolVersion}, so the tools/list result wasn't checked against one.`,
          fix: 'Nothing to change on the server; a newer toolmenu may bundle this version\'s schema.',
        },
      ];
    }
    const findings: RuleFinding[] = [];
    if (ctx.clientError && ctx.pages.every((page) => validate(page))) {
      findings.push({
        message: `The official MCP SDK client rejected the tools/list result, so clients built on it list no tools. The result does match the ${ctx.protocolVersion} schema; the SDK said: ${ctx.clientError.split('\n')[0]}`,
        fix: 'Fix what the SDK names above, then list the tools with the official client to confirm.',
      });
    }
    ctx.pages.forEach((page, i) => {
      if (validate(page)) return;
      const errors = validate.errors ?? [];
      const missing = [...new Set(errors.filter((e) => !e.instancePath && e.params && 'missingProperty' in e.params).map((e) => String(e.params.missingProperty)))];
      const first = errors[0];
      findings.push({
        message: `The tools/list result${ctx.pages.length > 1 ? ` (page ${i + 1})` : ''} doesn't match the official ${ctx.protocolVersion} schema${ctx.clientError ? ', and the official MCP SDK client rejects it, so clients built on it list no tools' : ', so a strict client may refuse it'}.`,
        detail: errors.slice(0, 5).map((e) => `${e.instancePath || '(result)'} ${e.message}${e.params && 'missingProperty' in e.params ? `: ${e.params.missingProperty}` : ''}`)
          .concat(errors.length > 5 ? [`…and ${errors.length - 5} more`] : []),
        fix: missing.length
          ? `Add ${missing.join(', ')} to the tools/list result${missing.some((m) => m === 'ttlMs' || m === 'cacheScope') ? ` (${ctx.protocolVersion} requires cache hints on it, SEP-2549)` : ''}.`
          : `Fix ${first?.instancePath || 'the result'} first (${first?.message ?? 'see above'}), then rerun.`,
      });
    });
    return findings;
  },
};

export const toolsCapability: Rule = {
  id: 'spec/tools-capability',
  severity: 'error',
  summary: 'The server declares the tools capability',
  run(ctx) {
    if ('tools' in ctx.capabilities) return [];
    return [
      {
        message: `The server doesn't declare the tools capability, so clients don't ask for its tools: the official MCP SDK client returns an empty list without sending tools/list${ctx.menu.tools.length ? '' : ', and that is the menu toolmenu got'}.`,
        fix: 'Declare "tools": {} in the capabilities the server sends at initialize.',
      },
    ];
  },
};

export const duplicateName: Rule = {
  id: 'menu/duplicate-name',
  severity: 'error',
  summary: 'Every tool in the menu has its own name',
  run(ctx) {
    const positions = new Map<string, number[]>();
    ctx.menu.tools.forEach((t, i) => positions.set(t.name, [...(positions.get(t.name) ?? []), i]));
    return [...positions]
      .filter(([, at]) => at.length > 1)
      .map(([name, at]): RuleFinding => ({
        tool: name,
        message: `${at.length} tools are named ${name} (positions ${at.join(', ')}). A call names the tool, so only one of them can be reached; clients may keep either, or reject the whole list (Claude's API refuses duplicate tool names).`,
        fix: `Give each ${name} its own name, or drop the copy if it's the same tool listed twice.`,
      }));
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
        fix: 'Nothing to do on 2025; when the server moves to 2026-07-28, implement server/discover and rerun for the 2026 checks.',
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
      return [
        {
          message: 'The server advertises the logging capability, which 2026-07-28 deprecates (SEP-2577), so clients may stop asking for its logs.',
          fix: 'Stop advertising logging; log to stderr or through OpenTelemetry instead.',
        },
      ];
    }
    return [];
  },
};

/**
 * serverInfo { name, version } is required in the handshake (both protocol
 * generations). Without them reports say "unknown server", and clients and logs
 * can't tell which server or release answered (Netlify sends neither).
 */
export const serverInfo: Rule = {
  id: 'spec/server-info',
  severity: 'warn',
  summary: 'The handshake names the server and its version',
  run(ctx) {
    if (!ctx.serverInfo) return [];
    const missing = [!ctx.serverInfo.name ? 'name' : '', !ctx.serverInfo.version ? 'version' : ''].filter(Boolean);
    if (!missing.length) return [];
    return [
      {
        message: `The server's handshake has no serverInfo ${missing.join(' or ')}, which the spec requires. Clients, logs and this report can't tell which ${missing.length === 2 ? 'server or release' : missing[0] === 'name' ? 'server' : 'release'} answered${ctx.serverInfo.name ? ` (${ctx.serverInfo.name})` : ''}.`,
        fix: 'Set serverInfo { name, version } where the server is created, the version from its package.',
      },
    ];
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
        message: 'tools/list says ttlMs: 0, so clients treat the list as stale the moment it arrives and may fetch it again before every use. Valid per spec, and the default in the official TypeScript SDK v2.',
        fix: 'If the tool set is stable, set a positive ttlMs on tools/list (3600000 is an hour).',
      });
    }
    if (meta.cacheScope === 'public' && ctx.usedAuth) {
      findings.push({
        message: 'tools/list says cacheScope: "public" on a server that took credentials. Public lets shared caches serve the list to other callers, across authorization contexts. Fine only if the tool set never depends on who is asking.',
        fix: 'If tools depend on the caller\'s account or scopes, set cacheScope: "private" on tools/list.',
      });
    }
    return findings;
  },
};
