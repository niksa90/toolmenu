import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CLIENT_LIMITS } from './rules/description.js';
import type { Severity } from './types.js';

export interface Config {
  rules?: Record<string, Severity | 'off'>;
  ignore?: string[];
  routes?: string;
  baseline?: string;
  tokenBudget?: number;
  /** diff checks the semver bump against serverInfo.version (off: it's often not the release version). */
  serverVersionIsRelease?: boolean;
  /**
   * Where your client cuts tool descriptions: a number of characters, or a
   * known client ("claude-code", "amazon-q"). Default "claude-code" (2,048).
   */
  descriptionLimit?: number | string;
  /** Tools (names or globs) your client sends with the full description. */
  fullDescriptions?: string[];
}

const DEFAULT_PATH = 'toolmenu.config.json';

/** Optional: no config file is fine. */
export async function loadConfig(path?: string): Promise<Config> {
  const file = path ?? DEFAULT_PATH;
  if (!path && !existsSync(file)) return {};
  const config = JSON.parse(await readFile(file, 'utf8')) as Config;
  for (const [id, value] of Object.entries(config.rules ?? {})) {
    if (!['error', 'warn', 'info', 'off'].includes(value)) {
      throw new Error(`${file}: rules["${id}"] must be error, warn, info or off`);
    }
  }
  const limit = config.descriptionLimit;
  if (limit !== undefined && !(typeof limit === 'number' && limit > 0) && !(typeof limit === 'string' && limit in CLIENT_LIMITS)) {
    throw new Error(`${file}: descriptionLimit must be a positive number or one of ${Object.keys(CLIENT_LIMITS).join(', ')}`);
  }
  return config;
}
