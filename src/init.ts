import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Target } from './connect.js';
import { VERSION } from './version.js';

export type ProjectKind = 'node' | 'python' | 'go' | 'rust' | 'unknown';

export interface Project {
  kind: ProjectKind;
  /** The steps that install and build the server in CI, as YAML list items. */
  setup: string[];
  /** The project file that told the kind apart, relative to the repository root ('' when unknown). */
  file: string;
  /** The folder the build runs in, relative to the repository root ('' is the root). */
  dir: string;
  /** The commands the setup runs, for the summary. */
  runs: string[];
  /**
   * The folders the setup fills on the runner, relative to the root: an ignored file
   * under one is made there. A build's output can be anywhere in its folder, so a
   * build step adds the folder itself ('' is the whole repository).
   */
  creates: string[];
}

/**
 * What the project in `dir` looks like, and how CI gets it ready to run. `root` is
 * the repository root: CI works from there, so steps for a project in a subfolder
 * get a working-directory, and lockfiles are also looked for in the folders between
 * (a workspace's lockfile sits at its root, above the package).
 */
export function detectProject(dir: string, root: string = dir): Project {
  const rel = posix(relative(root, dir));
  const has = (f: string) => existsSync(join(dir, f));
  const at = (d: string, f: string) => (d ? `${d}/${f}` : f);
  const step = (cmd: string, wd: string) => [`- run: ${cmd}`, ...(wd ? [`  working-directory: ${wd}`] : [])];
  // The nearest folder from dir up to root that has one of these files.
  const findUp = (files: string[]): { dir: string; file: string } | undefined => {
    for (let d = dir; ; d = dirname(d)) {
      const file = files.find((f) => existsSync(join(d, f)));
      if (file) return { dir: posix(relative(root, d)), file };
      if (d === root || dirname(d) === d || !isInside(root, d)) return undefined;
    }
  };
  if (has('package.json')) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      // an unreadable package.json still means node
    }
    // A lockfile above the package counts only for a workspace that includes it:
    // a root package.json for tooling has its own, and installing there leaves
    // this package's node_modules empty.
    let lock: { dir: string; file: string } | undefined;
    for (let d = dir; !lock; d = dirname(d)) {
      const file = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find((f) => existsSync(join(d, f)));
      if (file && (d === dir || inWorkspace(d, posix(relative(d, dir)), file))) lock = { dir: posix(relative(root, d)), file };
      if (d === root || dirname(d) === d || !isInside(root, d)) break;
    }
    const pm = lock?.file === 'pnpm-lock.yaml' ? 'pnpm' : lock?.file === 'yarn.lock' ? 'yarn' : 'npm';
    const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : lock ? 'npm ci' : 'npm install';
    const build = scripts.build ? `${pm === 'npm' ? 'npm run' : pm} build` : undefined;
    const installDir = lock ? lock.dir : rel;
    // setup-node looks for the lockfile at the root unless told where it is.
    const cache = pm === 'npm' ? '' : `, cache: ${pm}${lock && lock.dir ? `, cache-dependency-path: ${at(lock.dir, lock.file)}` : ''}`;
    const runs = installDir === rel ? [build ? `${install} && ${build}` : install] : build ? [install, build] : [install];
    return {
      kind: 'node',
      file: at(rel, 'package.json'),
      dir: rel,
      runs,
      creates: [...new Set([at(installDir, 'node_modules'), at(rel, 'node_modules'), ...(build ? [rel] : [])])],
      setup: [
        ...(pm === 'pnpm' ? ['- uses: pnpm/action-setup@v6'] : []),
        '- uses: actions/setup-node@v7',
        `  with: { node-version: 22${cache} }`,
        ...(installDir === rel ? step(runs[0], rel) : [...step(install, installDir), ...(build ? step(build, rel) : [])]),
      ],
    };
  }
  if (has('pyproject.toml') || has('requirements.txt')) {
    // A uv workspace keeps one uv.lock at its root; uv sync in a member finds it.
    const uvLock = findUp(['uv.lock']);
    const uv = !!uvLock;
    const run = uv ? 'uv sync' : `pip install ${has('pyproject.toml') ? '.' : '-r requirements.txt'}`;
    return {
      kind: 'python',
      file: at(rel, has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt'),
      dir: rel,
      runs: [run],
      // uv sync makes the workspace's .venv; pip installs into the runner's Python.
      creates: uvLock ? [at(uvLock.dir, '.venv')] : [],
      // setup-uv has no floating major tag (v10): only full versions resolve.
      setup: uv
        ? ['- uses: astral-sh/setup-uv@v10.2.0', ...step(run, rel)]
        : ['- uses: actions/setup-python@v7', "  with: { python-version: '3.12' }", ...step(run, rel)],
    };
  }
  if (has('go.mod')) {
    // go build ./... keeps no binary unless it matches one main package: nothing counted.
    return { kind: 'go', file: at(rel, 'go.mod'), dir: rel, runs: ['go build ./...'], creates: [], setup: ['- uses: actions/setup-go@v7', `  with: { go-version-file: ${at(rel, 'go.mod')} }`, ...step('go build ./...', rel)] };
  }
  if (has('Cargo.toml')) return { kind: 'rust', file: at(rel, 'Cargo.toml'), dir: rel, runs: ['cargo build --release'], creates: [at(rel, 'target')], setup: step('cargo build --release', rel) };
  return { kind: 'unknown', file: '', dir: rel, runs: [], creates: [], setup: [`# TODO: install and build your server here${rel ? ` (it lives in ${rel})` : ''}`] };
}

/**
 * Whether the package at `pkg` (relative to `wsDir`, never '') is a member of the
 * workspace at `wsDir`: pnpm-workspace.yaml for pnpm's lockfile, the root
 * package.json's "workspaces" for npm's and yarn's.
 */
function inWorkspace(wsDir: string, pkg: string, lockfile: string): boolean {
  let globs: unknown;
  try {
    globs =
      lockfile === 'pnpm-lock.yaml'
        ? (parseYaml(readFileSync(join(wsDir, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: unknown } | null)?.packages
        : (({ workspaces: w }) => (Array.isArray(w) ? w : (w as { packages?: unknown } | undefined)?.packages))(
            JSON.parse(readFileSync(join(wsDir, 'package.json'), 'utf8')) as { workspaces?: unknown },
          );
  } catch {
    return false;
  }
  if (!Array.isArray(globs)) return false;
  let member = false;
  for (const g of globs) {
    if (typeof g !== 'string') continue;
    const neg = g.startsWith('!');
    if (globToRegExp(neg ? g.slice(1) : g).test(pkg)) member = !neg;
  }
  return member;
}

/** A workspace glob (`packages/*`, `apps/**`, `./server`) as a whole-path RegExp. */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * The repository secret an env var's value goes into. Every value is a secret: a
 * name doesn't say whether its value is a credential (DATABASE_URL, SENTRY_DSN and
 * GITHUB_PAT carry one, and no pattern on names catches them all). GitHub keeps
 * GITHUB_* for itself (secrets.GITHUB_TOKEN is the job's own token), so those get a prefix.
 */
export function envSecretName(key: string): string {
  const name = key.toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  return /^(GITHUB_|[0-9])/.test(name) ? `MCP_${name}` : name;
}

export interface WorkflowOptions {
  target: Target;
  project: Project;
  /** Also run `session --auto` (calls read-only tools with the job's credentials). */
  session?: boolean;
  /** The baseline, relative to the repository root. */
  baseline?: string;
  /** The folder the server starts in, relative to the repository root ('' or undefined: the root). */
  serverDir?: string;
}

/** The workflow file, as text. Env and header values appear only as ${{ secrets.NAME }}. */
export function workflowYaml(opts: WorkflowOptions): string {
  const t = opts.target;
  const serverDir = opts.serverDir ?? '';
  const baseline = opts.baseline ?? 'menu.json';
  const lines = [
    '# Written by `toolmenu init`. On every pull request: snapshot the tool menu this',
    '# change produces, diff it against the committed baseline, and post one comment.',
    '# https://github.com/niksa90/toolmenu',
    ...(t.kind === 'stdio' && serverDir ? [`# The server starts in ${serverDir}/, where init ran; paths in "command" are relative to it.`] : []),
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
    lines.push(`          command: ${yamlString(ciCommand(t, serverDir))}`);
    const env = Object.keys(t.env ?? {});
    if (env.length) {
      lines.push('          env: |');
      for (const k of env) lines.push(`            ${k}=\${{ secrets.${envSecretName(k)} }}`);
    }
  } else {
    lines.push(`          url: ${yamlString(t.url)}   # checks the server at this URL, not this PR's code: see docs/github-action.md`);
    const headers = Object.keys(t.headers ?? {});
    if (headers.length) {
      lines.push('          headers: |');
      for (const h of headers) lines.push(`            ${h}: \${{ secrets.${secretName(h)} }}`);
    }
  }
  lines.push(`          baseline: ${yamlString(baseline)}`);
  // The version check reads package.json, pyproject.toml or Cargo.toml at the repo
  // root; a server in a subfolder has its own, so the root's would be the wrong one.
  if (t.kind === 'stdio' && opts.project.dir && ['node', 'python', 'rust'].includes(opts.project.kind)) {
    lines.push(`          release: 'off'     # auto reads the version at the repo root, not ${opts.project.file}: set "<old>..<new>" in a release PR`);
  }
  if (opts.session) lines.push('          scenario: auto     # also call read-only tools and watch the menu');
  return lines.join('\n') + '\n';
}

/** The `command` input: the server started from serverDir, as the Action's shell runs it. */
function ciCommand(t: Extract<Target, { kind: 'stdio' }>, serverDir: string): string {
  const words = [t.command, ...t.args].map(shellWord).join(' ');
  // The Action runs `exec <command>` from the repository root: a bare `cd dir &&`
  // would be exec'd too, so the change of folder goes inside its own shell.
  return serverDir ? `sh -c ${shellWord(`cd ${shellWord(serverDir)} && exec ${words}`)}` : words;
}

/** The secret names the workflow refers to, to tell the user what to add. */
export function secretsNeeded(target: Target): string[] {
  if (target.kind === 'stdio') return Object.keys(target.env ?? {}).map(envSecretName);
  return Object.keys(target.headers ?? {}).map(secretName);
}

function secretName(header: string): string {
  return 'MCP_' + header.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function shellWord(w: string): string {
  return /^[\w./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

function yamlString(s: string): string {
  return /^[\w./:@%+ =-]+$/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/: |\s#/.test(s) && !/^(off|on|yes|no|true|false|null|~|[\d.]+)$/i.test(s) ? s : JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Planning: where everything goes, and what won't work on a CI runner.

/** Something in the setup that won't work in CI as written. */
export interface Problem {
  /** What is wrong, and where. */
  what: string;
  /** Why it fails on the runner. */
  why: string;
  /** The next step. */
  next: string;
  /** A guess from what's on disk, not a certainty. */
  unsure?: boolean;
}

export interface InitPlan {
  /** Where init ran. The server starts here, locally and in CI. */
  cwd: string;
  /** The repository root: .github/ goes here, and CI works from here. */
  root: string;
  inGit: boolean;
  workflowPath: string;
  baselinePath: string;
  /** The baseline, relative to the root, as the workflow names it. */
  baseline: string;
  /** Where the server starts, relative to the root ('' is the root). */
  serverDir: string;
  project: Project;
  /** The target the workflow runs: paths inside the repository made relative to serverDir. */
  ciTarget: Target;
  /** Absolute paths turned into ones that work on the runner. */
  rewrites: { where: string; from: string; to: string; why: string }[];
  problems: Problem[];
  /** Files the server needs that aren't in git yet: they go in the commit, relative to the root. */
  uncommitted: string[];
  /** Files already there: init never overwrites. */
  existing: string[];
  session: boolean;
}

export interface PlanOptions {
  cwd: string;
  target: Target;
  /** --out: the baseline path, relative to cwd. */
  out?: string;
  session?: boolean;
  /** Where to look for executables (default: $PATH). */
  path?: string;
}

/** The repository root above dir: the nearest folder with a .git (a folder, or a file in a worktree). */
export function findGitRoot(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
}

const PROJECT_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml'];

/** Work out where init writes and what the workflow runs, without writing anything. */
export function planInit(opts: PlanOptions): InitPlan {
  const cwd = real(opts.cwd);
  const gitRoot = findGitRoot(cwd);
  const root = gitRoot ? real(gitRoot) : cwd;
  // The project file: from where init ran up to the repository root.
  let projectDir = cwd;
  for (let d = cwd; ; d = dirname(d)) {
    if (PROJECT_FILES.some((f) => existsSync(join(d, f)))) {
      projectDir = d;
      break;
    }
    if (d === root || dirname(d) === d) break;
  }
  const project = detectProject(projectDir, root);
  const serverDir = posix(relative(root, cwd));
  const workflowPath = join(root, '.github', 'workflows', 'toolmenu.yml');
  const baselinePath = resolve(cwd, opts.out ?? 'menu.json');
  if (!isInside(root, baselinePath)) {
    throw new Error(
      `The baseline path ${baselinePath} (from --out ${opts.out}) is outside the repository at ${root}, so the workflow couldn't read it: CI only has the checkout. Pass an --out inside the repository, e.g. --out menu.json.`,
    );
  }
  const plan: InitPlan = {
    cwd,
    root,
    inGit: !!gitRoot,
    workflowPath,
    baselinePath,
    baseline: posix(relative(root, baselinePath)),
    serverDir,
    project,
    ciTarget: opts.target,
    rewrites: [],
    problems: [],
    uncommitted: [],
    existing: [workflowPath, baselinePath].filter((f) => existsSync(f)),
    session: !!opts.session,
  };
  if (opts.target.kind === 'stdio') {
    const t = opts.target;
    const git = gitRoot ? gitStatus(root) : undefined;
    const words = [t.command, ...t.args].map((w, i) => portableWord(w, i, plan, git, opts.path ?? process.env.PATH ?? ''));
    plan.ciTarget = { ...t, command: words[0], args: words.slice(1) };
    for (const [key, value] of Object.entries(t.env ?? {})) {
      const p = isAbsolute(value) ? value : /^\.{1,2}\//.test(value) ? resolve(cwd, value) : undefined;
      if (!p || !existsSync(p)) continue;
      // The value goes into a secret: say which variable, never what it holds.
      plan.problems.push({
        what: `--env ${key} holds a path on this machine${isInside(root, p) ? '' : ', outside the repository'}.`,
        why: `The workflow passes ${key} from the secret ${envSecretName(key)}; with the same value, the runner looks for a file it doesn't have.`,
        next: isInside(root, p)
          ? `Set the secret ${envSecretName(key)} to the path relative to ${serverDir ? `${serverDir}/` : 'the repository root'} (where the server starts in CI), not this machine's.`
          : `Put the file in the repository (or create it in a workflow step), and set the secret ${envSecretName(key)} to its path on the runner.`,
        unsure: true,
      });
    }
  } else if (isLocalUrl(opts.target.url)) {
    plan.problems.push({
      what: `The workflow checks ${opts.target.url}, a server on this machine.`,
      why: 'On the runner, that address is the runner itself, and nothing listens there unless the job starts your server.',
      next: `Rerun init with the command that starts the server (toolmenu init -- <command>), or add a step that starts it in the background before the toolmenu step (docs/github-action.md, "Checking an HTTP server behind auth").`,
    });
  }
  return plan;
}

/**
 * One word of the command, as the runner should see it. A word counts as a path only
 * when it names a file or folder that exists here: `/api/v1` or `--prefix=/x` that
 * aren't on disk are left alone, and so are URLs. `--flag=/path` and `KEY=/path` are
 * looked at after the `=`.
 */
function portableWord(word: string, index: number, plan: InitPlan, git: GitStatus | undefined, pathEnv: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return word;
  const m = /^(-{0,2}[\w.-]+=)(.+)$/.exec(word);
  const [prefix, value] = m && !word.startsWith('/') && !word.startsWith('.') ? [m[1], m[2]] : ['', word];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return word;
  const where = index === 0 ? 'the command' : `argument ${index}${prefix ? ` (${prefix}…)` : ''}`;
  const serverAbs = join(plan.root, plan.serverDir);
  if (isAbsolute(value)) {
    if (!existsSync(value)) return word;
    const inside = isInside(plan.root, value) ? resolve(value) : isInside(plan.root, real(value)) ? real(value) : undefined;
    if (inside) {
      const to = posix(relative(serverAbs, inside)) || '.';
      const rel = index === 0 && !to.includes('/') ? `./${to}` : to;
      plan.rewrites.push({ where, from: value, to: rel, why: `inside the repository, so relative to ${plan.serverDir ? `${plan.serverDir}/` : 'the repository root'}: the runner checks it out at another path` });
      trackStatus(inside, plan, git, where);
      return prefix + rel;
    }
    // A program outside the repository that is also on PATH (node from nvm,
    // python from a venv): the runner has its own on PATH.
    if (index === 0) {
      const name = basename(value);
      if (onPath(name, pathEnv)) {
        plan.rewrites.push({ where, from: value, to: name, why: `outside the repository, and ${name} is on PATH: the runner uses its own ${name}` });
        return name;
      }
    }
    if (/^\/(dev|proc)\//.test(value)) return word;
    plan.problems.push({
      what: `${capitalize(where)} is outside the repository: ${value}`,
      why: `It exists on this machine, but the runner only has the checkout of ${plan.root}.`,
      next:
        index === 0
          ? `Install that program in a workflow step and call it by name, or move it into the repository, then fix "command" in ${plan.workflowPath}.`
          : `Move it into the repository and pass a relative path, or add a workflow step that creates it, then fix "command" in ${plan.workflowPath}.`,
    });
    return word;
  }
  // A relative path: it works on the runner if it stays inside the repository.
  // A bare name counts only as an argument: the command itself is looked up on PATH.
  if (!/[/\\]/.test(value) && value !== '..' && index === 0) return word;
  const abs = resolve(plan.cwd, value);
  if (!existsSync(abs)) return word;
  if (!isInside(plan.root, abs) || !isInside(plan.root, real(abs))) {
    plan.problems.push({
      what: `${capitalize(where)} is outside the repository: ${value}, which is ${real(abs)}`,
      why: `It exists on this machine, but the runner only has the checkout of ${plan.root}.`,
      next: `Move it into the repository, or add a workflow step that creates it, then fix "command" in ${plan.workflowPath}.`,
    });
  } else {
    trackStatus(abs, plan, git, where);
  }
  return word;
}

interface GitStatus {
  /** Whether git tracks a file (a path relative to the root). */
  tracked(rel: string): boolean;
  /** Whether git ignores it. */
  ignored(rel: string): boolean;
}

/**
 * Asks git about one file at a time (listing every ignored file, node_modules and
 * all, can take long). Undefined without git.
 */
function gitStatus(root: string): GitStatus | undefined {
  const ok = (args: string[]) => {
    try {
      execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (!ok(['rev-parse', '--git-dir'])) return undefined;
  return {
    tracked: (rel) => ok(['ls-files', '--error-unmatch', '--', rel]),
    ignored: (rel) => ok(['check-ignore', '-q', '--', rel]),
  };
}

/** A file the server needs: not in git yet means it's missing on the runner. */
function trackStatus(abs: string, plan: InitPlan, git: GitStatus | undefined, where: string): void {
  if (!git || !statSync(abs).isFile()) return;
  const rel = posix(relative(plan.root, abs));
  if (git.tracked(rel)) return;
  const ignored = git.ignored(rel);
  // A virtualenv never goes in a commit, ignored or not.
  const venv = venvOf(abs, plan.root);
  if (!ignored && !venv) {
    if (!plan.uncommitted.includes(rel)) plan.uncommitted.push(rel);
    return;
  }
  const p = plan.project;
  const under = (dir: string) => rel === dir || rel.startsWith(`${dir}/`);
  // A build's output can be anything in its folder, but not a virtualenv.
  if (p.creates.some((c) => (c === '' ? !venv : under(c)))) return;
  const what = `${capitalize(where)} is ${rel}, which ${ignored ? 'git ignores' : "isn't in git"}.`;
  const steps = p.runs.length ? `the workflow's ${p.runs.join(', then ')}` : 'no workflow step';
  if (venv) {
    const pip = p.kind !== 'python' ? '<your dependencies>' : p.file.endsWith('requirements.txt') ? `-r ${p.file}` : `./${p.dir}`;
    plan.problems.push({
      what,
      why: `It's in the virtualenv ${venv}/: the runner only has the checkout, and ${steps} ${p.kind === 'python' ? "installs into the runner's own Python, not" : "doesn't make"} ${venv}/.`,
      next: `${where === 'the command' ? `Call python (the workflow's own) in place of ${rel}` : `Use the file from the workflow's own Python in place of ${rel}`} in "command" in ${plan.workflowPath}; or create the venv in a workflow step before the toolmenu step: python -m venv ${venv} && ${venv}/bin/pip install ${pip}`,
    });
  } else if (p.kind === 'unknown') {
    plan.problems.push({
      what,
      why: 'A build output, probably: the runner starts from a clean checkout, and this workflow has no build step yet.',
      next: `Build it in the TODO step in ${plan.workflowPath}.`,
      unsure: true,
    });
  } else {
    plan.problems.push({
      what,
      why: `The runner starts from a clean checkout, and ${steps} ${p.runs.length ? "doesn't make it, as far as init can tell" : 'makes it'}.`,
      next: `Add a workflow step that builds or fetches ${rel} before the toolmenu step in ${plan.workflowPath}, or commit it.`,
      unsure: true,
    });
  }
}

/** The virtualenv (relative to the root) a file inside the repository is in: the folder with pyvenv.cfg. */
function venvOf(abs: string, root: string): string | undefined {
  for (let d = dirname(abs); isInside(root, d) && d !== root; d = dirname(d)) {
    if (existsSync(join(d, 'pyvenv.cfg'))) return posix(relative(root, d));
  }
  return undefined;
}

/** Write the baseline and the workflow where the plan says. */
export async function writeInit(plan: InitPlan, menuJson: string): Promise<void> {
  await mkdir(dirname(plan.baselinePath), { recursive: true });
  await writeFile(plan.baselinePath, menuJson);
  await mkdir(dirname(plan.workflowPath), { recursive: true });
  await writeFile(plan.workflowPath, workflowYaml({ target: plan.ciTarget, project: plan.project, session: plan.session, baseline: plan.baseline, serverDir: plan.serverDir }));
}

/** The refusal when a file is already there. */
export function existingMessage(plan: InitPlan): string {
  const files = plan.existing.join(' and ');
  return `${files} already ${plan.existing.length > 1 ? 'exist' : 'exists'}; init never overwrites. Remove ${plan.existing.length > 1 ? 'them' : 'it'} and rerun, or set things up by hand (README: "In CI").`;
}

export interface InitSummary {
  server?: string;
  version?: string;
  tools: number;
  tokens: number;
  counts: { error: number; warn: number; info: number };
}

/** What init did, what won't work in CI, and the next steps. Never prints a secret's value. */
export function initReport(plan: InitPlan, s: InitSummary, target: Target): string {
  const fromCwd = (abs: string) => posix(relative(plan.cwd, abs)) || '.';
  const out: string[] = [];
  const server = [s.server ?? 'server', s.version].filter(Boolean).join(' ');
  out.push(`toolmenu init · ${server} · ${plural(s.tools, 'tool')} · ~${s.tokens.toLocaleString('en-US')} tokens (estimate)`, '');

  // Where things are.
  const label = (l: string) => `  ${l.padEnd(12)}`;
  out.push(
    label('Repository') + plan.root + (plan.inGit ? '  (git root)' : '  (not a git repository: this folder stands in for the root)'),
  );
  if (target.kind === 'stdio') {
    out.push(label('Project') + (plan.project.kind === 'unknown' ? `not recognized (no ${PROJECT_FILES.join(', ')} from here up to the root)` : `${plan.project.kind} · ${plan.project.file}`));
    out.push(label('Server') + `starts in ${plan.serverDir ? `${plan.serverDir}/` : 'the repository root'} (where init ran), in CI as here`);
  }
  out.push('');

  out.push('Wrote');
  out.push(`  ✓ ${plan.baselinePath}`, '      the baseline: every pull request is compared with it');
  const how =
    target.kind === 'http'
      ? `checks ${target.url} on every pull request (the deployed server, not the PR's code)`
      : plan.project.kind === 'unknown'
        ? 'on every pull request: a TODO build step (fill it in), then the check'
        : `on every pull request: ${plan.project.runs.join(', then ')}${plan.project.dir ? ` (in ${plan.project.dir}/)` : ''}, then the check`;
  out.push(`  ✓ ${plan.workflowPath}`, `      ${how}${plan.session ? '; also session --auto, which calls read-only tools' : ''}`);
  out.push('');

  if (plan.ciTarget.kind === 'stdio') {
    out.push('In CI the server starts with', `    ${[plan.ciTarget.command, ...plan.ciTarget.args].map(shellWord).join(' ')}`);
    if (plan.serverDir) out.push(`  from ${plan.serverDir}/ (the workflow runs it as: sh -c 'cd ${plan.serverDir} && exec …')`);
    if (plan.rewrites.length) out.push('  Changed for CI:');
    for (const r of plan.rewrites) out.push(`  • ${r.where}: ${r.from}  →  ${r.to}`, `      ${r.why}`);
    out.push('');
  }

  if (plan.problems.length) {
    out.push(`✗ Won't work in CI as written (${plan.problems.length})`);
    plan.problems.forEach((p, i) => {
      const n = `  ${i + 1}. `;
      out.push(n + p.what + (p.unsure ? '  · unsure' : ''), `     ${p.why}`, `     → Next: ${p.next}`);
    });
    out.push('');
  }

  const c = s.counts;
  const seeCmd = `npx toolmenu snapshot --no-write ${targetWords(target, plan).join(' ')}`;
  out.push(
    c.error + c.warn + c.info
      ? `Today's menu: ${plural(c.error, 'error')} · ${plural(c.warn, 'warning')} · ${c.info} info. See them: ${seeCmd}`
      : "Today's menu: no findings.",
    '',
  );

  // Next steps, in the order they're done.
  const steps: string[][] = [];
  if (!plan.inGit) {
    steps.push([
      `Make ${plan.root} a git repository and put it on GitHub: GitHub only runs workflows from .github/ at a repository's root. If this folder belongs inside another repository, rerun init from there instead.`,
      'git init',
    ]);
  }
  if (plan.problems.length) {
    steps.push([`Fix ${plan.problems.length === 1 ? 'the problem' : `the ${plan.problems.length} problems`} above: each one says how.`]);
  }
  if (target.kind === 'stdio' && plan.project.kind === 'unknown') {
    steps.push([`Fill in the TODO in ${plan.workflowPath}: the steps that install and build your server.`]);
  }
  const secrets = secretsNeeded(target);
  if (secrets.length) {
    const from = target.kind === 'stdio' ? '--env' : '--header';
    steps.push([
      `Add ${secrets.length === 1 ? 'the repository secret the workflow reads, with the value' : `the ${secrets.length} repository secrets the workflow reads, each with the value`} you passed to ${from}: on GitHub under Settings → Secrets and variables → Actions, or with the gh CLI (it asks for the value):`,
      ...secrets.map((name) => `gh secret set ${name}`),
    ]);
  }
  const add = [plan.baselinePath, plan.workflowPath, ...plan.uncommitted.map((f) => join(plan.root, f))].map((f) => shellWord(fromCwd(f)));
  steps.push([
    `Commit both files${plan.uncommitted.length ? `, and what the server needs that isn't in git yet (${plan.uncommitted.join(', ')}): the runner only has what's committed` : ''}:`,
    `git add ${add.join(' ')} && git commit -m "Check the MCP tool menu on every PR"`,
  ]);
  steps.push(['Push and open a pull request: toolmenu comments on it with what the change does to the menu.']);
  const vars = target.kind === 'stdio' ? Object.keys(target.env ?? {}) : Object.keys(target.headers ?? {}).map(secretName);
  steps.push([
    `When a menu change is intended, refresh the baseline from ${plan.serverDir ? `${plan.serverDir}/` : 'the repository root'}${vars.length ? ` (with ${vars.join(', ')} set in your shell)` : ''} and commit it:`,
    `npx toolmenu snapshot --out ${shellWord(fromCwd(plan.baselinePath))} ${targetWords(target, plan).join(' ')}`,
  ]);
  out.push('Next steps');
  steps.forEach(([first, ...cmds], i) => {
    out.push(`  ${i + 1}. ${first}`);
    for (const cmd of cmds) out.push(`       ${cmd}`);
  });
  return out.join('\n') + '\n';
}

/**
 * The server part of a toolmenu command line, to print: the portable command, and
 * each --env or --header with its value as a shell variable, never the value itself.
 */
function targetWords(target: Target, plan: InitPlan): string[] {
  if (target.kind === 'http') {
    const headers = Object.keys(target.headers ?? {}).map((h) => `--header "${h}: $${secretName(h)}"`);
    return [shellWord(target.url), ...headers, ...(target.noAuth ? ['--no-auth'] : [])];
  }
  const ci = plan.ciTarget.kind === 'stdio' ? plan.ciTarget : target;
  const env = Object.keys(target.env ?? {}).map((k) => `--env ${shellWord(k)}="$${k.replace(/[^\w]/g, '_')}"`);
  return [...env, '--', ...[ci.command, ...ci.args].map(shellWord)];
}

// ---------------------------------------------------------------------------

function posix(p: string): string {
  return p.split(sep).join('/');
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isInside(root: string, p: string): boolean {
  const rel = relative(root, resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function onPath(name: string, pathEnv: string): boolean {
  return pathEnv.split(delimiter).some((d) => {
    try {
      accessSync(join(d, name), constants.X_OK);
      return statSync(join(d, name)).isFile();
    } catch {
      return false;
    }
  });
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
