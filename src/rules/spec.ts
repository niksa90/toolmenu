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

/** A validator for one result type ($defs name) of a protocol version, or null when this toolmenu has no schema for it. */
export function resultValidator(version: string, result = 'ListToolsResult') {
  const key = `${version}\0${result}`;
  if (!validators.has(key)) {
    const file = `${SCHEMA_DIR}${version}.json`;
    if (!existsSync(file)) {
      validators.set(key, null);
    } else {
      const schema = JSON.parse(readFileSync(file, 'utf8'));
      // 2025-11-25 and later are draft 2020-12 with $defs; earlier ones are draft-07 with definitions.
      const modernDraft = String(schema.$schema).includes('2020-12');
      const pool = modernDraft ? schema.$defs : schema.definitions;
      if (!pool?.[result]) {
        validators.set(key, null);
      } else {
        const ajv = modernDraft ? new Ajv2020({ strict: false, allErrors: true }) : new Ajv({ strict: false, allErrors: true });
        addFormats(ajv);
        ajv.addSchema(schema, 'mcp');
        validators.set(key, ajv.compile({ $ref: `mcp#/${modernDraft ? '$defs' : 'definitions'}/${result}` }));
      }
    }
  }
  return validators.get(key) ?? null;
}

const listToolsValidator = (version: string) => resultValidator(version, 'ListToolsResult');

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
    // A later process got 2026-07-28: this one's server/discover probe went unanswered in
    // time, and the SDK falls back to 2025 then (stdio). The server does speak 2026-07-28.
    if (ctx.laterModern) {
      return [
        {
          message: `This connection fell back to protocol ${ctx.protocolVersion}: its server/discover probe got no usable answer (on stdio the official SDK falls back to the 2025 handshake after a timeout too). A later process got 2026-07-28, so the server speaks it, but this run was checked as a 2025 server.`,
          fix: 'Rerun with a longer --timeout (the server may start slowly, or this machine was busy), or --protocol modern to require 2026-07-28.',
        },
      ];
    }
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
    const { name, version } = ctx.serverInfo;
    // undefined: not sent; '': sent empty (a string, so it passes the schema).
    const gaps = [
      name === undefined ? 'no name' : name === '' ? 'an empty name' : '',
      version === undefined ? 'no version' : version === '' ? 'an empty version' : '',
    ].filter(Boolean);
    if (!gaps.length) return [];
    const who = !name && !version ? 'server or release' : !name ? 'server' : 'release';
    // 2026-07-28 moved serverInfo to each result's _meta, where it is a SHOULD ("Servers
    // SHOULD include this field on every response"); the 2025 handshake requires it.
    const modern = ctx.era === 'modern';
    const absent = name === undefined && version === undefined;
    const named = name ? ` (${name})` : '';
    const cant = `Clients, logs and this report can't tell which ${who} answered.`;
    const message = modern
      ? absent
        ? `The server sends no serverInfo, which 2026-07-28 says servers SHOULD include on every response (io.modelcontextprotocol/serverInfo). ${cant}`
        : `The server's serverInfo has ${gaps.join(' and ')}${named}. ${gaps.every((g) => g.startsWith('an empty')) ? 'Valid, since it is a string, but' : 'The schema requires both when serverInfo is sent, and'} ${cant[0].toLowerCase()}${cant.slice(1)}`
      : `The server's handshake has ${gaps.join(' and ')}${named}, which ${absent ? "the 2025 handshake requires (initialize's serverInfo)" : 'the 2025 handshake requires to be filled'}. ${cant}`;
    return [
      {
        ...(modern ? { severity: 'info' as const } : {}),
        message,
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
    // With --as identities, spec/cache-scope-public answers this with evidence instead.
    if (meta.cacheScope === 'public' && ctx.usedAuth && (ctx.identities?.length ?? 0) < 2) {
      findings.push({
        message: 'tools/list says cacheScope: "public" on a server that took credentials. Public lets shared caches serve the list to other callers, across authorization contexts. Fine only if the tool set never depends on who is asking.',
        fix: 'If tools depend on the caller\'s account or scopes, set cacheScope: "private" on tools/list.',
      });
    }
    return findings;
  },
};

// _meta key rules, which extension identifiers follow "with a mandatory prefix"
// (2026-07-28 ServerCapabilities.extensions; MetaObject): labels that start with a
// letter and end with a letter or digit, dots between, then a slash and a name that
// starts and ends alphanumeric.
const LABEL = '[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const EXTENSION_ID = new RegExp(`^${LABEL}(?:\\.${LABEL})*/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`);

/**
 * The extensions a server declares: each key an identifier in _meta key form with a
 * vendor prefix (io.modelcontextprotocol/ui), each value a settings object ({} for none).
 * A client looks an extension up by its exact identifier, so one spelled otherwise reads
 * as not declared.
 */
export const extensionId: Rule = {
  id: 'spec/extension-id',
  severity: 'warn',
  summary: 'Declared extensions are identified as the spec says: vendor-prefix/name, with a settings object',
  run(ctx) {
    const e = ctx.capabilities.extensions;
    if (e === undefined) return [];
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      return [
        {
          message: `capabilities.extensions is ${Array.isArray(e) ? 'a list' : JSON.stringify(e)}, not an object of extension identifiers, so clients find none of the extensions it means to declare.`,
          fix: 'Declare extensions as an object: { "io.modelcontextprotocol/ui": {} }, one key per extension, {} when it has no settings.',
        },
      ];
    }
    const bad: string[] = [];
    for (const [id, settings] of Object.entries(e as Record<string, unknown>)) {
      if (!EXTENSION_ID.test(id)) bad.push(`"${id}": ${id.includes('/') ? 'not in vendor-prefix/name form (labels start with a letter; the name starts and ends alphanumeric)' : 'no vendor prefix (the spec makes one mandatory: io.modelcontextprotocol/ui, com.example/feature)'}`);
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) bad.push(`"${id}": its settings are ${JSON.stringify(settings)}, not an object ({} for none)`);
    }
    if (!bad.length) return [];
    return [
      {
        message: `${bad.length === 1 ? 'An extension the server declares is' : `${bad.length} extensions the server declares are`} not identified as the spec says, so a client that looks ${bad.length === 1 ? 'it' : 'them'} up by identifier finds ${bad.length === 1 ? 'it' : 'them'} not declared: ${bad[0]}${bad.length > 1 ? '…' : '.'}`,
        ...(bad.length > 1 ? { detail: bad } : {}),
        fix: 'Use the identifier the extension\'s spec gives (io.modelcontextprotocol/ui for MCP Apps, io.modelcontextprotocol/tasks for Tasks), or your reverse-DNS prefix for your own, with {} or a settings object as the value.',
      },
    ];
  },
};
