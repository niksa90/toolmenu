// Findings per server from a corpus run, and what changed against an earlier one.
//   node bench/report.mjs <out-dir> [<baseline-out-dir>]
// Counts come from the snapshot and session JSON that bench/run.sh writes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function load(dir) {
  const servers = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.snapshot.json')).sort()) {
    const name = file.replace(/\.snapshot\.json$/, '');
    const read = (suffix) => {
      const path = join(dir, name + suffix);
      if (!existsSync(path)) return undefined;
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return undefined;
      }
    };
    const snap = read('.snapshot.json');
    const session = read('.session.json');
    const rules = {};
    for (const f of [...(snap?.findings ?? []), ...(session?.findings ?? [])]) {
      const key = `${f.severity}:${f.rule}`;
      rules[key] = (rules[key] ?? 0) + 1;
    }
    servers.set(name, {
      ok: Boolean(snap),
      protocol: snap?.server?.protocolVersion ?? '-',
      tools: snap?.tools ?? 0,
      tokens: snap?.totalTokens ?? 0,
      rules,
    });
  }
  return servers;
}

const short = (key) => key.replace(/^error:/, 'E ').replace(/^warn:/, 'W ').replace(/^info:/, 'I ');
const [dir, baseDir] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node bench/report.mjs <out-dir> [<baseline-out-dir>]');
  process.exit(2);
}
const now = load(dir);
const before = baseDir ? load(baseDir) : undefined;

const totals = {};
for (const [name, s] of now) {
  if (!s.ok) {
    console.log(`${name.padEnd(18)} failed to snapshot`);
    continue;
  }
  const rules = Object.entries(s.rules).sort().map(([k, n]) => `${short(k)}${n > 1 ? `×${n}` : ''}`);
  console.log(`${name.padEnd(18)} ${s.protocol.padEnd(10)} ${String(s.tools).padStart(3)} tools ~${String(s.tokens).padStart(6)}  ${rules.join(', ') || 'clean'}`);
  for (const [k, n] of Object.entries(s.rules)) totals[k] = (totals[k] ?? 0) + n;
  if (before?.has(name)) {
    const old = before.get(name).rules;
    const keys = new Set([...Object.keys(old), ...Object.keys(s.rules)]);
    const changes = [...keys].sort().flatMap((k) => ((s.rules[k] ?? 0) === (old[k] ?? 0) ? [] : [`${short(k)} ${old[k] ?? 0}→${s.rules[k] ?? 0}`]));
    if (changes.length) console.log(`${''.padEnd(18)} changed: ${changes.join(', ')}`);
  }
}
console.log('\nTotals:');
for (const [k, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
  const was = before ? [...before.values()].reduce((sum, s) => sum + (s.rules[k] ?? 0), 0) : undefined;
  console.log(`  ${String(n).padStart(4)}  ${short(k)}${was !== undefined && was !== n ? `  (was ${was})` : ''}`);
}
