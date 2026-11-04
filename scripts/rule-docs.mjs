// Build step: docs/RULES.md → dist/rule-docs.json, which `toolmenu explain` reads.
// docs/ isn't in the npm package; dist/ is.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = {};
let command;
for (const line of readFileSync(join(root, 'docs/RULES.md'), 'utf8').split('\n')) {
  const h = /^## (\w+)/.exec(line);
  if (h) command = h[1];
  const m = /^\| `([a-z]+\/[a-z0-9-]+)` \| ([^|]+) \| (.*) \|$/.exec(line);
  if (!m) continue;
  if (rules[m[1]]) throw new Error(`docs/RULES.md lists ${m[1]} twice`);
  rules[m[1]] = { command, severity: m[2].trim(), text: m[3].trim() };
}
if (Object.keys(rules).length < 50) throw new Error(`docs/RULES.md: only ${Object.keys(rules).length} rules read; has the table format changed?`);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/rule-docs.json'), `${JSON.stringify(rules, null, 1)}\n`);
