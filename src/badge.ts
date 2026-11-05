/*
 * The README badge: a shields.io endpoint file (https://shields.io/badges/endpoint-badge)
 * that `snapshot --badge <path>` writes beside the menu file. Committed with the
 * baseline, it changes when the baseline does, so no CI has to commit anything:
 * shields reads it from the repository.
 */
import { execFileSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { counts } from './report.js';
import { repoRoot } from './sarif.js';
import type { Finding, Menu } from './types.js';

export interface Badge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
}

/** "~980", "~4.1K", "~12K": the size people compare, not the exact estimate. */
export function compactTokens(n: number): string {
  if (n < 1000) return `~${n}`;
  const k = n / 1000;
  return `~${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}K`;
}

/** The endpoint JSON: tools and tokens, and the findings that matter (errors, else warnings). */
export function badge(menu: Menu, findings: Finding[]): Badge {
  const c = counts(findings);
  const tools = `${menu.tools.length} tool${menu.tools.length === 1 ? '' : 's'}`;
  const found = c.error ? ` · ${c.error} error${c.error === 1 ? '' : 's'}` : c.warn ? ` · ${c.warn} warning${c.warn === 1 ? '' : 's'}` : '';
  return {
    schemaVersion: 1,
    label: 'toolmenu',
    message: `${tools} · ${compactTokens(menu.totalTokens)} tokens${found}`,
    color: c.error ? 'red' : c.warn ? 'yellow' : 'brightgreen',
    // shields caches for at least 300 s; an hour is plenty for a file that changes with releases.
    cacheSeconds: 3600,
  };
}

/** `owner/repo` of a GitHub remote URL (https or ssh), or undefined. */
export function githubRepo(remote: string): string | undefined {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The README line for a badge file: a shields endpoint badge reading the file from
 * GitHub on the default branch, linking to toolmenu. With no GitHub remote, a
 * template to fill in.
 */
export function badgeMarkdown(badgePath: string, cwd = process.cwd()): string {
  const root = repoRoot(cwd);
  const path = relative(root, resolve(cwd, badgePath)).split(sep).join('/');
  const repo = githubRepo(git(['remote', 'get-url', 'origin'], cwd) ?? '');
  // origin/HEAD names the default branch when the clone recorded it; else the current one.
  const branch = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)?.replace(/^origin\//, '') ?? git(['symbolic-ref', '--short', 'HEAD'], cwd) ?? 'main';
  const raw = `https://raw.githubusercontent.com/${repo ?? '<owner>/<repo>'}/${branch}/${path}`;
  // The badge links to toolmenu: what it is, for whoever clicks it on the README.
  return `[![toolmenu](https://img.shields.io/endpoint?url=${encodeURIComponent(raw)})](https://github.com/niksa90/toolmenu)`;
}
