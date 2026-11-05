/*
 * SARIF 2.1.0 output, for GitHub code scanning and other SARIF viewers.
 *
 * toolmenu's findings are about tools in a menu, not lines of source, so each result
 * points at the menu file in the repository (the committed baseline, or the one this
 * command wrote) and, when the finding names a tool, at the line where that tool
 * starts. A tool the file doesn't have (new since the baseline) points at line 1.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { ruleDocs } from './rule-docs.js';
import type { Finding, Severity } from './types.js';
import { VERSION } from './version.js';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { error: 'error', warn: 'warning', info: 'note' };
const RULES_URL = 'https://github.com/niksa90/toolmenu/blob/main/docs/RULES.md';

export interface SarifOptions {
  /** snapshot, diff or session: the run's category, so code scanning keeps them apart. */
  command: string;
  /** The menu file results point at, as a path from the working directory. */
  menuPath?: string;
  /** Where paths are made relative to: the repository root (default: found from the working directory). */
  root?: string;
}

/** The repository root: the nearest folder up from `from` with a .git, or `from` itself. */
export function repoRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

/** The line of each tool's "name" in a menu file written by toolmenu (1-based). */
export function toolLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  const all = text.split(/\r?\n/);
  const start = all.findIndex((l) => /^\s*"tools":\s*\[/.test(l));
  if (start === -1) return lines;
  // A tool's own "name" is the first key of its object, one level inside the array.
  for (let i = start + 1; i < all.length; i++) {
    const m = /^ {6}"name":\s*("(?:[^"\\]|\\.)*")/.exec(all[i]);
    if (m) {
      const name = JSON.parse(m[1]) as string;
      if (!lines.has(name)) lines.set(name, i + 1);
    }
    if (/^ {2}\]/.test(all[i])) break;
  }
  return lines;
}

/** The tools a finding is about: its tool, or each tool of a change found in several. */
function toolsOf(f: Finding): string[] {
  const several = (f as { tools?: unknown }).tools;
  if (Array.isArray(several)) return several.filter((t): t is string => typeof t === 'string');
  return f.tool ? [f.tool] : [];
}

/** A stable identity for a result across runs: rule and tool, not the message (it carries counts). */
function fingerprint(f: Finding, tool: string | undefined): string {
  return createHash('sha256').update(`${f.rule}\u0000${tool ?? ''}`).digest('hex').slice(0, 32);
}

export function toSarif(findings: Finding[], options: SarifOptions): string {
  const root = options.root ?? repoRoot();
  let uri: string | undefined;
  let lines = new Map<string, number>();
  if (options.menuPath) {
    const abs = resolve(options.menuPath);
    uri = relative(root, abs).split(sep).join('/');
    if (uri.startsWith('..')) uri = abs.split(sep).join('/');
    try {
      lines = toolLines(readFileSync(abs, 'utf8'));
    } catch {
      // Not written (--no-write) or unreadable: results point at the file's first line.
    }
  }
  const docs = ruleDocs();
  const ruleIds = [...new Set(findings.map((f) => f.rule))].sort();
  const results = findings.flatMap((f) => {
    const tools = toolsOf(f);
    // One result per tool, so each alert sits on its own tool's line.
    return (tools.length ? tools : [undefined]).map((tool) => {
      const text = [f.message, ...(f.detail ?? []), ...(f.fix ? [`→ Next: ${f.fix}`] : [])].join('\n');
      return {
        ruleId: f.rule,
        ruleIndex: ruleIds.indexOf(f.rule),
        level: LEVEL[f.severity],
        message: { text: f.confidence === 'unsure' ? `${text}\n(unsure: a heuristic, from names and words)` : text },
        ...(uri ? { locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' }, region: { startLine: (tool && lines.get(tool)) || 1 } } }] } : {}),
        partialFingerprints: { 'toolmenuFinding/v1': fingerprint(f, tool) },
        properties: { ...(tool ? { tool } : {}), ...(f.step !== undefined ? { step: f.step } : {}), ...(f.confidence ? { confidence: f.confidence } : {}) },
      };
    });
  });
  const log = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'toolmenu',
            version: VERSION,
            semanticVersion: VERSION,
            informationUri: 'https://github.com/niksa90/toolmenu',
            rules: ruleIds.map((id) => {
              const doc = docs[id];
              // RULES.md gives a default, sometimes with conditions ("warn, error if no call got through"): its first word.
              const documented = /^(error|warn|info)\b/.exec(doc?.severity ?? '')?.[1] as Severity | undefined;
              const severity = documented ?? findings.find((f) => f.rule === id)?.severity ?? 'warn';
              return {
                id,
                name: id.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')),
                shortDescription: { text: id },
                ...(doc ? { fullDescription: { text: doc.text } } : {}),
                helpUri: RULES_URL,
                help: { text: `toolmenu explain ${id}` },
                defaultConfiguration: { level: LEVEL[severity] },
                properties: { tags: ['mcp', doc?.command ?? options.command] },
              };
            }),
          },
        },
        automationDetails: { id: `toolmenu/${options.command}/` },
        originalUriBaseIds: { '%SRCROOT%': { uri: `file://${root.split(sep).join('/')}/` } },
        results,
      },
    ],
  };
  return JSON.stringify(log, null, 2);
}
