/*
 * What an agent sees depends on its client. Each profile holds only what that
 * client's own docs or API spec say, and every value carries where it was read and
 * when. A value nobody has sourced is not here: toolmenu leaves that part out
 * rather than guess (docs/plans/0.15-2026-readiness.md, point 6).
 */

import { countTokens } from './menu.js';
import type { Menu, MenuTool } from './types.js';

/** A value, where it was read, and when. */
export interface Sourced<T> {
  value: T;
  source: string;
  read: string;
}

export interface ClientProfile {
  /** How the client is named in messages. */
  label: string;
  /**
   * Whether MCP tools are deferred behind a tool search: `all` (every tool unless
   * marked to load up front), `chosen` (the integrator marks each tool), or `none`.
   */
  defers: Sourced<'all' | 'chosen' | 'none'>;
  /** What the model has of a deferred tool before it searches: its name, or nothing. */
  beforeSearch?: Sourced<'name' | 'nothing'>;
  /** Where the client cuts a description: for a tool loaded up front, and one loaded through search. */
  descriptionCut?: Sourced<{ upfront: number; searched: number }>;
  /** How much of a description the search reads. */
  searchReads?: Sourced<number>;
  /** What the search matches on. */
  searchFields?: Sourced<string[]>;
  /** How many tools a search returns unless the model asks for more. */
  searchLimit?: Sourced<number>;
  /** Tool names the API accepts. */
  namePattern?: Sourced<{ pattern: string; max: number; api: string }>;
  /** Advice on which tools to keep loaded up front. */
  keepLoaded?: Sourced<string>;
}

const CLAUDE_CODE_MCP = 'https://code.claude.com/docs/en/mcp';
const CLAUDE_TOOL_SEARCH = 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool';
const CLAUDE_DEFINE_TOOLS = 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools';
const OPENAI_SPEC = 'https://github.com/openai/openai-openapi (openapi.yaml: FunctionToolParam, NamespaceToolParam, MCPTool)';
const READ = '2026-11-02';

const claudeName: Sourced<{ pattern: string; max: number; api: string }> = { value: { pattern: '^[a-zA-Z0-9_-]{1,128}$', max: 128, api: 'the Claude API' }, source: CLAUDE_DEFINE_TOOLS, read: READ };

export const CLIENTS: Record<string, ClientProfile> = {
  'claude-code': {
    label: 'Claude Code',
    // "Tool search is enabled by default: MCP tools are deferred and discovered on demand."
    defers: { value: 'all', source: CLAUDE_CODE_MCP, read: READ },
    // "Only tool names and server instructions load at session start."
    beforeSearch: { value: 'name', source: CLAUDE_CODE_MCP, read: READ },
    // "Server instructions, and the description of a tool that loads upfront: 4,096 characters";
    // "The description of a tool that Claude loads through tool search: 16,384 characters".
    descriptionCut: { value: { upfront: 4096, searched: 16384 }, source: CLAUDE_CODE_MCP, read: READ },
    // "When tool search matches Claude's query against a tool's description, it reads only the part within the shorter limit."
    searchReads: { value: 4096, source: CLAUDE_CODE_MCP, read: READ },
    namePattern: claudeName,
  },
  'claude-api-search': {
    label: "Claude's tool search (Claude API)",
    // "set defer_loading: true on the tools that shouldn't load up front"
    defers: { value: 'chosen', source: CLAUDE_TOOL_SEARCH, read: READ },
    // "Initially, Claude's context contains only the tool search tool and any non-deferred tools."
    beforeSearch: { value: 'nothing', source: CLAUDE_TOOL_SEARCH, read: READ },
    // "Both tool search variants (regex and bm25) search tool names, descriptions, argument names, and argument descriptions."
    searchFields: { value: ['name', 'description', 'argument names', 'argument descriptions'], source: CLAUDE_TOOL_SEARCH, read: READ },
    // "each search returns up to 5 matching tools by default"
    searchLimit: { value: 5, source: CLAUDE_TOOL_SEARCH, read: READ },
    keepLoaded: { value: 'Keep your 3–5 most frequently used tools non-deferred so Claude can call them without searching first.', source: CLAUDE_TOOL_SEARCH, read: READ },
    namePattern: claudeName,
  },
  openai: {
    label: "OpenAI's tool_search (Responses API)",
    // FunctionToolParam.defer_loading, MCPTool.defer_loading: per function, or per MCP server.
    defers: { value: 'chosen', source: OPENAI_SPEC, read: READ },
    // FunctionToolParam.name: maxLength 128, pattern ^[a-zA-Z0-9_-]+$.
    namePattern: { value: { pattern: '^[a-zA-Z0-9_-]+$', max: 128, api: "OpenAI's Responses API" }, source: OPENAI_SPEC, read: READ },
  },
};

export const CLIENT_NAMES = Object.keys(CLIENTS);

/** The profile for a client name, or undefined for none given. Throws for an unknown name. */
export function clientProfile(name: string | undefined): ClientProfile | undefined {
  if (name === undefined) return undefined;
  const profile = CLIENTS[name];
  if (!profile) throw new Error(`unknown client "${name}": one of ${CLIENT_NAMES.join(', ')}`);
  return profile;
}

/** Whether a tool name fits the client's API, and why not. */
export function nameProblem(name: string, profile: ClientProfile): string | undefined {
  const rule = profile.namePattern?.value;
  if (!rule) return undefined;
  if (name.length > rule.max) return `${name.length} characters, over ${rule.max}`;
  if (!new RegExp(rule.pattern).test(name)) {
    const bad = [...new Set([...name].filter((c) => !/[a-zA-Z0-9_-]/.test(c)))];
    return `has ${bad.map((c) => (c === ' ' ? 'a space' : `"${c}"`)).join(', ')}, outside letters, digits, _ and -`;
  }
  return undefined;
}

/** Whether Claude Code loads this tool up front: marked so by its server (`_meta["anthropic/alwaysLoad"]: true`). */
export function loadsUpfront(tool: MenuTool): boolean {
  return (tool._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad'] === true;
}

export interface ClientCost {
  client: string;
  label: string;
  /** Tokens before any search: the deferred tools' names (Claude Code) and the definitions of tools loaded up front. Undefined when the client's docs don't say what the model sees. */
  upfront?: number;
  /** Tools loaded up front, in full. */
  loaded: string[];
  /** Average tokens a deferred tool adds when a search loads it, and the largest. */
  perTool: number;
  largest?: { tool: string; tokens: number };
  /** One line saying what the numbers stand on. */
  basis: string;
}

/** What the menu costs under a client that defers tools: up front, and per tool a search loads. */
export function clientCost(name: string, menu: Menu): ClientCost | undefined {
  const profile = CLIENTS[name];
  if (!profile || profile.defers.value === 'none') return undefined;
  const loaded = profile.defers.value === 'all' ? menu.tools.filter(loadsUpfront) : [];
  const deferred = menu.tools.filter((t) => !loaded.includes(t));
  const perTool = deferred.length ? Math.round(deferred.reduce((n, t) => n + t.tokens, 0) / deferred.length) : 0;
  const largest = [...deferred].sort((a, b) => b.tokens - a.tokens)[0];
  const loadedTokens = loaded.reduce((n, t) => n + t.tokens, 0);
  const seen = profile.beforeSearch?.value;
  const upfront = seen === 'name' ? countTokens(deferred.map((t) => t.name).join('\n')) + loadedTokens : seen === 'nothing' ? loadedTokens : undefined;
  const basis =
    seen === 'name'
      ? `${profile.label} defers MCP tools and shows their names until a search loads one (${profile.beforeSearch!.source}, read ${profile.beforeSearch!.read})`
      : seen === 'nothing'
        ? `with every tool deferred, the model sees none of them until a search loads one, and the docs advise keeping the 3–5 tools used most loaded (${profile.beforeSearch!.source}, read ${profile.beforeSearch!.read})`
        : `${profile.label} defers per function or per MCP server; what the model sees before a search isn't in ${profile.defers.source}, so no up-front figure`;
  return {
    client: name,
    label: profile.label,
    ...(upfront !== undefined ? { upfront } : {}),
    loaded: loaded.map((t) => t.name),
    perTool,
    ...(largest ? { largest: { tool: largest.name, tokens: largest.tokens } } : {}),
    basis,
  };
}
