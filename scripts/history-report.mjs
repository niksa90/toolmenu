// Summarise several `toolmenu history` runs as one markdown table.
// Usage: npm run build && node scripts/history-report.mjs <out>/*/history.json
// Every saved menu is reloaded and re-diffed with this build, so the table uses
// today's token counting and diff rules, not the ones the run was made with.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { diffMenus } from '../dist/diff.js';
import { loadMenu } from '../dist/menu.js';

const rows = [];
for (const file of process.argv.slice(2)) {
  const h = JSON.parse(readFileSync(file, 'utf8'));
  const ok = h.rows.filter((r) => r.status === 'ok');
  if (!ok.length) continue;
  let previous;
  for (const r of ok) {
    const menu = await loadMenu(join(dirname(file), r.menuFile));
    r.tokens = menu.totalTokens;
    delete r.diff;
    if (previous) {
      const d = diffMenus(previous.menu, menu, { release: { before: previous.version, after: r.version } });
      r.diff = {
        breaking: d.findings.filter((f) => f.class === 'breaking').length,
        bumpTooSmall: d.findings.some((f) => f.rule === 'diff/version-bump'),
      };
    }
    previous = { menu, version: r.version };
  }
  const first = ok[0];
  const last = ok.at(-1);
  const diffs = h.rows.filter((r) => r.diff);
  const breakingReleases = diffs.filter((r) => r.diff.breaking > 0);
  rows.push({
    pkg: h.package,
    span: `${h.rows[0].version} → ${h.rows.at(-1).version}`,
    dates: `${h.rows[0].published?.slice(0, 7)} → ${h.rows.at(-1).published?.slice(0, 7)}`,
    ok: `${ok.length}/${h.rows.length}`,
    failed: h.rows.filter((r) => r.status === 'failed').map((r) => `${r.version} (${r.reason})`),
    protocols: [...new Set(ok.map((r) => r.protocolVersion))].join(', '),
    tools: `${first.tools} → ${last.tools}`,
    tokens: `~${first.tokens.toLocaleString('en-US')} → ~${last.tokens.toLocaleString('en-US')}`,
    growth: (last.tokens / first.tokens).toFixed(1),
    breaking: breakingReleases.length,
    breakingChanges: diffs.reduce((n, r) => n + r.diff.breaking, 0),
    tooSmall: diffs.filter((r) => r.diff.bumpTooSmall).map((r) => r.version),
    schemaErrors: ok.filter((r) => r.rules?.['spec/schema']).map((r) => r.version),
    unstable: ok.filter((r) => r.rules?.['menu/nondeterministic']).map((r) => r.version),
  });
}
console.log('| Package | Releases | Protocol | Tools | Menu (est.) | × | Releases with breaking changes | Bump too small |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| \`${r.pkg}\` | ${r.span} (${r.dates}) | ${r.protocols} | ${r.tools} | ${r.tokens} | ${r.growth}× | ${r.breaking} (${r.breakingChanges} changes) | ${r.tooSmall.length ? r.tooSmall.join(', ') : '–'} |`);
}
console.log();
for (const r of rows) {
  const notes = [
    r.failed.length && `failed: ${r.failed.join(', ')}`,
    r.schemaErrors.length && `spec/schema errors: ${r.schemaErrors.join(', ')}`,
    r.unstable.length && `unstable order: ${r.unstable.join(', ')}`,
  ].filter(Boolean);
  if (notes.length) console.log(`- \`${r.pkg}\`: ${notes.join('; ')}`);
}
