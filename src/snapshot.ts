import { listTools, type Target } from './connect.js';
import { patiently, tooMany } from './failures.js';
import { ConnectError } from './explain.js';
import { buildMenu } from './menu.js';
import { asIdentity, connectPatiently, isContainerWrapper, MAIN_SEED, PROBE_SEED, probeMenu, probeVariance, seeded, type Identity } from './probe.js';
import { kindsToRead, readList, type ListKind } from './lists.js';
import type { ListsContext } from './rules/lists.js';
import type { IdentityMenu } from './rules/identities.js';
import { clientCost, type ClientCost } from './clients.js';
import { MENU_RULES, runRules, type RuleSettings } from './rules/index.js';
import { catalogFindings, readCatalog, type CatalogOptions } from './catalog.js';
import type { Routes } from './routes.js';
import { SEVERITY_RANK, type Finding, type Menu } from './types.js';
import { shellWord } from './init.js';

export interface SnapshotOptions extends RuleSettings {
  routes?: Routes;
  timeoutMs?: number;
  descriptionLimit?: number | string;
  fullDescriptions?: string[];
  /**
   * Server processes (stdio) or connections (HTTP) to compare, the main one
   * included. Default 2; 1 turns the check off.
   */
  processes?: number;
  /** Also read the operations behind a catalog search tool or command routers (true, or which ones and how). */
  catalog?: boolean | CatalogOptions;
  /**
   * snapshot --as: list the menu once per identity. The first is the main one: its
   * menu is the one saved and checked; the others are compared with it.
   */
  identities?: Identity[];
  /** --lists: which lists besides tools to read and check (prompts, resources). */
  lists?: string[];
  /** --client: check the menu for this client (src/clients.ts): its description cut, its search, its name format. */
  client?: string;
}

export interface SnapshotResult {
  menu: Menu;
  findings: Finding[];
  /** snapshot --as: each identity's tools and tokens, or why it couldn't be listed. */
  identities?: IdentityMenu[];
  /** --client: what the menu costs up front and per tool a search loads. */
  cost?: ClientCost;
}

/** Establish the menu: connect, list the tools twice, run the menu rules. */
export async function snapshot(given: Target, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const [mainIdentity, ...otherIdentities] = options.identities ?? [];
  const target = asIdentity(given, mainIdentity);
  // Connecting and listing are read-only: a refusal for being too many is waited
  // out and they're sent again (CI behind a shared rate limit).
  const connection = await connectPatiently(seeded(target, MAIN_SEED), { timeoutMs: options.timeoutMs });
  let menu: Menu;
  let secondList: Menu['tools'];
  let first: Awaited<ReturnType<typeof listTools>>;
  const reads: ListsContext['read'] = [];
  let undeclared: ListKind[] = [];
  try {
    first = await patiently(() => listTools(connection, options), { error: tooMany });
    const second = await patiently(() => listTools(connection, options), { error: tooMany });
    const server = {
      name: connection.server.name,
      version: connection.server.version,
      protocolVersion: connection.protocolVersion,
      era: connection.era,
    };
    menu = buildMenu(first.tools, server, first.listMeta);
    secondList = buildMenu(second.tools, server, second.listMeta).tools;
    // --lists: prompts and resources, each read twice on this connection.
    const kinds = kindsToRead(options.lists ?? [], connection.capabilities);
    undeclared = kinds.undeclared;
    for (const kind of kinds.read) {
      const first = await readList(connection, kind, options.timeoutMs);
      const second = first.error ? undefined : await readList(connection, kind, options.timeoutMs);
      reads.push({ kind, first, ...(second ? { second } : {}) });
      if (!first.error) menu[kind] = first.items;
    }
    if (options.catalog) {
      menu.catalog = await readCatalog(connection, menu.tools, { ...(typeof options.catalog === 'object' ? options.catalog : {}), timeoutMs: options.timeoutMs });
    }
  } catch (error) {
    const stderr = connection.stderr().trim();
    // A ConnectError already shows the stderr lines that matter.
    if (stderr && error instanceof Error && !(error instanceof ConnectError)) error.message += `\nserver stderr:\n${stderr}`;
    throw error;
  } finally {
    await connection.close().catch(() => {});
  }

  // After the main process has exited: a server that holds a file or a port
  // shouldn't have to share it with its own probe.
  const probes = await probeVariance(target, menu.tools, options.processes ?? 2, options.timeoutMs ?? 30_000);

  // The other lists from a second process (stdio) or connection (HTTP), as tools get.
  if ((options.processes ?? 2) > 1 && reads.some((r) => !r.first.error)) {
    try {
      const probe = await connectPatiently(seeded(target, PROBE_SEED), { timeoutMs: options.timeoutMs });
      try {
        for (const r of reads) if (!r.first.error) r.probe = await readList(probe, r.kind, options.timeoutMs);
      } finally {
        await probe.close().catch(() => {});
      }
    } catch {
      // The tool probe above says why a second process or connection failed.
    }
  }

  // Each other identity's menu, from its own process (stdio) or connection (HTTP).
  const identities: IdentityMenu[] | undefined = mainIdentity
    ? [{ name: mainIdentity.name, tools: menu.tools, tokens: menu.totalTokens, cacheScope: menu.listMeta?.cacheScope }]
    : undefined;
  for (const identity of otherIdentities) {
    try {
      const m = await probeMenu(seeded(asIdentity(given, identity), MAIN_SEED), options.timeoutMs ?? 30_000);
      identities!.push({ name: identity.name, tools: m.tools, tokens: m.totalTokens, cacheScope: m.listMeta?.cacheScope });
    } catch (error) {
      identities!.push({ name: identity.name, error: firstLine(error) });
    }
  }

  const findings = runRules(
    MENU_RULES,
    {
      menu,
      secondList,
      pages: first.pages,
      clientError: first.clientError,
      protocolVersion: connection.protocolVersion,
      era: connection.era,
      capabilities: connection.capabilities,
      usedAuth: connection.usedAuth,
      routes: options.routes,
      // A client profile's cut, unless descriptionLimit says otherwise. A client whose docs
      // give no cut (Claude's API, OpenAI) isn't checked against Claude Code's.
      descriptionLimit: options.descriptionLimit ?? (options.client === undefined ? undefined : options.client === 'claude-code' ? 'claude-code' : Number.POSITIVE_INFINITY),
      client: options.client,
      fullDescriptions: options.fullDescriptions,
      transport: target.kind,
      probes,
      wrapper: isContainerWrapper(target),
      serverInfo: connection.server,
      server: serverArgs(target),
      identities,
      ...(reads.length || undeclared.length ? { lists: { read: reads, undeclared } } : {}),
    },
    options,
  );
  // What --catalog called and what it got, under the same settings as the rules
  // (rules: { "catalog/read": "off" }, ignore).
  if (menu.catalog) {
    const ignore = (options.ignore ?? []).map((g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
    for (const f of catalogFindings(menu.catalog)) {
      const configured = options.rules?.[f.rule];
      if (configured === 'off' || (f.tool && ignore.some((re) => re.test(f.tool!)))) continue;
      findings.push({ ...f, severity: configured ?? f.severity });
    }
    findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  }
  const cost = options.client ? clientCost(options.client, menu) : undefined;
  return { menu, findings, ...(identities ? { identities } : {}), ...(cost ? { cost } : {}) };
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].trim();

/**
 * How this run reached the server, as the end of a command line, for next steps:
 * the options that got it past the door (names only; values are the user's) and
 * then `-- command args` or the URL.
 */
export function serverArgs(target: Target): string {
  if (target.kind === 'stdio') {
    const env = Object.keys(target.env ?? {}).map((k) => `--env ${k}=<value>`);
    return [...env, `-- ${[target.command, ...target.args].map(shellWord).join(' ')}`].join(' ');
  }
  const headers = Object.keys(target.headers ?? {}).map((k) => `--header "${k}: <value>"`);
  return [...headers, ...(target.noAuth ? ['--no-auth'] : []), shellWord(target.url)].join(' ');
}
