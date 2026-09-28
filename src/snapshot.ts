import { connect, listTools, type Target } from './connect.js';
import { buildMenu } from './menu.js';
import { isContainerWrapper, MAIN_SEED, probeVariance, seeded } from './probe.js';
import { MENU_RULES, runRules, type RuleSettings } from './rules/index.js';
import { readCatalog, type CatalogOptions } from './catalog.js';
import type { Routes } from './routes.js';
import type { Finding, Menu } from './types.js';

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
  /** Also read the operations behind a catalog search tool (true, or which tool and queries). */
  catalog?: boolean | CatalogOptions;
}

export interface SnapshotResult {
  menu: Menu;
  findings: Finding[];
}

/** Establish the menu: connect, list the tools twice, run the menu rules. */
export async function snapshot(target: Target, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const connection = await connect(seeded(target, MAIN_SEED), { timeoutMs: options.timeoutMs });
  let menu: Menu;
  let secondList: Menu['tools'];
  let first: Awaited<ReturnType<typeof listTools>>;
  try {
    first = await listTools(connection, options);
    const second = await listTools(connection, options);
    const server = {
      name: connection.server.name,
      version: connection.server.version,
      protocolVersion: connection.protocolVersion,
      era: connection.era,
    };
    menu = buildMenu(first.tools, server, first.listMeta);
    secondList = buildMenu(second.tools, server, second.listMeta).tools;
    if (options.catalog) {
      menu.catalog = await readCatalog(connection, menu.tools, { ...(typeof options.catalog === 'object' ? options.catalog : {}), timeoutMs: options.timeoutMs });
    }
  } catch (error) {
    const stderr = connection.stderr().trim();
    if (stderr && error instanceof Error) error.message += `\nserver stderr:\n${stderr}`;
    throw error;
  } finally {
    await connection.close().catch(() => {});
  }

  // After the main process has exited: a server that holds a file or a port
  // shouldn't have to share it with its own probe.
  const probes = await probeVariance(target, menu.tools, options.processes ?? 2, options.timeoutMs ?? 30_000);

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
      descriptionLimit: options.descriptionLimit,
      fullDescriptions: options.fullDescriptions,
      transport: target.kind,
      probes,
      wrapper: isContainerWrapper(target),
    },
    options,
  );
  return { menu, findings };
}
