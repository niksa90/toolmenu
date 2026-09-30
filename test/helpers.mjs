import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMenu } from '../dist/menu.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLI = join(ROOT, 'dist/cli.js');
export const FIXTURES = join(ROOT, 'test/fixtures');

const made = [];
// Removed when the test file's process exits: every run used to leave its folders
// behind in the system temp dir (thousands, on a machine that runs the suite often).
process.on('exit', () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * The per-request timeout for tests that don't test timeouts. A request timeout also
 * bounds starting the server (initialize waits for the process to come up), and on a
 * busy machine starting a node server took longer than the 10–30 s the tests used to
 * give it. A ceiling, not a wait: a hang still fails, later.
 */
export const TIMEOUT_MS = 120_000;

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'toolmenu-'));
  made.push(dir);
  return dir;
}

/** Run the CLI and collect its output. */
export function run(args, { cwd = tempDir(), env } = {}) {
  return new Promise((resolve) => {
    // --timeout first, so a test that passes its own still wins (the last one counts).
    const child = spawn(process.execPath, [CLI, '--timeout', String(TIMEOUT_MS), ...args], { cwd, ...(env ? { env: { ...process.env, ...env } } : {}) });
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
