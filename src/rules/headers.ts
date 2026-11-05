import type { MenuTool } from '../types.js';
import { count, names, type Rule, type RuleFinding } from './rule.js';

/*
 * x-mcp-header (2026-07-28, SEP-2243): a tool parameter mirrored into an
 * `Mcp-Param-{name}` HTTP header. "Clients using the Streamable HTTP transport
 * MUST reject tool definitions where any x-mcp-header value violates these
 * constraints ... the client MUST exclude the invalid tool from the result of
 * tools/list" (server/tools.mdx). So a bad annotation hides the tool, and the
 * server never hears about it: the official SDK client only logs a warning.
 *
 * The checks follow the spec and the SDK client's own scan
 * (scanXMcpHeaderDeclarations in @modelcontextprotocol/client), which decides
 * what SDK-based clients actually drop. The two agree: since SDK 2.4 the client
 * drops a tool whose header is on a number parameter too, as the spec says.
 */

const KEY = 'x-mcp-header';
// RFC 9110 §5.1 token: 1*tchar. No spaces, control characters or delimiters.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRIMITIVE = new Set(['string', 'integer', 'boolean']);
// Keywords a header's chain of `properties` keys must not pass through.
const UNREACHABLE = [
  'items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
  '$defs', 'definitions',
];
const NAMED = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions']);

export interface HeaderFault {
  /** Where the annotation sits: `region`, `filter.region`, `<items>.id`. */
  path: string;
  /** The annotation's value, as written. */
  header: unknown;
  problem: string;
}

/** Every broken x-mcp-header annotation in a tool's input schema; empty when all are valid or there are none. */
export function headerFaults(tool: MenuTool): HeaderFault[] {
  const faults: HeaderFault[] = [];
  const seen = new Map<string, string>();
  const visit = (node: unknown, path: string[], reachable: boolean) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const schema = node as Record<string, unknown>;
    const where = path.length ? path.join('.') : 'the schema root';
    if (KEY in schema) {
      const raw = schema[KEY];
      const fault = (problem: string) => faults.push({ path: where, header: raw, problem });
      if (!reachable || path.length === 0) {
        fault(
          path.length === 0
            ? 'it sits on the schema root, not on a parameter'
            : `it sits under ${path.find((p) => p.startsWith('<'))?.slice(1, -1) ?? 'a keyword'}; it's only allowed on a parameter reached through "properties" alone (not items, additionalProperties, oneOf/anyOf/allOf/not, if/then/else or $defs)`,
        );
      } else if (typeof raw !== 'string' || raw.length === 0) {
        fault('the header name must be a non-empty string');
      } else if (!TOKEN.test(raw)) {
        fault(`"${raw}" isn't a valid HTTP header name (RFC 9110 token: no spaces, control characters or delimiters such as ( ) / : ; = ? @ [ ] { } " ,)`);
      } else {
        const type = schema.type;
        if (typeof type !== 'string') {
          fault(type === undefined ? 'the parameter has no "type"; it must be string, integer or boolean' : `the parameter's type is ${JSON.stringify(type)}; it must be one of string, integer or boolean, not a list`);
        } else if (type !== 'number' && !PRIMITIVE.has(type)) {
          fault(`the parameter is ${type === 'array' || type === 'object' ? 'an' : 'a'} ${type}; it must be string, integer or boolean`);
        } else {
          // number takes part in the uniqueness check too: the SDK client registers it.
          if (type === 'number') fault('the parameter is a number; it must be string, integer or boolean (make it an integer or a string: a header carries text anyway)');
          const prior = seen.get(raw.toLowerCase());
          if (prior !== undefined) fault(`"${raw}" is already used by ${prior}; header names must differ ignoring case`);
          else seen.set(raw.toLowerCase(), `${where} ("${raw}")`);
        }
      }
    }
    const props = schema.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, child] of Object.entries(props)) visit(child, [...path, key], reachable);
    }
    for (const k of UNREACHABLE) {
      const sub = schema[k];
      if (sub === undefined) continue;
      const branches = Array.isArray(sub) ? sub : sub && typeof sub === 'object' && NAMED.has(k) ? Object.values(sub) : [sub];
      for (const b of branches) visit(b, [...path, `<${k}>`], false);
    }
  };
  visit(tool.inputSchema, [], true);
  return faults;
}

export const xMcpHeader: Rule = {
  id: 'spec/x-mcp-header',
  severity: 'error',
  since: '2026-07-28',
  summary: 'x-mcp-header annotations are valid, so HTTP clients keep the tool',
  run(ctx) {
    const findings: RuleFinding[] = [];
    const http = ctx.transport === 'http';
    for (const tool of ctx.menu.tools) {
      const faults = headerFaults(tool);
      if (!faults.length) continue;
      const where = faults.map((f) => f.path);
      findings.push({
        tool: tool.name,
        // Over HTTP the tool is gone for every compliant client. On stdio clients may
        // ignore the annotation, but the same server is often deployed over HTTP too.
        severity: http ? 'error' : 'warn',
        message: `${tool.name} has ${faults.length === 1 ? 'an x-mcp-header annotation' : `${count(faults.length, 'x-mcp-header annotation')}`} the spec doesn't allow (on ${names(where, 4)}), and Streamable HTTP clients must then leave the whole tool out of their menu. The official SDK client does, with only a console warning, so the agent never sees ${tool.name} and nothing tells the server.${http ? ' toolmenu reads the list off the wire, which is why it is in this menu.' : ' Over stdio clients may ignore the annotation, so it shows here; served over HTTP, it would be gone.'}`,
        detail: faults.map((f) => `${f.path}${typeof f.header === 'string' && f.header ? ` (x-mcp-header: "${f.header}")` : ''}: ${f.problem}`),
        fix: `Fix each annotation listed: on a string, integer or boolean parameter reached through "properties" alone, with a header name of letters, digits and - _ . only, different from the tool's other headers ignoring case. Then list the tools over HTTP with an SDK client and check ${tool.name} is there.`,
      });
    }
    return findings;
  },
};
