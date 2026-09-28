import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Target } from './connect.js';
import { VERSION } from './version.js';

export type ProjectKind = 'node' | 'python' | 'go' | 'rust' | 'unknown';

export interface Project {
  kind: ProjectKind;
  /** The steps that install and build the server in CI, as YAML list items. */
  setup: string[];
}

/** What the repository in `dir` looks like, and how CI gets it ready to run. */
export function detectProject(dir: string): Project {
  const has = (f: string) => existsSync(join(dir, f));
  if (has('package.json')) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      // an unreadable package.json still means node
    }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : has('package-lock.json') ? 'npm ci' : 'npm install';
    const run = pm === 'npm' ? 'npm run' : pm;
    return {
      kind: 'node',
      setup: [
        ...(pm === 'pnpm' ? ['- uses: pnpm/action-setup@v6'] : []),
        '- uses: actions/setup-node@v7',
        `  with: { node-version: 22${pm === 'npm' ? '' : `, cache: ${pm}`} }`,
        `- run: ${install}${scripts.build ? ` && ${run} build` : ''}`,
      ],
    };
  }
  if (has('pyproject.toml') || has('requirements.txt')) {
    const uv = has('uv.lock');
    return {
      kind: 'python',
      setup: uv
        ? ['- uses: astral-sh/setup-uv@v10', '- run: uv sync']
        : ['- uses: actions/setup-python@v7', "  with: { python-version: '3.12' }", `- run: pip install ${has('pyproject.toml') ? '.' : '-r requirements.txt'}`],
    };
  }
  if (has('go.mod')) return { kind: 'go', setup: ['- uses: actions/setup-go@v7', "  with: { go-version-file: go.mod }", '- run: go build ./...'] };
  if (has('Cargo.toml')) return { kind: 'rust', setup: ['- run: cargo build --release'] };
  return { kind: 'unknown', setup: ['# TODO: install and build your server here'] };
}

/** An env var whose value is a credential: goes into the workflow as a secret, never as a value. */
export function looksSecret(key: string): boolean {
  return /token|secret|password|passwd|api[_-]?key|(^|_)key$|credential|auth/i.test(key);
}

export interface WorkflowOptions {
  target: Target;
  project: Project;
  /** Also run `session --auto` (calls read-only tools with the job's credentials). */
  session?: boolean;
  baseline?: string;
}

/** The workflow file, as text. Credentials appear only as ${{ secrets.NAME }}. */
export function workflowYaml(opts: WorkflowOptions): string {
  const t = opts.target;
  const lines = [
    '# Written by `toolmenu init`. On every pull request: snapshot the tool menu this',
    '# change produces, diff it against the committed baseline, and post one comment.',
    '# https://github.com/niksa90/toolmenu',
    'name: toolmenu',
    'on: pull_request',
    'permissions:',
    '  contents: read',
    '  pull-requests: write',
    'jobs:',
    '  toolmenu:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v7',
    ...(t.kind === 'stdio' ? opts.project.setup.map((l) => `      ${l}`) : []),
    `      - uses: niksa90/toolmenu@v${VERSION}`,
    '        with:',
  ];
  if (t.kind === 'stdio') {
    lines.push(`          command: ${yamlString([t.command, ...t.args].map(shellWord).join(' '))}`);
    const env = Object.keys(t.env ?? {});
    if (env.length) {
      lines.push('          env: |');
      for (const k of env) lines.push(`            ${k}=${looksSecret(k) ? `\${{ secrets.${k} }}` : t.env![k]}`);
    }
  } else {
    lines.push(`          url: ${yamlString(t.url)}   # checks the server at this URL, not this PR's code: see docs/github-action.md`);
    const headers = Object.keys(t.headers ?? {});
    if (headers.length) {
      lines.push('          headers: |');
      for (const h of headers) lines.push(`            ${h}: \${{ secrets.${secretName(h)} }}`);
    }
  }
  lines.push(`          baseline: ${opts.baseline ?? 'menu.json'}`);
  if (opts.session) lines.push('          scenario: auto     # also call read-only tools and watch the menu');
  return lines.join('\n') + '\n';
}

/** The secret names the workflow refers to, to tell the user what to add. */
export function secretsNeeded(target: Target): string[] {
  if (target.kind === 'stdio') return Object.keys(target.env ?? {}).filter(looksSecret);
  return Object.keys(target.headers ?? {}).map(secretName);
}

function secretName(header: string): string {
  return 'MCP_' + header.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function shellWord(w: string): string {
  return /^[\w./:=@%+-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

function yamlString(s: string): string {
  return /^[\w./:@%+ =-]+$/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/: |\s#/.test(s) ? s : JSON.stringify(s);
}
