/*
 * Help text: `toolmenu --help` is the overview, `toolmenu <command> --help` (or
 * `toolmenu help <command>`) is one command's usage, options, examples and exit
 * codes. Option names and behaviour live in cli.ts; this file only describes them.
 */
import { VERSION } from './version.js';

export const COMMANDS = ['init', 'snapshot', 'diff', 'session', 'history', 'auth'] as const;
export type Command = (typeof COMMANDS)[number];

/** Every option, once: its spelling and what it does (continuation lines are indented by the renderer). */
const OPTIONS: Record<string, [string, string[]]> = {
  out: ['--out <path>', ['where to write the menu (default: menu.json)']],
  'no-write': ['--no-write', ["don't write the menu file"]],
  routes: ['--routes <path>', ['routes.yml: pin which words route to which tools']],
  catalog: ['--catalog', ['also read the operations behind a search tool (search and execute:', 'discover, search_*_tools) or command routers (listed with learn: true,', 'never run) and keep them in the menu file for diff']],
  config: ['--config <path>', ['config file (default: toolmenu.config.json, if present)']],
  format: ['--format <fmt>', ['text (default), json, github (annotations) or markdown (PR comments)']],
  json: ['--json', ['same as --format json']],
  'fail-on': ['--fail-on <level>', ['exit 1 on findings at this level or above: error (default), warn, info']],
  header: ['--header "<k>: <v>"', ['HTTP header, repeatable (e.g. "Authorization: Bearer ...")']],
  env: ['--env <K=V>', ['environment variable for a stdio server, repeatable. The server only', 'gets a minimal environment (PATH, HOME, ...) plus these']],
  protocol: ['--protocol <auto|legacy|modern>', ['which handshake to make (default: auto)', 'legacy: the 2025 handshake only; modern: 2026-07-28 only, an error if the server lacks it']],
  'no-auth': ['--no-auth', ["don't use a stored OAuth login (toolmenu auth login) for this server"]],
  timeout: ['--timeout <ms>', ['per-request timeout (default: 30000)']],
  processes: ['--processes <n>', ['server processes (stdio) or connections (HTTP) to compare, the main', 'one included (default: 2). 1 opens no second one: for servers with one', 'session per client']],
  release: ['--release <old>..<new>', ['the release versions (npm, git tag) to check the bump against,', "e.g. 1.4.0..1.5.0. Without it the bump isn't checked:", 'serverInfo.version is often not the release']],
  'server-version-is-release': ['--server-version-is-release', ['check the bump against serverInfo.version instead']],
  scenario: ['--scenario <path>', ['scenario.yml: the steps to run (list, call, wait_for)']],
  plan: ['--plan', ['print the steps without connecting or running anything']],
  init: ['--init', ["write a starter scenario from the server's menu (to --scenario,", 'default scenario.yml; never overwrites)']],
  auto: ['--auto', ['build the steps from the menu: every read-only tool whose required', 'arguments the schema can fill (const, default, examples, enum, type),', 'then the first call again']],
  'open-world': ['--open-world', ['with --auto, also call read-only tools marked openWorldHint: true', '(web search, fetch, scraping): they may cost API credits']],
  'max-calls': ['--max-calls <n>', ['with --auto, at most n calls in all, the tools unlocks bring', 'included (default: 20, plus --max-calls-per-unlock for each unlock value)']],
  'max-calls-per-unlock': ['--max-calls-per-unlock <n>', ['with --auto, at most n calls for the tools each unlock value', 'brings (default: 5), so every toolset gets some']],
  value: ['--value <k=v>', ['with --auto, a value for a required parameter, by name', '(repo_path=/src) or for one tool (get_issue.key=ABC-1);', 'repeatable; JSON values allowed']],
  'values-file': ['--values-file <path>', ['with --auto, the same as a YAML/JSON map']],
  'assume-read-only': ['--assume-read-only <tools>', ["with --auto, call these tools although the server doesn't", 'mark them readOnlyHint (exact names, comma-separated; tools', 'marked or named as writes are still never called)']],
  'save-scenario': ['--save-scenario <path>', ['with --auto, write the plan made before the run as a scenario file', '(calls planned later for tools an unlock brings are not in it)']],
  'union-out': ['--union-out <path>', ['write every tool the session saw as a menu file, to commit as the', 'baseline for diff (tools behind unlocks included)']],
  versions: ['--versions <n|all>', ['how many of the most recent versions to inspect (default: 10), or all']],
  'include-prereleases': ['--include-prereleases', ['include versions like 1.2.0-beta.1']],
  arg: ['--arg <value>', ["argument for the server's bin, repeatable (--arg=--flag for flags)"]],
  bin: ['--bin <name>', ['which bin to run when the package has several']],
  cmd: ['--cmd <template>', ['command instead of the bin; {bin} and {dir} are filled in']],
  'allow-scripts': ['--allow-scripts', ['run install scripts (off by default)']],
  'install-timeout': ['--install-timeout <ms>', ['per-version install timeout (default: 180000)']],
  csv: ['--csv <path>', ['also write the dataset as CSV']],
  'keep-installs': ['--keep-installs', ["keep each version's install directory"]],
  'history-out': ['--out <dir>', ['where menus and history.json go (default: toolmenu-history/<package>)']],
  'init-out': ['--out <path>', ['where to write the baseline menu (default: menu.json)']],
  'with-session': ['--with-session', ['the workflow also runs session --auto (calls read-only tools)']],
  port: ['--port <n>', ['loopback port for the login redirect (default: 33418)']],
  scope: ['--scope <scopes>', ["scopes to ask for (default: the server's)"]],
  'client-id': ['--client-id <id>', ['a pre-registered client, for servers without dynamic registration']],
  'client-secret': ['--client-secret <s>', ['its secret, if it has one']],
};

interface CommandHelp {
  summary: string;
  usage: string[];
  about: string[];
  own: string[];
  shared: string[];
  examples: string[];
  exits: string[];
}

const LINT_EXITS = ['0  no findings at or above --fail-on', '1  findings at or above --fail-on', "2  couldn't run: couldn't connect, or bad usage"];
const SERVER_NOTE = 'A stdio server goes after "--"; an HTTP server is a URL.';

const HELP: Record<Command, CommandHelp> = {
  init: {
    summary: 'set up CI: a baseline menu.json and a GitHub workflow',
    usage: ['toolmenu init [options] -- <command> [args...]', 'toolmenu init [options] <url>'],
    about: [
      'Snapshots the server into the baseline menu and writes .github/workflows/toolmenu.yml,',
      'which compares every pull request with it. Never overwrites either file.',
      SERVER_NOTE,
    ],
    own: ['init-out', 'with-session'],
    shared: ['config', 'header', 'env', 'no-auth', 'protocol', 'timeout', 'processes'],
    examples: ['toolmenu init -- node dist/index.js', 'toolmenu init --with-session https://example.com/mcp'],
    exits: ['0  baseline and workflow written', "2  couldn't connect, a file already exists, or bad usage"],
  },
  snapshot: {
    summary: "list the server's tools, write menu.json, run the menu rules",
    usage: ['toolmenu snapshot [options] -- <command> [args...]', 'toolmenu snapshot [options] <url>'],
    about: [
      'Connects, lists the tools twice (and from a second process), writes the menu file and',
      'reports what in the menu confuses agents or breaks prompt caches.',
      SERVER_NOTE,
    ],
    own: ['out', 'no-write', 'routes', 'catalog'],
    shared: ['config', 'format', 'json', 'fail-on', 'header', 'env', 'no-auth', 'protocol', 'timeout', 'processes'],
    examples: [
      'toolmenu snapshot -- npx -y @modelcontextprotocol/server-memory',
      'toolmenu snapshot --format markdown --header "Authorization: Bearer $TOKEN" https://example.com/mcp',
    ],
    exits: LINT_EXITS,
  },
  diff: {
    summary: 'compare two menu files: breaking changes, token change, semver bump',
    usage: ['toolmenu diff [options] <old.json> <new.json>'],
    about: ['Compares two menus written by snapshot (or session --union-out). Starts no server.'],
    own: ['release', 'server-version-is-release'],
    shared: ['config', 'format', 'json', 'fail-on'],
    examples: ['toolmenu diff menu.json new-menu.json', 'toolmenu diff --release 1.4.0..1.5.0 --format markdown old.json new.json'],
    exits: ['0  no findings at or above --fail-on', '1  findings at or above --fail-on', "2  a menu file can't be read, or bad usage"],
  },
  session: {
    summary: 'run a session (scripted or --auto) and watch the menu change',
    usage: [
      'toolmenu session --scenario <file> [options] -- <command> [args...] | <url>',
      'toolmenu session --auto [options] -- <command> [args...] | <url>',
      'toolmenu session --init [--scenario <file>] -- <command> [args...] | <url>',
    ],
    about: [
      'Runs the steps (list, call, wait_for), lists the menu after each one and reports',
      'changes an agent would miss or pay for: no list_changed, an insert that breaks the',
      'prompt cache, a different menu in a fresh process.',
      SERVER_NOTE,
    ],
    own: ['scenario', 'auto', 'init', 'plan', 'value', 'values-file', 'assume-read-only', 'open-world', 'max-calls', 'max-calls-per-unlock', 'save-scenario', 'union-out'],
    shared: ['config', 'format', 'json', 'fail-on', 'header', 'env', 'no-auth', 'protocol', 'timeout', 'processes'],
    examples: [
      'toolmenu session --auto -- node dist/index.js',
      'toolmenu session --auto --value repo_path=/src -- uvx mcp-server-git',
      'toolmenu session --init -- node dist/index.js      (then fill in scenario.yml)',
      'toolmenu session --scenario scenario.yml --union-out menu.json https://example.com/mcp',
    ],
    exits: LINT_EXITS,
  },
  history: {
    summary: "install, snapshot and diff an npm package's published versions",
    usage: ['toolmenu history [options] <npm-package>'],
    about: [
      'Best effort research: installs each version with npm (today\'s dependencies, not the',
      'ones it shipped with), starts its bin, snapshots it and diffs it with the previous one.',
      'It installs and runs third-party code: run it in a container.',
    ],
    own: ['versions', 'include-prereleases', 'arg', 'bin', 'cmd', 'allow-scripts', 'install-timeout', 'csv', 'keep-installs', 'history-out'],
    shared: ['format', 'json', 'env', 'timeout'],
    examples: [
      'toolmenu history --versions 5 @modelcontextprotocol/server-memory',
      'toolmenu history --env API_TOKEN=dummy --csv history.csv some-mcp-server',
    ],
    exits: ['0  at least one version was inspected', '1  every version failed', "2  bad usage, or the package's versions couldn't be listed"],
  },
  auth: {
    summary: 'log in to an OAuth-protected HTTP server once',
    usage: ['toolmenu auth login [options] <url>', 'toolmenu auth logout <url>', 'toolmenu auth list'],
    about: [
      'login opens the browser once and stores the tokens (only you can read the file);',
      'snapshot and session then use them for that URL (--no-auth to skip).',
      'Stored in $TOOLMENU_AUTH_DIR, else $XDG_CONFIG_HOME/toolmenu/auth, else ~/.config/toolmenu/auth.',
    ],
    own: ['port', 'scope', 'client-id', 'client-secret'],
    shared: [],
    examples: [
      'toolmenu auth login https://example.com/mcp',
      'toolmenu auth login --client-id <id> --client-secret <secret> https://example.com/mcp',
      'toolmenu auth list',
    ],
    exits: ['0  done (logout of a URL with no login is not an error)', '2  the login failed, or bad usage'],
  },
};

function optionLines(keys: string[]): string[] {
  const width = Math.max(...keys.map((k) => OPTIONS[k][0].length)) + 2;
  return keys.flatMap((k) => {
    const [flag, text] = OPTIONS[k];
    return text.map((line, i) => `  ${(i === 0 ? flag : '').padEnd(width)}${line}`);
  });
}

/** `toolmenu --help`: what toolmenu is and which command to reach for. */
export function overview(): string {
  const width = Math.max(...COMMANDS.map((c) => c.length)) + 3;
  return [
    `toolmenu ${VERSION}`,
    "Lint your MCP server's tool menu for changes that confuse agents or break caches.",
    '',
    'Usage: toolmenu <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.padEnd(width)}${HELP[c].summary}`),
    '',
    'Servers: a stdio server goes after "--" (toolmenu snapshot -- node server.js),',
    'an HTTP server is a URL (toolmenu snapshot https://example.com/mcp).',
    '',
    'Options:',
    '  -h, --help       this overview; toolmenu <command> --help for a command',
    '  -v, --version    the version',
    '',
    'Exit codes: 0 clean · 1 findings at or above --fail-on · 2 couldn\'t run (connect, usage)',
    'Docs: https://github.com/niksa90/toolmenu#readme',
    '',
  ].join('\n');
}

/** `toolmenu <command> --help`: usage, options, examples, exit codes. */
export function commandHelp(command: Command): string {
  const h = HELP[command];
  const lines = [`toolmenu ${command}: ${h.summary}`, '', 'Usage:', ...h.usage.map((u) => `  ${u}`), '', ...h.about, '', 'Options:', ...optionLines(h.own)];
  if (h.shared.length) lines.push('', 'Shared options:', ...optionLines(h.shared));
  lines.push('', 'Examples:', ...h.examples.map((e) => `  ${e}`), '', 'Exit codes:', ...h.exits.map((e) => `  ${e}`), '');
  return lines.join('\n');
}

/** The message for a command toolmenu doesn't have. */
export function unknownCommand(name: string): string {
  const near = COMMANDS.find((c) => c.startsWith(name.slice(0, 3)) && name.length > 2);
  return `Unknown command "${name}".${near ? ` Did you mean ${near}?` : ''} The commands are ${COMMANDS.join(', ')}. Run toolmenu --help for an overview.`;
}

export function isCommand(name: string): name is Command {
  return (COMMANDS as readonly string[]).includes(name);
}

/** The options a command takes, as spelled on the command line (no "--"). */
export function commandOptions(command: Command): string[] {
  const { own, shared } = HELP[command];
  return [...own, ...shared].map((k) => (k === 'init-out' || k === 'history-out' ? 'out' : k));
}
