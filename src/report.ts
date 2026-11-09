import type { ClientCost } from './clients.js';
import { agentMenu } from './apps.js';
import type { DiffResult } from './diff.js';
import type { HistoryResult, HistoryRow } from './history.js';
import { clip, stepLabel, stepsText, type Scenario, type SessionResult } from './session.js';
import { SEVERITY_RANK, type Finding, type Menu, type Severity } from './types.js';
import { breakdown, breakdownLines, breakdownMarkdown } from './breakdown.js';
import { autoSummary } from './auto.js';
import { mdCode, mdText, plain } from './sanitize.js';

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

/** snapshot --lists: "3 prompts · 5 resources · 2 resource templates", or nothing. */
function otherLists(menu: Menu): string {
  return [
    menu.prompts ? plural(menu.prompts.length, 'prompt') : '',
    menu.resources ? plural(menu.resources.length, 'resource') : '',
    menu.resourceTemplates ? plural(menu.resourceTemplates.length, 'resource template') : '',
  ].filter(Boolean).join(' · ');
}

/** --client: "as Claude Code: up front ~N tokens (…) · on demand ~M per tool loaded (largest: x, ~K)". */
export function costLine(cost: ClientCost, name: (tool: string) => string = plain): string {
  const parts = [
    cost.upfront !== undefined ? `up front ~${cost.upfront.toLocaleString('en-US')} tokens${cost.loaded.length ? ` (names, and ${plural(cost.loaded.length, 'tool')} loaded in full)` : ''}` : '',
    `on demand ~${cost.perTool.toLocaleString('en-US')} per tool a search loads${cost.largest ? ` (largest: ${name(cost.largest.tool)}, ~${cost.largest.tokens.toLocaleString('en-US')})` : ''}`,
  ].filter(Boolean);
  return `as ${cost.label}: ${parts.join(' · ')}`;
}

/** " · 2 not shown to the agent (MCP Apps visibility without "model", ~60 tokens)", or nothing. */
function appOnlyNote(a: { tools: number; tokens: number } | undefined): string {
  return a ? ` · ${a.tools} not shown to the agent (MCP Apps visibility without "model", ~${a.tokens.toLocaleString('en-US')} tokens)` : '';
}

export function formatSnapshot(menu: Menu, findings: Finding[], format: Format, outPath?: string, cost?: ClientCost, notOffered: string[] = []): string {
  const view = agentMenu(menu);
  if (format === 'json') {
    return JSON.stringify(
      {
        command: 'snapshot',
        server: menu.server,
        tools: menu.tools.length,
        totalTokens: menu.totalTokens,
        listMeta: menu.listMeta,
        ...(view.appOnly ? { appOnly: view.appOnly } : {}),
        breakdown: breakdown(view.shown),
        ...(cost ? { client: cost } : {}),
        ...(menu.prompts ? { prompts: menu.prompts.length } : {}),
        ...(menu.resources ? { resources: menu.resources.length } : {}),
        ...(menu.resourceTemplates ? { resourceTemplates: menu.resourceTemplates.length } : {}),
        ...(notOffered.length ? { notOffered } : {}),
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
      `### toolmenu snapshot: ${mdCode(s.name ?? 'server')} ${mdText(s.version ?? '')}`.trimEnd(),
      '',
      `Protocol ${mdText(s.protocolVersion ?? 'unknown')} · ${plural(menu.tools.length, 'tool')} · ~${menu.totalTokens.toLocaleString('en-US')} tokens (estimate)${appOnlyNote(view.appOnly)}`,
      ...(cost ? ['', `${costLine(cost, mdCode)}. _${cost.basis}._`] : []),
      ...(otherLists(menu) ? ['', `Also listed: ${otherLists(menu)}`] : []),
      '',
      ...mdFindings(findings),
      ...mdBreakdown(view.shown),
    ].join('\n');
  }

  const s = menu.server;
  const lines = [
    `toolmenu snapshot  ${plain(s.name ?? 'unknown server')} ${plain(s.version ?? '')}`.trimEnd(),
    `  protocol ${plain(s.protocolVersion ?? 'unknown')} · ${plural(menu.tools.length, 'tool')} · ~${menu.totalTokens.toLocaleString('en-US')} tokens (estimate)${appOnlyNote(view.appOnly)}`,
  ];
  if (cost) lines.push(`  ${costLine(cost)}`, `    ${cost.basis}`);
  const others = otherLists(menu);
  // Lists asked for that the server doesn't offer: said once, not a finding.
  const caps = [...new Set(notOffered.map((k) => (k === 'prompts' ? 'prompts' : 'resources')))];
  if (others || caps.length) lines.push(`  ${[others ? `also listed: ${others}` : '', caps.length ? `no ${caps.join(' or ')} offered (not declared)` : ''].filter(Boolean).join(' · ')}`);
  if (outPath) lines.push(`  wrote ${outPath}`);
  lines.push('');
  const where = breakdownLines(breakdown(view.shown), view.shown.tools.length);
  if (where.length) lines.push(...where, '');
  lines.push(...findingLines(findings));
  lines.push(summaryLine(findings));
  return lines.join('\n');
}

function mdBreakdown(menu: Menu): string[] {
  return breakdownMarkdown(breakdown(menu), menu.tools.length);
}

export function findingLines(findings: Finding[]): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${LABEL[f.severity]}  ${f.rule}${unsureMark(f)}`);
    lines.push(`       ${plain(f.message)}`);
    for (const d of f.detail ?? []) lines.push(`         ${plain(d)}`);
    if (f.fix) lines.push(`       → Next: ${plain(f.fix)}`);
  }
  lines.push(findings.length ? '' : 'No findings.');
  return lines;
}

/** The last line of every report: ✗ with errors, ! with warnings, ✓ otherwise. */
function summaryLine(findings: Finding[]): string {
  const c = counts(findings);
  const mark = c.error ? '✗' : c.warn ? '!' : '✓';
  return `${mark} ${plural(c.error, 'error')}, ${plural(c.warn, 'warning')}, ${c.info} info`;
}

export function githubLines(findings: Finding[]): string[] {
  return findings.map((f) => {
    const level = f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warning' : 'notice';
    // plain(): a newline in the server's text is shown, not a line of the annotation.
    const body = [f.message, ...(f.detail ?? []), ...(f.fix ? [`→ Next: ${f.fix}`] : [])].map(plain).join('\n').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    return `::${level} title=toolmenu ${f.rule}${unsureMark(f)}::${body}`;
  });
}

export function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('en-US')}`;
}

function tokenSentence(d: DiffResult): string {
  const n = Math.abs(d.tokens.delta).toLocaleString('en-US');
  if (d.tokens.delta > 0) return `this release adds ~${n} tokens to every conversation that loads the menu`;
  if (d.tokens.delta < 0) return `this release saves ~${n} tokens in every conversation that loads the menu`;
  return 'no change in menu size';
}

/** "3 breaking (25 tools) · 2 minor (2 tools) · 11 notice (10 tools)": changes, and the tools they touch. */
export function classLine(d: DiffResult): string {
  const part = (c: 'breaking' | 'minor' | 'notice') => {
    const { changes, tools } = d.classes[c];
    return `${changes} ${c}${changes && tools ? ` (${plural(tools, 'tool')})` : ''}`;
  };
  return `${part('breaking')} · ${part('minor')} · ${part('notice')}`;
}

/**
 * The version verdict: the bump these changes suggest, then whether the release's
 * bump is enough (and what to release instead), or why it wasn't checked.
 */
export function bumpVerdict(d: DiffResult, md = false): { line: string; short: boolean } {
  const b = (s: string) => (md ? `**${s}**` : s);
  /** A version, as given: from --release or the server. */
  const v = (s: string) => (md ? mdText(s) : plain(s));
  const suggested = `suggested bump: ${b(d.suggestedBump)}`;
  if (!d.actualBump || !d.release) return { line: `${suggested} · not checked (${d.bumpNotChecked ?? 'pass --release old..new'})`, short: false };
  const pair = `${v(d.release.before)} → ${v(d.release.after)} is a ${d.actualBump} bump`;
  const required = d.requiredBump ?? d.suggestedBump;
  const below1 = required !== d.suggestedBump ? ` (under 1.0.0 ${required === 'none' ? 'anything goes' : `a ${required} is enough`})` : '';
  const rank = { none: 0, patch: 1, minor: 2, major: 3 } as const;
  if (rank[d.actualBump] >= rank[required]) return { line: `${suggested} · ${pair}: enough${below1}`, short: false };
  return { line: `${suggested} · ${pair}: ${b(`too small, release ${d.releaseAs ? v(d.releaseAs) : `a ${required}`}`)}${below1}`, short: true };
}

export function releasePair(d: DiffResult, md = false): string {
  const v = (s: string) => (md ? mdText(s) : plain(s));
  // Name the release versions when there are some; otherwise say whose version this is.
  return d.release?.source === 'release' ? `${v(d.release.before)} → ${v(d.release.after)}` : `${v(d.before.version ?? '?')} → ${v(d.after.version ?? '?')} (server-reported)`;
}

export function formatDiff(d: DiffResult, beforeTools: number, afterTools: number, format: Format): string {
  if (format === 'json') {
    return JSON.stringify({ command: 'diff', ...d, counts: counts(d.findings) }, null, 2);
  }
  const name = d.after.name ?? d.before.name ?? 'server';
  const pair = releasePair(d);
  const verdict = bumpVerdict(d);
  const tokenLine = `~${d.tokens.before.toLocaleString('en-US')} → ~${d.tokens.after.toLocaleString('en-US')} (${signed(d.tokens.delta)}, estimate): ${tokenSentence(d)}`;

  if (format === 'github') {
    return [...githubLines(d.findings), `::notice title=toolmenu diff::${ghEscape(`${name} ${pair}. Changes: ${classLine(d)}. Tokens: ${tokenLine}. Version: ${verdict.line}.`)}`].join('\n');
  }
  if (format === 'markdown') return mdDiff(d, beforeTools, afterTools);

  const lines = [
    `toolmenu diff  ${plain(name)} ${pair}`,
    `  changes  ${classLine(d)}`,
    `  version  ${verdict.line}`,
    `  tokens   ${tokenLine}`,
    `  tools    ${beforeTools} → ${afterTools}`,
    '',
    ...findingLines(d.findings),
  ];
  if (d.tokens.tools.length) {
    lines.push('Token change by tool (estimate):');
    for (const t of d.tokens.tools.slice(0, 10)) lines.push(`  ${signed(t.delta).padStart(7)}  ${plain(t.name)}`);
    if (d.tokens.tools.length > 10) lines.push(`  …and ${d.tokens.tools.length - 10} more`);
    lines.push('');
  }
  lines.push(summaryLine(d.findings));
  return lines.join('\n');
}

/** The diff as a PR comment: the verdict first, then the changes by class, notices folded. */
function mdDiff(d: DiffResult, beforeTools: number, afterTools: number): string {
  const name = d.after.name ?? d.before.name ?? 'server';
  const verdict = bumpVerdict(d, true);
  const c = d.classes;
  const headline = [
    c.breaking.changes ? `**${plural(c.breaking.changes, 'breaking change')}** in ${plural(c.breaking.tools, 'tool')}` : 'No breaking changes',
    `${c.minor.changes} minor`,
    `${c.notice.changes} notice${c.notice.changes === 1 ? '' : 's'}`,
    `**${signed(d.tokens.delta)} tokens** (~${d.tokens.before.toLocaleString('en-US')} → ~${d.tokens.after.toLocaleString('en-US')}, estimate)`,
    `${beforeTools} → ${afterTools} tools`,
  ].join(' · ');
  const lines = [`### toolmenu diff: ${mdCode(name)} ${releasePair(d, true)}`, '', headline, '', `> **Version:** ${verdict.line}`, ''];
  if (d.tokens.delta !== 0) lines.splice(lines.length - 1, 0, '>', `> **Tokens:** ${tokenSentence(d)}.`);

  const table = (findings: typeof d.findings) => ['| | Rule | Change |', '|---|---|---|', ...findings.map(mdDiffRow)];
  // Sections follow the severity the user's rules set, not only the class: a
  // notice raised to error fails CI, so it's shown, never folded; a breaking
  // rule lowered to info is folded with the notices.
  const loud = (f: (typeof d.findings)[number]) => f.severity !== 'info';
  const breaking = d.findings.filter((f) => f.class === 'breaking' && loud(f));
  const checks = d.findings.filter((f) => f.class !== 'breaking' && f.class !== 'minor' && loud(f));
  const minor = d.findings.filter((f) => f.class === 'minor');
  const quiet = d.findings.filter((f) => f.class !== 'minor' && !loud(f));
  if (breaking.length) lines.push(`#### Breaking (${breaking.length})`, '', ...table(breaking), '');
  if (checks.length) lines.push(`#### To check (${checks.length})`, '', ...table(checks), '');
  if (minor.length) lines.push(`#### New (${minor.length}, minor)`, '', ...table(minor), '');
  if (quiet.length) lines.push(`<details><summary>Notices (${quiet.length})</summary>`, '', ...table(quiet), '', '</details>', '');
  if (!d.findings.length) lines.push('No findings.', '');
  if (d.tokens.tools.length) {
    lines.push('<details><summary>Token change by tool (estimate)</summary>', '', '| Tool | Before | After | Change |', '|---|---:|---:|---:|');
    for (const t of d.tokens.tools.slice(0, 30)) lines.push(`| ${mdCode(t.name, { cell: true })} | ${t.before.toLocaleString('en-US')} | ${t.after.toLocaleString('en-US')} | ${signed(t.delta)} |`);
    if (d.tokens.tools.length > 30) lines.push(`| …and ${d.tokens.tools.length - 30} more | | | |`);
    lines.push('', '</details>', '');
  }
  lines.push(summaryLine(d.findings));
  return lines.join('\n');
}

/** One diff finding as a table row: a long tool list folds, a text change shows as -/+ lines. */
function mdDiffRow(f: DiffResult['findings'][number]): string {
  const detail = (f.detail ?? []).map((line) => {
    const list = /^(tools|operations|moved): (.*)$/.exec(line);
    if (list) return `<details><summary>all ${list[2].split(', ').length} ${list[1] === 'moved' ? 'moved tools' : list[1]}</summary>${mdCell(list[2])}</details>`;
    return `<br><sub>${mdCell(line)}</sub>`;
  });
  const sev = f.severity === 'error' ? '**error**' : f.severity;
  return `| ${sev} | \`${f.rule}\`${f.confidence === 'unsure' ? ' · _unsure_' : ''} | ${mdCell(f.message)}${detail.join('')}${f.fix ? `<br>**→ Next:** ${mdCell(f.fix)}` : ''} |`;
}

export function formatHistory(h: HistoryResult, format: Format, outDir: string, csvPath?: string): string {
  if (format === 'json') return JSON.stringify({ command: 'history', ...h, written: { dir: outDir, csv: csvPath ?? null } }, null, 2);
  const ok = h.rows.filter((r) => r.status === 'ok');
  const failed = h.rows.filter((r) => r.status === 'failed');
  const breaking = h.rows.filter((r) => r.diff?.breakingChanges.length);
  const reasons: Record<string, number> = {};
  for (const r of failed) reasons[r.reason ?? 'crashed'] = (reasons[r.reason ?? 'crashed'] ?? 0) + 1;
  const reasonList = Object.entries(reasons).map(([k, n]) => `${n} ${k}`).join(', ');
  const mark = ok.length === 0 && h.rows.length ? '✗' : failed.length || breaking.length ? '!' : '✓';
  const summary = [
    `${mark} ${ok.length} of ${plural(h.rows.length, 'version')} inspected`,
    ...(failed.length ? [`${failed.length} failed (${reasonList})`] : []),
    // "No breaking changes" only when there was something to compare.
    ...(breaking.length ? [`${plural(breaking.length, 'release')} with breaking changes`] : ok.length > 1 ? ['no breaking changes'] : []),
  ].join(' · ');
  const scope = `the last ${h.rows.length} of ${h.totalVersions} published versions, installed ${h.installedAt.slice(0, 10)}: dependencies resolve as of that day, not as shipped`;
  const saved = `menus and history.json in ${outDir}${csvPath ? ` · CSV in ${csvPath}` : ''}`;
  const failure = (r: HistoryRow) => r.message ?? `${r.reason}: ${(r.error ?? '').split('\n')[0].slice(0, 160)}`;

  if (format === 'github') {
    const lines = h.rows.flatMap((r) =>
      r.status === 'failed'
        ? [`::warning title=toolmenu history ${r.version} (${r.reason}${r.confidence === 'unsure' ? ' · unsure' : ''})::${ghEscape([failure(r), ...(r.fix ? [`→ Next: ${r.fix}`] : [])].join('\n'))}`]
        : (r.diff?.breakingChanges ?? []).map((m) => `::error title=toolmenu history ${r.version}::${ghEscape(`${m} (vs ${r.diff!.from})`)}`),
    );
    return [...lines, `::notice title=toolmenu history::${ghEscape(`${h.package}: ${summary.slice(2)}. ${saved}.`)}`].join('\n');
  }

  const sdkOf = (r: HistoryRow) => (r.resolved?.['@modelcontextprotocol/sdk'] ?? r.resolved?.['@modelcontextprotocol/server'] ?? []).join('+') || '-';
  const zodOf = (r: HistoryRow) => (r.resolved?.zod ?? []).join('+') || '-';
  const findingsOf = (r: HistoryRow) => [r.counts?.error ? `${r.counts.error} err` : '', r.counts?.warn ? `${r.counts.warn} warn` : ''].filter(Boolean).join(' ') || 'clean';
  const versus = (r: HistoryRow) => {
    if (!r.diff) return '—';
    const d = r.diff;
    const changes = [d.breaking && `${d.breaking} breaking`, d.minor && `${d.minor} minor`, d.notice && `${d.notice} notice`].filter(Boolean).join(' · ') || 'no changes';
    return `${signed(d.tokenDelta)} tokens · ${changes}${d.bumpTooSmall ? ` · bump too small (${d.actualBump ?? '?'}, needs ${d.suggestedBump})` : ''}`;
  };
  const head = ['version', 'published', 'protocol', 'tools', 'tokens', 'sdk', 'zod', 'findings', 'vs previous'];
  const cells = (r: HistoryRow) =>
    r.status === 'failed'
      ? [r.version, r.published?.slice(0, 10) ?? '', `failed: ${r.reason}`, '', '', sdkOf(r), zodOf(r), '', '']
      : [r.version, r.published?.slice(0, 10) ?? '', r.protocolVersion ?? '?', String(r.tools ?? ''), `~${(r.tokens ?? 0).toLocaleString('en-US')}`, sdkOf(r), zodOf(r), findingsOf(r), versus(r)];

  if (format === 'markdown') {
    const lines = [
      `### toolmenu history: ${mdCode(h.package)}`,
      '',
      `${scope.charAt(0).toUpperCase()}${scope.slice(1)}.`,
      '',
      `| ${head.join(' | ')} |`,
      `|${head.map((_, i) => (i >= 3 && i <= 4 ? '---:' : '---')).join('|')}|`,
      ...h.rows.map((r) => `| ${cells(r).map((c, i) => (i === 2 && r.status === 'failed' ? `**${mdCell(c)}**` : mdCell(c))).join(' | ')} |`),
    ];
    if (breaking.length) {
      lines.push('', '**Breaking changes**', '');
      for (const r of breaking) {
        for (const m of r.diff!.breakingChanges.slice(0, BREAKING_SHOWN)) lines.push(`- ${mdCode(r.version)} (vs ${mdText(r.diff!.from)}): ${mdCell(m)}`);
        if (r.diff!.breakingChanges.length > BREAKING_SHOWN) lines.push(`- ${mdCode(r.version)}: …and ${r.diff!.breakingChanges.length - BREAKING_SHOWN} more (all in history.json)`);
      }
    }
    if (failed.length) {
      lines.push('', `**Failed** (${failed.length} of ${h.rows.length})`, '');
      for (const g of failureGroups(failed, failure)) lines.push(`- ${mdCode(g.versions)} · ${g.row.reason}${g.row.confidence === 'unsure' ? ' · _unsure_' : ''}: ${mdCell(g.message)}${g.fix ? `<br>**→ Next:** ${mdCell(g.fix)}` : ''}`);
    }
    lines.push('', `**${summary}**`, '', `<sub>${saved.charAt(0).toUpperCase()}${saved.slice(1)}.</sub>`);
    return lines.join('\n');
  }

  const table = [head, ...h.rows.map((r) => cells(r).map(plain))];
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const lines = [
    `toolmenu history  ${plain(h.package)}`,
    `  ${scope}`,
    '',
    ...table.map((row) => '  ' + row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()),
    '',
  ];
  if (breaking.length) {
    lines.push('Breaking changes:');
    for (const r of breaking) {
      for (const m of r.diff!.breakingChanges.slice(0, BREAKING_SHOWN)) lines.push(`  ${plain(r.version)} (vs ${plain(r.diff!.from)}): ${plain(m)}`);
      if (r.diff!.breakingChanges.length > BREAKING_SHOWN) lines.push(`  ${plain(r.version)}: …and ${r.diff!.breakingChanges.length - BREAKING_SHOWN} more (all in history.json)`);
    }
    lines.push('');
  }
  if (failed.length) {
    lines.push(`Failed (${failed.length} of ${h.rows.length}):`);
    for (const g of failureGroups(failed, failure)) {
      lines.push(`  ${plain(g.versions)}  ${g.row.reason}${g.row.confidence === 'unsure' ? ' · unsure' : ''}`);
      lines.push(`      ${plain(g.message)}`);
      if (g.fix) lines.push(`      → Next: ${plain(g.fix)}`);
    }
    lines.push('');
  }
  lines.push(summary, `  ${saved}`);
  return lines.join('\n');
}

/** Breaking changes listed per release in history's text and markdown; the rest are in history.json. */
const BREAKING_SHOWN = 5;

/**
 * Failed versions with the same words and next step, as one entry naming them: "0.2.0, 0.3.0 … 0.4.0 (6 versions)".
 * The words name the version (npm couldn't install pkg@0.2.0), so they're compared, and a
 * group of several shown, with "@<version>" in its place.
 */
function failureGroups(failed: HistoryRow[], failure: (r: HistoryRow) => string): { versions: string; row: HistoryRow; message: string; fix?: string }[] {
  const bare = (text: string, version: string) => text.split(`@${version}`).join('@<version>');
  const groups = new Map<string, HistoryRow[]>();
  for (const r of failed) {
    const key = `${r.reason}\n${bare(failure(r), r.version)}\n${bare(r.fix ?? '', r.version)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((rows) => {
    const row = rows[0];
    const shown = (text: string) => (rows.length === 1 ? text : bare(text, row.version));
    return {
      row,
      message: shown(failure(row)),
      fix: row.fix === undefined ? undefined : shown(row.fix),
      versions: rows.length === 1 ? row.version : rows.length <= 3 ? rows.map((r) => r.version).join(', ') : `${rows[0].version}, ${rows[1].version} … ${rows[rows.length - 1].version} (${rows.length} versions)`,
    };
  });
}

function ghEscape(text: string): string {
  return plain(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
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
      `### toolmenu session: ${mdCode(s.scenario)}`,
      '',
      `${mdCode(s.server.name ?? 'server')} ${mdText(s.server.version ?? '')} · protocol ${mdText(s.server.protocolVersion ?? '?')} · ${s.transport} · ${s.baseline.tools} → ${s.final.tools} tools · ~${s.baseline.tokens.toLocaleString('en-US')} → ~${s.final.tokens.toLocaleString('en-US')} tokens (estimate)`,
      '',
      ...(s.auto ? [...autoSummary(s.auto).map((l, i) => (i === 0 ? `**auto:** ${mdText(l.replace(/^auto: /, ''))}` : `- ${mdText(l.trim())}`)), ''] : []),
      ...(callCounts(s) ? [`**Calls:** ${callCounts(s)}`, ''] : []),
      ...(menuChange(s) ? [`**Menu:** ${menuChange(s)}`, ''] : []),
      ...causes(s.findings, (count, f, where, text) =>
        count ? `**${count}:**` : `- ${f!.severity === 'error' ? '**ERROR**' : LABEL[f!.severity].trim()} \`${f!.rule}\` · ${where} · ${mdCell(text!)}`,
      ),
      '| Step | Menu | list_changed | Scope |',
      '|---|---|---|---|',
      ...s.steps.map((st) => `| ${st.index}. ${mdCell(st.label)} | ${st.status !== 'ok' ? st.status : st.changed ? `changed (${st.tools} tools)` : 'no change'} | ${st.changed ? (st.listChanged ? 'received' : '**missing**') : ''} | ${mdCell(st.scope ?? '')} |`),
      '',
      ...mdFindings(s.findings.map((f) => ({ ...f, message: stepPrefix(f, `Step ${f.step}: `) }))),
    ];
    return lines.join('\n');
  }
  const tok = (n: number) => `~${n.toLocaleString('en-US')}`;
  const lines = [
    `toolmenu session  ${plain(s.scenario)}`,
    `  ${plain(s.server.name ?? 'server')} ${plain(s.server.version ?? '')} · protocol ${plain(s.server.protocolVersion ?? '?')} · ${s.transport}`,
    `  baseline: ${plural(s.baseline.tools, 'tool')} · ${tok(s.baseline.tokens)} tokens (estimate) · listening for list_changed: ${s.listening ? 'yes' : 'no'}`,
    ...(s.auto ? autoSummary(s.auto).map((l, i) => (i === 0 ? `  ${plain(l)}` : `    ${plain(l)}`)) : []),
    ...(callCounts(s) ? [`  calls: ${callCounts(s)}`] : []),
    // Before the first step only: what a fresh one sees after a change is each step's scope.
    `  fresh-${s.transport === 'stdio' ? 'process' : 'connection'} check of the starting menu: ${s.connectionCheck === undefined ? 'not checked' : s.connectionCheck === 'same' ? 'the same' : 'DIFFERENT'}`,
    '',
    ...(menuChange(s) ? [`menu: ${menuChange(s)}`] : []),
    ...causes(s.findings, (count, f, where, text) => (count ? `${count}:` : `  ${LABEL[f!.severity]}  ${f!.rule} · ${where} · ${plain(text!)}`)),
  ];
  const at = (step: number) => s.findings.filter((f) => f.step === step);
  const block = (findings: Finding[]) => {
    for (const f of findings) {
      lines.push(`  ${LABEL[f.severity]}  ${f.rule}${unsureMark(f)}`);
      lines.push(`         ${plain(f.message)}`);
      for (const d of f.detail ?? []) lines.push(`           ${plain(d)}`);
      if (f.fix) lines.push(`         → Next: ${plain(f.fix)}`);
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
      // A tool error or a failure is said in the step's note; an answer otherwise wouldn't be said at all.
      step.outcome === 'answered' ? 'answered' : '',
      step.changed ? `menu changed${delta ? ` · ${delta > 0 ? '+' : '−'}${plural(Math.abs(delta), 'tool')}` : ''}` : step.status === 'ok' ? 'no change' : '',
      step.changed ? (step.listChanged ? 'list_changed received' : 'no list_changed') : '',
      step.scope ? `scope: ${step.scope}` : '',
      plain(step.note ?? ''),
    ].filter(Boolean);
    lines.push(`step ${step.index}: ${plain(step.label)} · ${facts.join(' · ')}`);
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

/**
 * A session's errors and warnings, one line each, before the step log: what to fix
 * without reading every step. `line` renders the count heading (count set) or one
 * finding, info included. Empty when there are no findings.
 */
function causes(findings: Finding[], line: (count: string | undefined, f?: Finding, where?: string, text?: string) => string): string[] {
  // Errors first, info last; the step order within each (the sort is stable).
  const all = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  if (!all.length) return [];
  const c = counts(findings);
  const count = [c.error ? plural(c.error, 'error') : '', c.warn ? plural(c.warn, 'warning') : '', c.info ? `${c.info} info` : ''].filter(Boolean).join(', ');
  const out = [line(count)];
  for (const f of all) {
    const where = f.steps?.length ? stepsText(f.steps) : f.step === 0 ? 'before step 1' : f.step ? `step ${f.step}` : 'the whole run';
    // Without the "Steps 2 and 7: " the line already says.
    const text = lead(f.message.replace(/^Steps? [\d–, and]+: /, ''), 100);
    out.push(line(undefined, f, `${f.confidence === 'unsure' ? 'unsure · ' : ''}${where}`, text));
  }
  return [...out, ''];
}

/**
 * The start of a message, at most `max` characters: up to the last sentence end
 * that fits, or cut with an ellipsis when none does. A sentence end inside quotes
 * or brackets, or after "vs." or "e.g.", isn't one (a server's quoted words).
 */
function lead(text: string, max: number): string {
  if (text.length <= max) return text;
  let depth = 0;
  let straight = false;
  let end = -1;
  for (let i = 0; i < max; i++) {
    const ch = text[i];
    if (ch === '"') straight = !straight;
    else if ('“(['.includes(ch)) depth++;
    else if ('”)]'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === '.' && depth === 0 && !straight && text[i + 1] === ' ' && /[A-Z+~]/.test(text[i + 2] ?? '') && !/\b(vs|e\.g|i\.e|etc)$/i.test(text.slice(0, i))) end = i;
  }
  return end > 0 ? text.slice(0, end + 1) : clip(text, max);
}

/** "menu: 5 → 8 tools (+3) · ~290 → ~479 tokens (+189, estimate) · changed at steps 2, 4, 5 and 7", or nothing when it never changed. */
function menuChange(s: SessionResult): string | undefined {
  const changed = s.steps.filter((st) => st.changed).map((st) => st.index);
  if (!changed.length) return undefined;
  const signed = (n: number) => (n >= 0 ? `+${n.toLocaleString('en-US')}` : `−${Math.abs(n).toLocaleString('en-US')}`);
  const tools = s.final.tools - s.baseline.tools;
  const tokens = s.final.tokens - s.baseline.tokens;
  return `${s.baseline.tools} → ${s.final.tools} tools${tools ? ` (${signed(tools)})` : ''} · ~${s.baseline.tokens.toLocaleString('en-US')} → ~${s.final.tokens.toLocaleString('en-US')} tokens (${signed(tokens)}, estimate) · changed at ${stepsText(changed)}`;
}

/** "calls: 6 · 6 answered, 0 tool errors, 0 failed" (and how many weren't sent), or nothing without call steps. */
function callCounts(s: SessionResult): string | undefined {
  const calls = s.steps.filter((st) => st.outcome);
  if (!calls.length) return undefined;
  const n = (o: string) => calls.filter((st) => st.outcome === o).length;
  const notSent = n('not-sent');
  const stuck = n('needs-input');
  return `${calls.length} · ${n('answered')} answered, ${plural(n('tool-error'), 'tool error')}, ${n('failed')} failed${stuck ? `, ${stuck} never finished (input rounds)` : ''}${notSent ? `, ${notSent} not sent` : ''}`;
}

export function formatPlan(scenario: Scenario, name: string): string {
  const lines = [`toolmenu session --plan  ${name}`, `  allow_writes: ${scenario.allowWrites}${scenario.allowWrites ? '' : ' (tools not marked readOnlyHint will be refused)'}`, ''];
  scenario.steps.forEach((step, i) => lines.push(`step ${i + 1}: ${plain(stepLabel(step))}${step.kind === 'wait_for' ? ` (up to ${step.timeoutMs} ms)` : ''}`));
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

/** Text in a table cell: escaped (sanitize.ts), so a server's words stay words. */
function mdCell(text: string): string {
  return mdText(text, { cell: true });
}

export function mdFindings(findings: Finding[]): string[] {
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
