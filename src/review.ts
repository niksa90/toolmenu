/*
 * toolmenu review: should this new menu file replace the committed baseline?
 *
 * `diff` says what changed between two menus. Accepting a new baseline is a further
 * question: did the menu get worse for agents (findings it didn't have), better
 * (findings gone), or break callers without a release that allows it? `review`
 * answers that from the two files alone, with one verdict and an exit code to match.
 */
import { diffMenus, type DiffFinding, type DiffOptions, type DiffResult } from './diff.js';
import { MENU_RULES, runRules, type RuleSettings } from './rules/index.js';
import { SEVERITY_RANK, type Finding, type Menu, type Severity } from './types.js';
import { bumpVerdict, classLine, counts, findingLines, mdFindings, releasePair, signed, type Format } from './report.js';
import { mdCode, mdText, plain } from './sanitize.js';

/**
 * - `unchanged`: the same menu, the same findings.
 * - `safe`: nothing breaks callers and no finding at or above --fail-on is new.
 * - `breaking-released`: breaking changes, and the release versions given allow them.
 * - `breaking`: breaking changes, and no release that allows them (none given, too small, or not checkable).
 * - `review`: nothing breaks, but the new menu has findings at or above --fail-on the old one didn't,
 *   or diff's own checks (token budget, version bump) fail.
 */
export type Verdict = 'unchanged' | 'safe' | 'breaking-released' | 'breaking' | 'review';

export interface ReviewResult {
  verdict: Verdict;
  /** Whether the new baseline can be accepted as it is: the exit code is 0 when true. */
  accept: boolean;
  diff: DiffResult;
  findings: {
    /** In the new menu only. */
    introduced: Finding[];
    /** In the old menu only. */
    resolved: Finding[];
    /**
     * In both, for the same rule, but saying something else: a summary that now lists
     * more tools, one tool's finding that became a summary. `worse`: louder, or now
     * naming a tool the old one didn't; counted with the new findings for the verdict.
     */
    changed: { before: Finding; after: Finding; worse: boolean }[];
    /** In both, unchanged. */
    kept: number;
  };
  tools: { before: number; after: number };
}

export interface ReviewOptions extends DiffOptions, RuleSettings {
  failOn?: Severity;
}

// Rules that read the wire (the raw tools/list pages, the handshake), which a menu
// file doesn't hold: run on a file they'd say the same about both menus, or nothing true.
const WIRE_ONLY = new Set(['spec/schema', 'spec/discover', 'lists/resource-unreadable', 'lists/resource-read-schema', 'lists/resource-unread']);
// diff findings that say what it couldn't compare, not what changed.
const NOT_COMPARED = new Set(['diff/lists-unread', 'diff/catalog-queries']);

/** The menu rules on a menu file, as far as a file can tell: no second list, no probes. */
export function fileFindings(menu: Menu, settings: RuleSettings = {}): Finding[] {
  return runRules(
    MENU_RULES,
    { menu, pages: [], capabilities: { tools: {} }, usedAuth: false, protocolVersion: menu.server.protocolVersion, era: menu.server.era },
    settings,
  ).filter((f) => !WIRE_ONLY.has(f.rule));
}

/** A finding's identity across two menus: its rule, and the tool or tools it's about. */
function key(f: Finding): string {
  const tools = (f as DiffFinding).tools;
  return `${f.rule}\0${f.tool ?? (tools ? tools.join(',') : '')}`;
}
const said = (f: Finding) => JSON.stringify([f.severity, f.message, f.detail ?? []]);

export function reviewMenus(before: Menu, after: Menu, options: ReviewOptions = {}): ReviewResult {
  const failOn = options.failOn ?? 'error';
  const atLeast = (f: Finding) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn];
  const diff = diffMenus(before, after, options);
  const settings = { rules: options.rules, ignore: options.ignore };
  const old = fileFindings(before, settings);
  const now = fileFindings(after, settings);

  // Matched by rule and tool first; what's left of a rule on both sides is the same
  // finding said differently (one tool's finding became a summary of two).
  const oldBy = new Map<string, Finding[]>();
  for (const f of old) oldBy.set(key(f), [...(oldBy.get(key(f)) ?? []), f]);
  const unmatched: Finding[] = [];
  const changed: { before: Finding; after: Finding; worse: boolean }[] = [];
  let kept = 0;
  for (const f of now) {
    const match = oldBy.get(key(f))?.shift();
    if (!match) unmatched.push(f);
    else if (said(match) === said(f)) kept++;
    else changed.push({ before: match, after: f, worse: false });
  }
  const left = [...oldBy.values()].flat();
  const introduced: Finding[] = [];
  for (const f of unmatched) {
    const i = left.findIndex((o) => o.rule === f.rule);
    if (i === -1) introduced.push(f);
    else changed.push({ before: left.splice(i, 1)[0], after: f, worse: false });
  }
  const resolved = left;
  // A changed finding is worse when it's louder, or now names a tool the old one didn't.
  const names = after.tools.map((t) => t.name);
  const text = (f: Finding) => [f.message, ...(f.detail ?? []), f.tool ?? '', ...((f as DiffFinding).tools ?? [])].join('\n');
  const mentions = (f: Finding) => new Set(names.filter((n) => new RegExp(`(?<![\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text(f))));
  const grew = (c: { before: Finding; after: Finding }): boolean => {
    if (SEVERITY_RANK[c.after.severity] > SEVERITY_RANK[c.before.severity]) return true;
    const had = mentions(c.before);
    return [...mentions(c.after)].some((n) => !had.has(n));
  };

  const breaking = diff.findings.filter((f) => f.class === 'breaking' && atLeast(f));
  // The release allows the breaking changes when its bump was checked and is big enough.
  const released = diff.actualBump !== undefined && diff.releaseAs === undefined && !diff.bumpNotChecked;
  // diff's own checks that aren't changes to the menu: the token budget, the version bump.
  const checks = diff.findings.filter((f) => f.class === undefined && atLeast(f));
  for (const c of changed) c.worse = grew(c);
  const worse = [...introduced, ...changed.filter((c) => c.worse).map((c) => c.after)].filter(atLeast);

  let verdict: Verdict;
  if (breaking.length) verdict = released ? 'breaking-released' : 'breaking';
  else if (worse.length || checks.length) verdict = 'review';
  // Notes that something wasn't compared (lists read on one side only) aren't changes.
  else if (!diff.findings.some((f) => !NOT_COMPARED.has(f.rule)) && !introduced.length && !resolved.length && !changed.length && diff.tokens.delta === 0) verdict = 'unchanged';
  else verdict = 'safe';
  // A released breaking change still needs the rest to be clean.
  const accept = verdict === 'unchanged' || verdict === 'safe' || (verdict === 'breaking-released' && !worse.length && !checks.length);

  return { verdict, accept, diff, findings: { introduced, resolved, changed, kept }, tools: { before: before.tools.length, after: after.tools.length } };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function verdictLine(r: ReviewResult, failOn: Severity): { mark: string; text: string } {
  const b = r.diff.classes.breaking.changes;
  const worse = [...r.findings.introduced, ...r.findings.changed.filter((c) => c.worse).map((c) => c.after)].filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]).length;
  switch (r.verdict) {
    case 'unchanged':
      return { mark: '✓', text: 'unchanged: the same menu and the same findings. Nothing to accept.' };
    case 'safe':
      return { mark: '✓', text: 'safe to accept: nothing breaks callers, and no new finding at or above ' + failOn + '.' };
    case 'breaking-released':
      return r.accept
        ? { mark: '✓', text: `accept with the release: ${plural(b, 'breaking change')}, and the release's ${r.diff.actualBump} bump allows ${b === 1 ? 'it' : 'them'}.` }
        : { mark: '✗', text: `${plural(b, 'breaking change')} the release allows, but ${worse ? plural(worse, 'new finding') : "diff's own checks"} at or above ${failOn} too.` };
    case 'breaking':
      return {
        mark: '✗',
        text: `don't accept as is: ${plural(b, 'breaking change')}, and ${
          r.diff.releaseAs ? `the release's ${r.diff.actualBump} bump is too small (release ${r.diff.releaseAs})` : r.diff.bumpNotChecked ? `the bump wasn't checked (${r.diff.bumpNotChecked})` : 'no release versions to check them against (--release old..new)'
        }.`,
      };
    case 'review':
      return { mark: '!', text: `review before accepting: nothing breaks callers, but ${worse ? `${plural(worse, 'finding')} at or above ${failOn} ${worse === 1 ? 'is' : 'are'} new` : "diff's own checks fail"}.` };
  }
}

function nextStep(r: ReviewResult, paths: [string, string]): string {
  const [base, next] = paths.map(plain);
  switch (r.verdict) {
    case 'unchanged':
      return 'Nothing to do.';
    case 'safe':
    case 'breaking-released':
      return r.accept ? `Commit ${next} as ${base}.` : 'Fix the new findings, or turn their rules down in toolmenu.config.json if they are expected, then review again.';
    case 'breaking':
      return r.diff.releaseAs ? `Release it as ${r.diff.releaseAs}, or keep the old shape for one more release. Then review again with --release.` : 'Keep the old shape for one more release, or pass the release versions (--release old..new) for a major release.';
    case 'review':
      return 'Fix the new findings, or turn their rules down in toolmenu.config.json if they are expected, then review again.';
  }
}

export function formatReview(r: ReviewResult, paths: [string, string], format: Format, failOn: Severity = 'error'): string {
  const f = r.findings;
  if (format === 'json') {
    const v = verdictLine(r, failOn);
    return JSON.stringify(
      {
        command: 'review',
        verdict: r.verdict,
        accept: r.accept,
        // The verdict and next step as the text report says them, for a PR comment or a log line.
        summary: `${v.mark} ${v.text}`,
        next: nextStep(r, paths),
        baseline: paths[0],
        candidate: paths[1],
        tools: r.tools,
        counts: { introduced: f.introduced.length, resolved: f.resolved.length, changed: f.changed.length, worse: f.changed.filter((c) => c.worse).length, kept: f.kept },
        findings: f,
        diff: { ...r.diff, counts: counts(r.diff.findings) },
      },
      null,
      2,
    );
  }
  const v = verdictLine(r, failOn);
  const d = r.diff;
  const breaking = d.findings.filter((x) => x.class === 'breaking');
  const otherDiff = d.findings.filter((x) => x.class !== 'breaking');
  const name = d.after.name ?? d.before.name ?? 'server';
  const findingsLine = `${f.introduced.length} new · ${f.resolved.length} gone · ${f.changed.length} changed · ${f.kept} unchanged`;
  const toolsLine = `${r.tools.before} → ${r.tools.after}`;
  const tokens = `~${d.tokens.before.toLocaleString('en-US')} → ~${d.tokens.after.toLocaleString('en-US')} (${signed(d.tokens.delta)}, estimate)`;

  if (format === 'markdown' || format === 'github') {
    const lines = [
      `### toolmenu review: ${mdCode(paths[1])} as the new ${mdCode(paths[0])}`,
      '',
      `**${v.mark} ${mdText(v.text)}**`,
      '',
      `| | |`,
      `|---|---|`,
      `| Server | ${mdCode(name, { cell: true })} ${releasePair(d, true)} |`,
      `| Changes | ${classLine(d)} |`,
      `| Version | ${bumpVerdict(d, true).line} |`,
      `| Tokens | ${tokens} |`,
      `| Tools | ${toolsLine} |`,
      `| Findings | ${findingsLine} |`,
      '',
    ];
    if (breaking.length) lines.push(`#### Breaking (${breaking.length})`, '', ...mdFindings(breaking), '');
    if (f.introduced.length) lines.push(`#### New findings (${f.introduced.length})`, '', ...mdFindings(f.introduced), '');
    if (f.changed.length) lines.push(`#### Changed findings (${f.changed.length})`, '', ...mdFindings(f.changed.map((c) => c.after)), '');
    if (f.resolved.length) lines.push(`<details><summary>Findings gone (${f.resolved.length})</summary>`, '', ...mdFindings(f.resolved), '', '</details>', '');
    if (otherDiff.length) lines.push(`<details><summary>Other changes (${otherDiff.length})</summary>`, '', ...mdFindings(otherDiff), '', '</details>', '');
    lines.push(`**→ Next:** ${mdText(nextStep(r, paths))}`);
    return lines.join('\n');
  }

  const lines = [
    `toolmenu review  ${plain(paths[1])} as the new ${plain(paths[0])}`,
    `  verdict   ${v.mark} ${v.text}`,
    `  server    ${plain(name)} ${releasePair(d)}`,
    `  changes   ${classLine(d)}`,
    `  version   ${bumpVerdict(d).line}`,
    `  tokens    ${tokens}`,
    `  tools     ${toolsLine}`,
    `  findings  ${findingsLine}`,
    '',
  ];
  const section = (title: string, list: Finding[]) => {
    if (list.length) lines.push(`${title}:`, ...findingLines(list).map((l) => (l ? `  ${l}` : l)));
  };
  section('Breaking changes', breaking);
  section('New findings', f.introduced);
  section('Changed findings, as they are now (worse: louder or about more tools)', f.changed.filter((c) => c.worse).map((c) => c.after));
  section('Changed findings, as they are now', f.changed.filter((c) => !c.worse).map((c) => c.after));
  if (f.resolved.length) lines.push('Findings gone:', ...f.resolved.map((x) => `  ${x.rule}${x.tool ? `  ${plain(x.tool)}` : ''}`), '');
  if (otherDiff.length) lines.push(`Other changes: ${plural(otherDiff.length, 'finding')} from diff (toolmenu diff ${plain(paths[0])} ${plain(paths[1])} lists them).`, '');
  lines.push(`→ Next: ${nextStep(r, paths)}`);
  return lines.join('\n');
}
