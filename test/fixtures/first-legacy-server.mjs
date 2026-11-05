// The first process speaks only the 2025 protocol, later ones 2026-07-28 too: what a
// version probe that timed out under load looks like (the 0.22 corpus run). Logs the
// first method each process received to LOG, one line per process.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = `${process.env.LOG}.started`;
const first = !existsSync(marker);
if (first) writeFileSync(marker, '');
const server = join(fileURLToPath(new URL('.', import.meta.url)), 'handle-server.mjs');
const child = spawn(process.execPath, [server], { env: { ...process.env, LEGACY: first ? '1' : '' }, stdio: ['pipe', 'inherit', 'inherit'] });
let logged = false;
process.stdin.on('data', (d) => {
  if (!logged) {
    logged = true;
    appendFileSync(process.env.LOG, `${/"method":"([^"]+)"/.exec(String(d))?.[1] ?? '?'}\n`);
  }
  child.stdin.write(d);
});
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => process.exit(code ?? 0));
