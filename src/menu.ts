import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import type { Era, Menu, MenuTool } from './types.js';

let encoder: Tiktoken | undefined;

/** Estimated tokens for a piece of text. An estimate: vendors tokenize differently. */
export function countTokens(text: string): number {
  encoder ??= new Tiktoken(o200k);
  return encoder.encode(text).length;
}

/**
 * Estimated tokens the model reads for a tool: its name, description and input
 * schema, which is what clients send (Claude's Messages API takes exactly those).
 * outputSchema, annotations, icons, title and _meta stay with the client: GitHub's
 * server embeds icons that would otherwise count five times its real menu.
 */
export function toolTokens(tool: Record<string, unknown>): number {
  return countTokens(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/** The tool definition without toolmenu's own `tokens` field. */
export function toolDefinition(tool: MenuTool): Record<string, unknown> {
  const { tokens: _tokens, ...definition } = tool;
  return definition;
}

export function buildMenu(
  rawTools: Record<string, unknown>[],
  server: Menu['server'],
  listMeta?: Menu['listMeta'],
): Menu {
  const tools = rawTools.map((raw) => ({
    ...(raw as Omit<MenuTool, 'tokens'>),
    tokens: toolTokens(raw),
  })) as MenuTool[];
  return {
    toolmenu: 1,
    server,
    capturedAt: new Date().toISOString(),
    tools,
    totalTokens: tools.reduce((sum, t) => sum + t.tokens, 0),
    ...(listMeta && Object.keys(listMeta).length ? { listMeta } : {}),
  };
}

export function eraOf(protocolVersion: string | undefined): Era | undefined {
  if (!protocolVersion) return undefined;
  return protocolVersion >= '2026-07-28' ? 'modern' : 'legacy';
}

/** Read a menu.json written by `toolmenu snapshot`. */
export async function loadMenu(path: string): Promise<Menu> {
  const { readFile } = await import('node:fs/promises');
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const menu = data as Partial<Menu>;
  if (menu?.toolmenu !== 1 || !Array.isArray(menu.tools)) {
    throw new Error(`${path} isn't a toolmenu menu file (expected "toolmenu": 1 and a "tools" list). Write one with \`toolmenu snapshot\`.`);
  }
  // Always recounted, never read from the file: a baseline written by an older
  // toolmenu (which counted every field) still compares fairly with a new snapshot.
  for (const t of menu.tools) {
    if (typeof t?.name !== 'string') throw new Error(`${path}: every tool needs a name`);
    t.tokens = toolTokens(t);
  }
  menu.totalTokens = menu.tools.reduce((s, t) => s + t.tokens, 0);
  for (const op of menu.catalog?.operations ?? []) op.tokens = toolTokens(op);
  menu.server ??= {};
  return menu as Menu;
}
