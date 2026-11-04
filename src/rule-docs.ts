/*
 * `toolmenu explain <rule>`: one entry of docs/RULES.md, which the build copies to
 * dist/rule-docs.json (docs/ isn't in the npm package).
 */
import { readFileSync } from 'node:fs';
import { DIFF_RULES } from './diff.js';
import { MENU_RULES } from './rules/index.js';

export interface RuleDoc {
  command: string;
  severity: string;
  text: string;
}

let cache: Record<string, RuleDoc> | undefined;

export function ruleDocs(): Record<string, RuleDoc> {
  cache ??= JSON.parse(readFileSync(new URL('./rule-docs.json', import.meta.url), 'utf8')) as Record<string, RuleDoc>;
  return cache;
}

/** Markdown out of a table cell, for a terminal: `code` and **bold** as plain words. */
function plain(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/**
 * The rule a name means: the id itself, or the part after the slash when only one
 * rule ends that way (vague-id → naming/vague-id). Otherwise the ids close to it.
 */
export function findRule(name: string): { id: string } | { near: string[] } {
  const docs = ruleDocs();
  const wanted = name.trim().toLowerCase();
  if (Object.hasOwn(docs, wanted)) return { id: wanted };
  const ids = Object.keys(docs);
  const tail = ids.filter((id) => id.split('/')[1] === wanted);
  if (tail.length === 1) return { id: tail[0] };
  if (tail.length > 1) return { near: tail };
  const scored = ids
    .map((id) => ({ id, d: Math.min(distance(wanted, id), distance(wanted, id.split('/')[1]) + (wanted.includes('/') ? 99 : 0)) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(wanted.length / 4)));
  const contains = ids.filter((id) => wanted.length >= 3 && id.includes(wanted));
  const near = [...new Set([...scored.sort((a, b) => a.d - b.d).map((x) => x.id), ...contains])];
  return { near: near.slice(0, 5) };
}

export interface Explained extends RuleDoc {
  rule: string;
  /** diff rules: what the change means for semver. */
  class?: string;
  /** Menu rules: the protocol version the rule applies from. */
  since?: string;
}

export function explain(id: string): Explained {
  const doc = ruleDocs()[id];
  const menu = MENU_RULES.find((r) => r.id === id);
  const diff = Object.hasOwn(DIFF_RULES, id) ? DIFF_RULES[id] : undefined;
  return {
    rule: id,
    ...doc,
    severity: doc.severity.replace(/ \((?:breaking|minor|notice)\)$/, ''),
    ...(diff?.class ? { class: diff.class } : {}),
    ...(menu?.since ? { since: menu.since } : {}),
  };
}

export function formatExplained(e: Explained): string {
  return [
    `${e.rule}  (${e.command}, ${e.severity}${e.class ? `, ${e.class}` : ''})`,
    '',
    ...wrap(plain(e.text), 86, '  '),
    ...(e.since ? ['', `  Checked on servers that speak ${e.since} or later.`] : []),
    '',
    `  Change its level, or turn it off, in toolmenu.config.json:`,
    `    { "rules": { "${e.rule}": "off" } }   (or "error", "warn", "info")`,
    '',
  ].join('\n');
}

/** `toolmenu explain` with no rule: every id, by command. */
export function listRules(): string {
  const by = new Map<string, string[]>();
  for (const [id, doc] of Object.entries(ruleDocs())) by.set(doc.command, [...(by.get(doc.command) ?? []), id]);
  const out = ['Rules, by the command that reports them. toolmenu explain <rule> says what one checks.', ''];
  for (const [command, ids] of by) out.push(`${command}:`, ...wrap(ids.join(' '), 86, '  '), '');
  return out.join('\n');
}
