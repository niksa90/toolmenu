/*
 * JUnit XML output, for CI systems that show test results natively: GitLab merge
 * requests, Jenkins, Azure DevOps, CircleCI, Buildkite and GitHub test-report actions.
 *
 * Each finding is one test case. Findings at or above --fail-on are <failure>s, so the
 * test report agrees with the exit code; findings below it pass, with their text in
 * <system-out>. A run with no findings is one passing case, so the CI system records
 * that the check ran rather than finding an empty report.
 *
 * A case's name is the tool it's about (and which of that rule's findings on that
 * tool), not the message: messages carry counts that change between runs, and CI
 * systems track a test's history by its name.
 */
import { SEVERITY_RANK, type Finding, type Severity } from './types.js';
import { VERSION } from './version.js';

export interface JunitOptions {
  /** snapshot, diff or session: the suite's name. */
  command: string;
  /** Findings at or above this level fail (default: error, as --fail-on). */
  failOn?: Severity;
  /** The menu file or server checked, shown as the suite's property. */
  target?: string;
}

/** Text that is safe inside an XML attribute or element, control characters dropped. */
export function xml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The tools a finding is about: its tool, or each tool of a change found in several. */
function toolsOf(f: Finding): string[] {
  const several = (f as { tools?: unknown }).tools;
  if (Array.isArray(several)) return several.filter((t): t is string => typeof t === 'string');
  return f.tool ? [f.tool] : [];
}

function body(f: Finding): string {
  return [
    f.message,
    ...(f.detail ?? []),
    ...(f.step !== undefined ? [`step: ${f.steps?.length ? f.steps.join(', ') : f.step}`] : []),
    ...(f.fix ? [`→ Next: ${f.fix}`] : []),
    ...(f.confidence === 'unsure' ? ['(unsure: a heuristic, from names and words)'] : []),
    `toolmenu explain ${f.rule}`,
  ].join('\n');
}

export function toJunit(findings: Finding[], options: JunitOptions): string {
  const failOn = options.failOn ?? 'error';
  const suite = `toolmenu ${options.command}`;
  const seen = new Map<string, number>();
  const cases: string[] = [];
  let failures = 0;
  for (const f of findings) {
    const tools = toolsOf(f);
    // One case per tool, as SARIF has one result per tool.
    for (const tool of tools.length ? tools : [undefined]) {
      const key = `${f.rule}\u0000${tool ?? ''}`;
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      const name = `${tool ?? '(menu)'}${nth ? ` #${nth + 1}` : ''}`;
      const open = `    <testcase classname="${xml(`toolmenu.${options.command}.${f.rule}`)}" name="${xml(name)}" time="0">`;
      if (SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) {
        failures++;
        cases.push(`${open}\n      <failure type="${f.severity}" message="${xml(f.message)}">${xml(body(f))}</failure>\n    </testcase>`);
      } else {
        cases.push(`${open}\n      <system-out>${xml(`${f.severity}: ${body(f)}`)}</system-out>\n    </testcase>`);
      }
    }
  }
  if (!cases.length) cases.push(`    <testcase classname="${xml(`toolmenu.${options.command}`)}" name="no findings" time="0"/>`);
  const properties = [
    `      <property name="toolmenu.version" value="${xml(VERSION)}"/>`,
    `      <property name="fail-on" value="${failOn}"/>`,
    ...(options.target ? [`      <property name="target" value="${xml(options.target)}"/>`] : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="toolmenu" tests="${cases.length}" failures="${failures}" errors="0" time="0">`,
    `  <testsuite name="${xml(suite)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="0" time="0">`,
    '    <properties>',
    ...properties,
    '    </properties>',
    ...cases,
    '  </testsuite>',
    '</testsuites>',
  ].join('\n');
}
