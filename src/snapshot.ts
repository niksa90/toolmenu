import { connect, listTools, type Target } from './connect.js';
import { buildMenu } from './menu.js';
import { MENU_RULES, runRules, type RuleSettings } from './rules/index.js';
import type { Routes } from './routes.js';
import type { Finding, Menu } from './types.js';

export interface SnapshotOptions extends RuleSettings {
  routes?: Routes;
  timeoutMs?: number;
  descriptionLimit?: number | string;
  fullDescriptions?: string[];
}

export interface SnapshotResult {
  menu: Menu;
  findings: Finding[];
}

/** Establish the menu: connect, list the tools twice, run the menu rules. */
export async function snapshot(target: Target, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const connection = await connect(target, { timeoutMs: options.timeoutMs });
  try {
    const first = await listTools(connection, options);
    const second = await listTools(connection, options);
    const server = {
      name: connection.server.name,
      version: connection.server.version,
      protocolVersion: connection.protocolVersion,
      era: connection.era,
    };
    const menu = buildMenu(first.tools, server, first.listMeta);
    const secondMenu = buildMenu(second.tools, server, second.listMeta);
    const findings = runRules(
      MENU_RULES,
      {
        menu,
        secondList: secondMenu.tools,
        pages: first.pages,
        clientError: first.clientError,
        protocolVersion: connection.protocolVersion,
        era: connection.era,
        capabilities: connection.capabilities,
        usedAuth: connection.usedAuth,
        routes: options.routes,
        descriptionLimit: options.descriptionLimit,
        fullDescriptions: options.fullDescriptions,
      },
      options,
    );
    return { menu, findings };
  } catch (error) {
    const stderr = connection.stderr().trim();
    if (stderr && error instanceof Error) error.message += `\nserver stderr:\n${stderr}`;
    throw error;
  } finally {
    await connection.close().catch(() => {});
  }
}
