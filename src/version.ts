import { readFileSync } from 'node:fs';

/** toolmenu's own version, from package.json (one place to bump it). */
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
