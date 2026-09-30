import type { DiffResult } from './diff.js';
import type { HistoryResult, HistoryRow } from './history.js';
import { stepLabel, type Scenario, type SessionResult } from './session.js';
import type { Finding, Menu, Severity } from './types.js';
import { breakdown, breakdownLines } from './breakdown.js';
import { autoSummary } from './auto.js';

export type Format = 'text' | 'json' | 'github' | 'markdown';

const LABEL: Record<Severity, string> = { error: 'ERROR', warn: 'WARN ', info: 'INFO ' };

export function counts(findings: Finding[]): Record<Severity, number> {
  const c = { error: 0, warn: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatSnapshot(menu: Menu, findings: Finding[], format: Format, outPath?: string): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        command: 'snapshot',
        server: menu.server,
        tools: menu.tools.length,
        totalTokens: menu.totalTokens,
        listMeta: menu.listMeta,
        breakdown: breakdown(menu),
        written: outPath ?? null,
        counts: counts(findings),
        findings,
      },
      null,
      2,
    );
  }
  if (format === 'github') return githubLines(findings).join('\n');
  if (format === 'markdown') {
    const s = menu.server;
    return [
      `### toolmenu snapshot: \`${s.name ?? 'server'}\` ${s.version ?? ''}`.trimEnd(),
      '',
      `Protocol ${s.protocolVersion ?? 'unknown'} · ${plural(menu.tools.length, 'tool')} · ~${menu.totalTokens.toLocaleString('en-US')} tokens (estimate)`,
      '',
      ...mdFindings(findings),
      ...mdBreakdown(menu),
    ].join('\n');
  }

  const s = menu.server;
  const lines = [
    `toolmenu snapshot  ${s.name ?? 'unknown server'} ${s.version ?? ''}`.trimEnd(),
    `  protocol ${s.protocolVersion ?? 'unknown'} · ${plural(menu.tools.length, 'tool')} · ~${menu.totalTokens.toLocaleString('en-US')} tokens (estimate)`,
  ];
  if (outPath) lines.push(`  wrote ${outPath}`);
  lines.push('');
  const where = breakdownLines(breakdown(menu), menu.tools.length);
  if (where.length) lines.push(...where, '');
  lines.push(...findingLines(findings));
  lines.push(summaryLine(findings));
  return lines.join('\n');
}

function mdBreakdown(menu: Menu): string[] {
  const where = breakdownLines(breakdown(menu), menu.tools.length);
  if (!where.length) return [];
  return ['', `<details><summary>${where[0]}</summary>`, '', '```', ...where.slice(1).map((l) => l.trimStart()), '```', '', '</details>'];
}

function findingLines(findings: Finding[]): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${LABEL[f.severity]}  ${f.rule}${unsureMark(f)}`);
    lines.push(`       ${f.message}`);
    for (const d of f.detail ?? []) lines.push(`         ${d}`);
    if (f.fix) lines.push(`       → Next: ${f.fix}`);
  }
  lines.push(findings.length ? '' : 'No findings.');
  return lines;
}

function summaryLine(findings: Finding[]): string {
  const c = counts(findings);
  return `${plural(c.error, 'error')}, ${plural(c.warn, 'warning')}, ${c.info} info`;
}

function githubLines(findings: Finding[]): string[] {
  return findings.map((f) => {
    const level = f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warning' : 'notice';
    const body = [f.message, ...(f.detail ?? []), ...(f.fix ? [`→ Next: ${f.fix}`] : [])].join('\n').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    return `::${level} title=toolmenu ${f.rule}${unsureMark(f)}::${body}`;
  });
}

function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('en-US')}`;
}

function tokenSentence(d: DiffResult): string {
  const n = Math.abs(d.tokens.delta).toLocaleString('en-US');
  if (d.tokens.delta > 0) return `this release adds ~${n} tokens to every conversation that loads the menu`;
  if (d.tokens.delta < 0) return `this release saves ~${n} tokens in every conversation that loads the menu`;
  return 'no change in menu size';
}

export function formatDiff(d: DiffResult, beforeTools: number, afterTools: number, format: Format): string {
  if (format === 'json') {
    return JSON.stringify({ command: 'diff', ...d, counts: counts(d.findings) }, null, 2);
  }
  const classes = { breaking: 0, minor: 0, notice: 0 };
  for (const f of d.findings) if (f.class) classes[f.class]++;
  // Name the release versions when there are some; otherwise say whose version this is.
  const pair = d.release?.source === 'release'
    ? `${d.release.before} → ${d.release.after}`
    : `${d.before.version ?? '?'} → ${d.after.version ?? '?'} (server-reported)`;
  const actual = d.actualBump ?? `not checked (${d.bumpNotChecked ?? 'pass --release'})`;
  const headline = `${d.after.name ?? d.before.name ?? 'server'} ${pair}`;
  const tokenLine = `~${d.tokens.before.toLocaleString('en-US')} → ~${d.tokens.after.toLocaleString('en-US')} tokens (${signed(d.tokens.delta)}, estimate): ${tokenSentence(d)}`;
  const bumpLine = `suggested bump: ${d.suggestedBump} · actual: ${actual}`;

  if (format === 'github') {
    return [...githubLines(d.findings), `::notice title=toolmenu diff::${headline}. ${tokenLine}. ${bumpLine}.`].join('\n');
  }
  if (format === 'markdown') {
    const lines = [
      `### toolmenu diff: \`${d.after.name ?? d.before.name ?? 'server'}\` ${pair}`,
      '',
      `**${signed(d.tokens.delta)} tokens** (~${d.tokens.before.toLocaleString('en-US')} → ~${d.tokens.after.toLocaleString('en-US')}, estimate): ${tokenSentence(d)}.`,
      '',
      `**${classes.breaking} breaking** · ${classes.minor} minor · ${classes.notice} notice · suggested bump: **${d.suggestedBump}** (actual: ${actual}) · ${beforeTools} → ${afterTools} tools`,
      '',
      ...mdFindings(d.findings),
    ];
    if (d.tokens.tools.length) {
      lines.push('', '<details><summary>Token change by tool (estimate)</summary>', '', '| Tool | Before | After | Change |', '|---|---:|---:|---:|');
      for (const t of d.tokens.tools.slice(0, 30)) lines.push(`| \`${t.name}\` | ${t.before.toLocaleString('en-US')} | ${t.after.toLocaleString('en-US')} | ${signed(t.delta)} |`);
      if (d.tokens.tools.length > 30) lines.push(`| …and ${d.tokens.tools.length - 30} more | | | |`);
      lines.push('', '</details>');
    }
    return lines.join('\n');
  }
  const lines = [
    `toolmenu diff  ${headline}`,
    `  ${beforeTools} → ${afterTools} tools · ${tokenLine}`,
    `  ${classes.breaking} breaking · ${classes.minor} minor · ${classes.notice} notice · ${bumpLine}`,
    '',
    ...findingLines(d.findings),
  ];
  if (d.tokens.tools.length) {
    lines.push('Token change by tool (estimate):');
    for (const t of d.tokens.tools.slice(0, 10)) lines.push(`  ${signed(t.delta).padStart(7)}  ${t.name}`);
    if (d.tokens.tools.length > 10) lines.push(`  …and ${d.tokens.tools.length - 10} more`);
    lines.push('');
  }
  lines.push(summaryLine(d.findings));
  return lines.join('\n');
}

export function formatHistory(h: HistoryResult, format: Format, outDir: string): string {
  if (format === 'json') return JSON.stringify({ command: 'history', ...h }, null, 2);
  const ok = h.rows.filter((r) => r.status === 'ok');
  const failed = h.rows.filter((r) => r.status === 'failed');
  const reasons: Record<string, number> = {};
  for (const r of failed) reasons[r.reason ?? 'crashed'] = (reasons[r.reason ?? 'crashed'] ?? 0) + 1;
  const failSummary = failed.length ? ` (${Object.entries(reasons).map(([k, n]) => `${k} ${n}`).join(', ')})` : '';

  if (format === 'github') {
    const lines = h.rows.flatMap((r) =>
      r.status === 'failed'
        ? [`::warning title=toolmenu history ${r.version}::failed: ${r.reason}`]
        : (r.diff?.breakingChanges ?? []).map((m) => `::error title=toolmenu history ${r.version}::${m}`),
    );
    return [...lines, `::notice title=toolmenu history::${h.package}: ${ok.length} of ${h.rows.length} versions inspected${failSummary}`].join('\n');
  }

  const sdkOf = (r: HistoryRow) => (r.resolved?.['@modelcontextprotocol/sdk'] ?? r.resolved?.['@modelcontextprotocol/server'] ?? []).join('+') || '-';
  const table = [
    ['version', 'published', 'protocol', 'tools', 'tokens', 'sdk', 'zod', 'findings', 'vs previous'],
    ...h.rows.map((r) =>
      r.status === 'failed'
        ? [r.version, r.published?.slice(0, 10) ?? '', `failed: ${r.reason}`, '', '', sdkOf(r), (r.resolved?.zod ?? []).join('+') || '-', '', '']
        : [
            r.version,
            r.published?.slice(0, 10) ?? '',
            r.protocolVersion ?? '?',
            String(r.tools ?? ''),
            `~${(r.tokens ?? 0).toLocaleString('en-US')}`,
            sdkOf(r),
            (r.resolved?.zod ?? []).join('+') || '-',
            [r.counts?.error ? `${r.counts.error} err` : '', r.counts?.warn ? `${r.counts.warn} warn` : ''].filter(Boolean).join(' ') || 'clean',
            r.diff
              ? `${signed(r.diff.tokenDelta)} tokens · ${[r.diff.breaking && `${r.diff.breaking} breaking`, r.diff.minor && `${r.diff.minor} minor`, r.diff.notice && `${r.diff.notice} notice`].filter(Boolean).join(' · ') || 'no changes'}`
              : '—',
          ],
    ),
  ];
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const lines = [
    `toolmenu history  ${h.package}`,
    `  last ${h.rows.length} of ${h.totalVersions} published versions · installed ${h.installedAt.slice(0, 10)}`,
    `  (each version was installed today: dependencies resolve as of today, not as shipped)`,
    '',
    ...table.map((row) => '  ' + row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()),
    '',
  ];
  const breaking = h.rows.filter((r) => r.diff?.breakingChanges.length);
  if (breaking.length) {
    lines.push('Breaking changes:');
    for (const r of breaking) for (const m of r.diff!.breakingChanges) lines.push(`  ${r.version} (vs ${r.diff!.from}): ${m}`);
    lines.push('');
  }
  if (failed.length) {
    lines.push('Failed:');
    for (const r of failed) lines.push(`  ${r.version}: ${r.reason}. ${(r.error ?? '').split('\n')[0].slice(0, 160)}`);
    lines.push('');
  }
  lines.push(`${h.rows.length} inspected · ${ok.length} ok · ${failed.length} failed${failSummary} · wrote ${outDir}`);
  return lines.join('\n');
}

export function formatSession(s: SessionResult, format: Format): string {
  if (format === 'json') {
    // The union menu itself goes to --union-out; the report says how big it is.
    const { union, ...rest } = s;
    return JSON.stringify({ command: 'session', ...rest, union: { tools: union.tools.length, totalTokens: union.totalTokens }, counts: counts(s.findings) }, null, 2);
  }
  if (format === 'github') {
    return githubLines(s.findings.map((f) => ({ ...f, message: stepPrefix(f, `step ${f.step} (${s.steps[(f.step ?? 1) - 1]?.label}): `) }))).join('\n');
  }
  if (format === 'markdown') {
    const lines = [
      `### toolmenu session: \`${s.scenario}\``,
      '',
      `\`${s.server.name ?? 'server'}\` ${s.server.version ?? ''} · protocol ${s.server.protocolVersion ?? '?'} · ${s.transport} · ${s.baseline.tools} → ${s.final.tools} tools · ~${s.baseline.tokens.toLocaleString('en-US')} → ~${s.final.tokens.toLocaleString('en-US')} tokens (estimate)`,
      '',
      ...(s.auto ? [...autoSummary(s.auto).map((l, i) => (i === 0 ? `**${l.replace(/^auto: /, 'auto:** ')}` : `- ${l.trim()}`)), ''] : []),
      '| Step | Menu | list_changed | Scope |',
      '|---|---|---|---|',
      ...s.steps.map((st) => `| ${st.index}. ${mdCell(st.label)} | ${st.status !== 'ok' ? st.status : st.changed ? `changed (${st.tools} tools)` : 'no change'} | ${st.changed ? (st.listChanged ? 'received' : '**missing**') : ''} | ${st.scope ?? ''} |`),
      '',
      ...mdFindings(s.findings.map((f) => ({ ...f, message: stepPrefix(f, `Step ${f.step}: `) }))),
    ];
    return lines.join('\n');
  }
  const tok = (n: number) => `~${n.toLocaleString('en-US')}`;
  const lines = [
    `toolmenu session  ${s.scenario}`,
    `  ${s.server.name ?? 'server'} ${s.server.version ?? ''} · protocol ${s.server.protocolVersion ?? '?'} · ${s.transport}`,
    `  baseline: ${plural(s.baseline.tools, 'tool')} · ${tok(s.baseline.tokens)} tokens (estimate) · listening for list_changed: ${s.listening ? 'yes' : 'no'}`,
    ...(s.auto ? autoSummary(s.auto).map((l, i) => (i === 0 ? `  ${l}` : `    ${l}`)) : []),
    `  fresh-${s.transport === 'stdio' ? 'process' : 'connection'} check: ${s.connectionCheck === undefined ? 'not checked' : s.connectionCheck === 'same' ? 'the same menu' : 'a DIFFERENT menu'}`,
    '',
  ];
  const at = (step: number) => s.findings.filter((f) => f.step === step);
  const block = (findings: Finding[]) => {
    for (const f of findings) {
      lines.push(`  ${LABEL[f.severity]}  ${f.rule}${unsureMark(f)}`);
      lines.push(`         ${f.message}`);
      for (const d of f.detail ?? []) lines.push(`           ${d}`);
      if (f.fix) lines.push(`         → Next: ${f.fix}`);
    }
  };
  block(at(0));
  if (at(0).length) lines.push('');
  let before = s.baseline.tools;
  for (const step of s.steps) {
    const delta = step.tools - before;
    before = step.tools;
    const facts = [
      step.status !== 'ok' ? step.status : '',
      step.changed ? `menu changed${delta ? ` · ${delta > 0 ? '+' : '−'}${plural(Math.abs(delta), 'tool')}` : ''}` : step.status === 'ok' ? 'no change' : '',
      step.changed ? (step.listChanged ? 'list_changed received' : 'no list_changed') : '',
      step.scope ? `scope: ${step.scope}` : '',
      step.note ?? '',
    ].filter(Boolean);
    lines.push(`step ${step.index}: ${step.label} · ${facts.join(' · ')}`);
    block(at(step.index));
  }
  // Findings about the whole run (session/untested), after the steps.
  const run = s.findings.filter((f) => f.step === undefined);
  if (run.length) {
    lines.push('');
    block(run);
  }
  lines.push('');
  lines.push(`final: ${plural(s.final.tools, 'tool')} · ${tok(s.final.tokens)} tokens (estimate)`);
  lines.push(summaryLine(s.findings));
  return lines.join('\n');
}

export function formatPlan(scenario: Scenario, name: string): string {
  const lines = [`toolmenu session --plan  ${name}`, `  allow_writes: ${scenario.allowWrites}${scenario.allowWrites ? '' : ' (tools not marked readOnlyHint will be refused)'}`, ''];
  scenario.steps.forEach((step, i) => lines.push(`step ${i + 1}: ${stepLabel(step)}${step.kind === 'wait_for' ? ` (up to ${step.timeoutMs} ms)` : ''}`));
  lines.push('', 'After every step the menu is listed and compared with the one before. Nothing was run.');
  return lines.join('\n');
}

/** " · unsure" after the rule, for findings that are a heuristic or an inference. */
function unsureMark(f: Finding): string {
  return f.confidence === 'unsure' ? ' · unsure' : '';
}

/** The step a session finding belongs to, unless its message already names its steps. */
function stepPrefix(f: Finding, prefix: string): string {
  if (!f.step || /^steps? \d/i.test(f.message)) return f.message;
  return prefix + f.message;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function mdFindings(findings: Finding[]): string[] {
  if (findings.length === 0) return ['No findings.'];
  const row = (f: Finding) =>
    `| ${f.severity === 'error' ? '**error**' : f.severity} | \`${f.rule}\`${f.confidence === 'unsure' ? ' · _unsure_' : ''} | ${mdCell([f.message, ...(f.detail ?? [])].join(' · '))}${f.fix ? `<br>**→ Next:** ${mdCell(f.fix)}` : ''} |`;
  const head = ['| | Rule | Finding |', '|---|---|---|'];
  const loud = findings.filter((f) => f.severity !== 'info');
  const quiet = findings.filter((f) => f.severity === 'info');
  const c = counts(findings);
  const lines = loud.length ? [...head, ...loud.map(row)] : [];
  // Info goes in a fold so a PR comment leads with what needs attention.
  if (quiet.length) lines.push('', `<details><summary>${quiet.length} info</summary>`, '', ...head, ...quiet.map(row), '', '</details>');
  lines.push('', `${plural(c.error, 'error')}, ${plural(c.warn, 'warning')}, ${c.info} info`);
  return lines;
}
