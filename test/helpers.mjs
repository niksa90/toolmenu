import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMenu } from '../dist/menu.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLI = join(ROOT, 'dist/cli.js');
export const FIXTURES = join(ROOT, 'test/fixtures');

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'toolmenu-'));
}

/** Run the CLI and collect its output. */
export function run(args, { cwd = tempDir(), env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, ...(env ? { env: { ...process.env, ...env } } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, cwd }));
  });
}

const str = { type: 'string' };

/** A tool with string params, for unit tests. */
export function tool(name, params = [], extra = {}) {
  return {
    name,
    description: extra.description ?? `${name}.`,
    inputSchema: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, str])), required: params },
    ...extra,
  };
}

export function menuOf(tools, server = {}, listMeta) {
  return buildMenu(tools, server, listMeta);
}
