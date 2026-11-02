import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CLIENTS } from './clients.js';
import { LIST_WORDS } from './lists.js';
import { CLIENT_LIMITS } from './rules/description.js';
import type { Severity } from './types.js';

export interface Config {
  rules?: Record<string, Severity | 'off'>;
  ignore?: string[];
  routes?: string;
  baseline?: string;
  /** Which handshake to make: auto (default), legacy (2025 only) or modern (2026-07-28 only). --protocol wins. */
  protocol?: 'auto' | 'legacy' | 'modern';
  tokenBudget?: number;
  /** diff checks the semver bump against serverInfo.version (off: it's often not the release version). */
  serverVersionIsRelease?: boolean;
  /**
   * Where your client cuts tool descriptions: a number of characters, or a
   * known client ("claude-code", "claude-code-upfront", "amazon-q"). Default "claude-code"
   * (16,384 through tool search, 4,096 for a tool that loads up front).
   */
  descriptionLimit?: number | string;
  /** Tools (names or globs) your client sends with the full description. */
  fullDescriptions?: string[];
  /**
   * snapshot: list the menu once per identity, the first being the main one:
   * { "reader": { "headers": { "Authorization": "Bearer …" } }, "admin": { "env": { "ROLE": "admin" } } }.
   * --as replaces them.
   */
  identities?: Record<string, { headers?: Record<string, string>; env?: Record<string, string> }>;
  /** snapshot: which lists to read besides tools: ["prompts", "resources"]. --lists wins. */
  lists?: string[];
  /** snapshot: the client to check the menu for (claude-code, claude-api-search, openai). --client wins. */
  client?: string;
  /** Server processes (stdio) or connections (HTTP) to compare, the main one included (default 2). */
  processes?: number;
  /**
   * snapshot --catalog: which search tool and which queries (default: detected,
   * derived from the menu), or which command routers to list (default: detected).
   */
  catalog?: { tool?: string; routers?: string[]; queries?: string[]; pauseMs?: number; crawl?: boolean; maxQueries?: number; stopAfter?: number };
}

const DEFAULT_PATH = 'toolmenu.config.json';

/** Optional: no config file is fine. */
export async function loadConfig(path?: string): Promise<Config> {
  const file = path ?? DEFAULT_PATH;
  if (!path && !existsSync(file)) return {};
  let config: Config;
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as Config;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [id, value] of Object.entries(config.rules ?? {})) {
    if (!['error', 'warn', 'info', 'off'].includes(value)) {
      throw new Error(`${file}: rules["${id}"] must be error, warn, info or off`);
    }
  }
  if (config.protocol !== undefined && !['auto', 'legacy', 'modern'].includes(config.protocol)) {
    throw new Error(`${file}: protocol must be auto, legacy or modern`);
  }
  const limit = config.descriptionLimit;
  if (limit !== undefined && !(typeof limit === 'number' && limit > 0) && !(typeof limit === 'string' && limit in CLIENT_LIMITS)) {
    throw new Error(`${file}: descriptionLimit must be a positive number or one of ${Object.keys(CLIENT_LIMITS).join(', ')}`);
  }
  if (config.processes !== undefined && !(Number.isInteger(config.processes) && config.processes >= 1)) {
    throw new Error(`${file}: processes must be a whole number, 1 or more`);
  }
  if (config.lists !== undefined && !(Array.isArray(config.lists) && config.lists.every((l) => (LIST_WORDS as readonly string[]).includes(l)))) {
    throw new Error(`${file}: lists must be a list of ${LIST_WORDS.join(', ')}`);
  }
  if (config.client !== undefined && !(typeof config.client === 'string' && config.client in CLIENTS)) {
    throw new Error(`${file}: client must be one of ${Object.keys(CLIENTS).join(', ')}`);
  }
  if (config.identities !== undefined) {
    const strings = (v: unknown) => v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'));
    const ids = config.identities;
    if (typeof ids !== 'object' || ids === null || Array.isArray(ids)) throw new Error(`${file}: identities must be an object, like { "reader": { "headers": { "Authorization": "Bearer …" } } }`);
    for (const [name, id] of Object.entries(ids)) {
      if (typeof id !== 'object' || id === null || Array.isArray(id) || !strings(id.headers) || !strings(id.env)) {
        throw new Error(`${file}: identities.${name} must be { "headers": { … } } or { "env": { … } }, with string values`);
      }
    }
  }
  const catalog = config.catalog;
  if (catalog !== undefined) {
    const names = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
    if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) throw new Error(`${file}: catalog must be an object, like { "routers": ["keyvault"] } or { "tool": "search_tools" }`);
    if (catalog.tool !== undefined && !(typeof catalog.tool === 'string' && catalog.tool)) throw new Error(`${file}: catalog.tool must be the name of the search tool, a string`);
    if (catalog.routers !== undefined && !names(catalog.routers)) throw new Error(`${file}: catalog.routers must be a list of tool names, like ["keyvault", "storage"]`);
    if (catalog.tool !== undefined && catalog.routers !== undefined) throw new Error(`${file}: catalog names both a search tool (tool) and routers (routers); a menu file keeps one catalog, so keep the one the operations are behind`);
    if (catalog.queries !== undefined && !names(catalog.queries)) throw new Error(`${file}: catalog.queries must be a list of search phrases, like ["list issues"]`);
  }
  return config;
}
