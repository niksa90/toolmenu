/*
 * MCP Apps (ext-apps, io.modelcontextprotocol/ui): a tool names an interactive UI in
 * `_meta.ui.resourceUri`, a `ui://` resource the host reads with resources/read and
 * renders. `_meta.ui.visibility` says who sees the tool: "model" (the agent's tool
 * list) and/or "app" (callable from the app only). Spec: ext-apps
 * specification/draft/apps.mdx.
 */
import type { Connection } from './connect.js';
import { APPS_MIME_TYPE } from './connect.js';
import type { Menu, MenuTool } from './types.js';

/** The deprecated flat key, before `_meta.ui` ("will be removed before GA"). */
export const LEGACY_URI_KEY = 'ui/resourceUri';

export interface UiMeta {
  /** `_meta.ui.resourceUri`. */
  resourceUri?: unknown;
  /** `_meta["ui/resourceUri"]`, the deprecated spelling. */
  legacyUri?: unknown;
  /** `_meta.ui.visibility`, as sent. */
  visibility?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tool's MCP Apps metadata, or undefined when it has none. */
export function uiMeta(tool: object): UiMeta | undefined {
  const raw = (tool as { _meta?: unknown })._meta;
  const meta = isObject(raw) ? raw : undefined;
  if (!meta) return undefined;
  const ui = isObject(meta.ui) ? meta.ui : undefined;
  const out: UiMeta = {
    ...(ui && 'resourceUri' in ui ? { resourceUri: ui.resourceUri } : {}),
    ...(LEGACY_URI_KEY in meta ? { legacyUri: meta[LEGACY_URI_KEY] } : {}),
    ...(ui && 'visibility' in ui ? { visibility: ui.visibility } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** The UI resource the host renders for this tool: `_meta.ui.resourceUri`, else the deprecated key. */
export function resourceUriOf(tool: object): string | undefined {
  const ui = uiMeta(tool);
  // An empty _meta.ui.resourceUri names nothing: the deprecated key, when it has one, is what's left.
  const uri = typeof ui?.resourceUri === 'string' && ui.resourceUri ? ui.resourceUri : typeof ui?.legacyUri === 'string' ? ui.legacyUri : undefined;
  return uri || undefined;
}

/**
 * Listed for the app only: `visibility` is a list without "model". An Apps host MUST
 * NOT put such a tool in the agent's tool list, so the agent never reads its name,
 * description or schema. Absent, visibility is ["model", "app"].
 */
export function isAppOnly(tool: object): boolean {
  const v = uiMeta(tool)?.visibility;
  return Array.isArray(v) && !v.includes('model');
}

/** The tools the agent is shown: all of them but the app-only ones. */
export function agentTools<T extends object>(tools: T[]): T[] {
  return tools.some(isAppOnly) ? tools.filter((t) => !isAppOnly(t)) : tools;
}

/**
 * The menu the agent is shown, its token total recomputed, and what was left out: one
 * view for the report, the agent-scope rules and the --client cost.
 */
export function agentMenu(menu: Menu): { shown: Menu; appOnly?: { tools: number; tokens: number } } {
  const tools = agentTools(menu.tools);
  if (tools === menu.tools) return { shown: menu };
  const tokens = tools.reduce((n, t) => n + t.tokens, 0);
  return { shown: { ...menu, tools, totalTokens: tokens }, appOnly: { tools: menu.tools.length - tools.length, tokens: menu.totalTokens - tokens } };
}

/** What resources/read gave for one UI resource. */
export interface AppResource {
  uri: string;
  /** The tools that name it. */
  tools: string[];
  /** resources/read failed: the error's first line. */
  error?: string;
  /** The JSON-RPC error code it failed with, when there was one. */
  code?: number;
  /** It wasn't read: the reads together ran out of time. */
  notRead?: boolean;
  /** Each content item's mimeType, in order ("" when absent). */
  mimeTypes?: string[];
  /** Some content item for this URI carries text or a blob. */
  hasContent?: boolean;
  /** The content items' URIs that differ from the one asked for. */
  otherUris?: string[];
}

/** Below this much time left before the deadline, a read isn't started. */
const MIN_READ_MS = 10;

/**
 * Read each `ui://` resource the menu's tools name (resources/read: a read, not a tool
 * call), at most `limit` of them. Each is read once, however many tools name it.
 */
export async function readAppResources(connection: Connection, tools: MenuTool[], timeoutMs = 30_000, limit = 50): Promise<AppResource[]> {
  const byUri = new Map<string, string[]>();
  for (const t of tools) {
    const uri = resourceUriOf(t);
    if (uri && uri.startsWith('ui://')) byUri.set(uri, [...(byUri.get(uri) ?? []), t.name]);
  }
  const queue = [...byUri].slice(0, limit);
  const out: (AppResource | undefined)[] = new Array(queue.length);
  // All of them within 2 × the request timeout, 4 at a time: a server whose reads hang
  // costs one bounded wait, not one timeout per resource.
  const deadline = Date.now() + 2 * timeoutMs;
  const readOne = async (i: number) => {
    const [uri, names] = queue[i];
    const left = deadline - Date.now();
    // A read given a few milliseconds can only time out: past the deadline in all but name.
    if (left < MIN_READ_MS) {
      out[i] = { uri, tools: names, notRead: true, error: `not read: the reads took longer than ${Math.round((2 * timeoutMs) / 1000)} s in all` };
      return;
    }
    try {
      const result = await connection.client.readResource({ uri }, { timeout: Math.min(timeoutMs, left) });
      const contents = Array.isArray(result?.contents) ? (result.contents as Record<string, unknown>[]) : [];
      out[i] = {
        uri,
        tools: names,
        mimeTypes: contents.map((c) => (typeof c.mimeType === 'string' ? c.mimeType : '')),
        hasContent: contents.some((c) => (typeof c.text === 'string' && c.text.length > 0) || (typeof c.blob === 'string' && c.blob.length > 0)),
        otherUris: contents.flatMap((c) => (typeof c.uri === 'string' && c.uri !== uri ? [c.uri] : [])),
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      out[i] = { uri, tools: names, error: (error instanceof Error ? error.message : String(error)).split('\n')[0].trim(), ...(typeof code === 'number' ? { code } : {}) };
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < queue.length) await readOne(next++);
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return out.filter((r): r is AppResource => r !== undefined);
}

/** Whether a content type is the one MCP Apps allow, compared without case or spaces around `;`. */
export function isAppsMimeType(mime: string): boolean {
  return mime.toLowerCase().replace(/\s*;\s*/g, ';') === APPS_MIME_TYPE;
}
