import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import type { Era, Menu, MenuTool } from './types.js';

let encoder: Tiktoken | undefined;

/** Estimated tokens for a piece of text. An estimate: vendors tokenize differently. */
export function countTokens(text: string): number {
  encoder ??= new Tiktoken(o200k);
  return encoder.encode(text).length;
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
    tokens: countTokens(JSON.stringify(raw)),
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
  for (const t of menu.tools) {
    if (typeof t?.name !== 'string') throw new Error(`${path}: every tool needs a name`);
    if (typeof t.tokens !== 'number') t.tokens = countTokens(JSON.stringify(t));
  }
  if (typeof menu.totalTokens !== 'number') menu.totalTokens = menu.tools.reduce((s, t) => s + t.tokens, 0);
  menu.server ??= {};
  return menu as Menu;
}
