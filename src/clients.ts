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
   * Absent where the client's docs don't say.
   */
  defers?: Sourced<'all' | 'chosen' | 'none'>;
  /** What the model has of a deferred tool before it searches: its name, or nothing. */
  /**
   * What the model has of a deferred tool before it searches: its name, nothing, or its
   * name and description (OpenAI defers the parameter schema).
   */
  beforeSearch?: Sourced<'name' | 'nothing' | 'name-and-description'>;
  /** Where the client cuts a description: for a tool loaded up front, and one loaded through search. */
  descriptionCut?: Sourced<{ upfront: number; searched: number }>;
  /** How much of a description the search reads. */
  searchReads?: Sourced<number>;
  /** What the search matches on. */
  searchFields?: Sourced<string[]>;
  /** How many tools a search returns unless the model asks for more. */
  searchLimit?: Sourced<number>;
  /**
   * Tool names the API accepts. `rewrites`: the client changes a name outside the
   * pattern (replaces characters, cuts it) instead of sending it and being refused.
   */
  namePattern?: Sourced<{ pattern: string; max: number; api: string; rewrites?: string }>;
  /** The most tools the client sends the model at once. */
  toolLimit?: Sourced<number>;
  /** What the client leaves out of what a server offers, in its docs' words. */
  toolsOnly?: Sourced<string>;
  /** The client calls only tools marked readOnlyHint: true. */
  readOnlyOnly?: Sourced<string>;
  /** Advice on which tools to keep loaded up front. */
  keepLoaded?: Sourced<string>;
}

const CLAUDE_CODE_MCP = 'https://code.claude.com/docs/en/mcp';
const CLAUDE_TOOL_SEARCH = 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool';
const CLAUDE_DEFINE_TOOLS = 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools';
const OPENAI_SPEC = 'https://github.com/openai/openai-openapi (openapi.yaml: FunctionToolParam, NamespaceToolParam, MCPTool)';
const OPENAI_TOOL_SEARCH = 'https://developers.openai.com/api/docs/guides/tools-tool-search';
const READ = '2026-11-02';
const VSCODE_TOOLS = 'https://code.visualstudio.com/docs/agents/run/tools';
const COPILOT_CLOUD = 'https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent';
const GEMINI_CLI_MCP = 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md';
const GEMINI_API = 'https://ai.google.dev/api/caching#FunctionDeclaration';
const ANTIGRAVITY_MCP = 'https://antigravity.google/docs/mcp';
const READ_2 = '2026-11-09';
const geminiName = { pattern: '^[a-zA-Z0-9_.:-]+$' };
const openaiName = { pattern: '^[a-zA-Z0-9_-]+$', max: 128 };

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
    // "For an individual deferred function, the model still sees the function name and description,
    // so in practice tool search is mostly deferring the parameter schema." For an MCP server or
    // namespace, "the model sees only the namespace or server name and description at the beginning".
    beforeSearch: { value: 'name-and-description', source: OPENAI_TOOL_SEARCH, read: '2026-11-03' },
    // Not in the guide or the spec: how many tools a search returns, and which fields it matches on.
    // So search/findable doesn't rank for OpenAI.
    // FunctionToolParam.name: maxLength 128, pattern ^[a-zA-Z0-9_-]+$.
    namePattern: { value: { ...openaiName, api: "OpenAI's Responses API" }, source: OPENAI_SPEC, read: READ },
  },
  codex: {
    label: 'Codex',
    // Codex sends tools to OpenAI's Responses API: FunctionToolParam.name, ^[a-zA-Z0-9_-]+$, maxLength 128.
    // Its MCP docs don't say whether it defers tools or what it does with a name outside that.
    namePattern: { value: { ...openaiName, api: "OpenAI's Responses API, which Codex sends tools to" }, source: OPENAI_SPEC, read: READ_2 },
  },
  vscode: {
    label: 'VS Code (GitHub Copilot Chat)',
    // "A chat request can have a maximum of 128 tools enabled at a time."
    toolLimit: { value: 128, source: VSCODE_TOOLS, read: READ_2 },
  },
  'copilot-cloud-agent': {
    label: 'GitHub Copilot cloud agent',
    // "Copilot cloud agent and Copilot code review only support MCP tools. They do not currently support resources or prompts provided by the MCP server."
    toolsOnly: { value: 'resources and prompts', source: COPILOT_CLOUD, read: READ_2 },
  },
  'copilot-code-review': {
    label: 'GitHub Copilot code review',
    toolsOnly: { value: 'resources and prompts', source: COPILOT_CLOUD, read: READ_2 },
    // "Copilot code review additionally requires tools to declare annotations.readOnlyHint: true."
    readOnlyOnly: { value: 'annotations.readOnlyHint: true', source: COPILOT_CLOUD, read: READ_2 },
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    // "Characters other than letters, numbers, underscore (_), hyphen (-), dot (.), colon (:) are replaced with underscores";
    // "Names longer than 63 characters are truncated with middle replacement".
    namePattern: { value: { ...geminiName, max: 63, api: 'Gemini CLI', rewrites: 'replaces other characters with underscores and cuts longer names in the middle' }, source: GEMINI_CLI_MCP, read: READ_2 },
  },
  'gemini-api': {
    label: 'the Gemini API',
    // FunctionDeclaration.name: "Must be a-z, A-Z, 0-9, or contain underscores, colons, dots, and dashes, with a maximum length of 128."
    namePattern: { value: { ...geminiName, max: 128, api: "the Gemini API's FunctionDeclaration.name" }, source: GEMINI_API, read: READ_2 },
  },
  antigravity: {
    label: 'Antigravity',
    // Lazy loading is the default: the system prompt lists each server's tool names, and the agent reads a
    // tool's schema file before calling it. The user marks a tool "eager": true to register it in full.
    defers: { value: 'chosen', source: ANTIGRAVITY_MCP, read: READ_2 },
    beforeSearch: { value: 'name', source: ANTIGRAVITY_MCP, read: READ_2 },
    keepLoaded: { value: 'Mark only frequently used core tools "eager": true: an eager tool\'s full schema is sent every turn.', source: ANTIGRAVITY_MCP, read: READ_2 },
  },
};

export const CLIENT_NAMES = Object.keys(CLIENTS);

/** A client's profile by name: own keys only ("toString" names no client). */
export function profileOf(name: string | undefined): ClientProfile | undefined {
  return name !== undefined && Object.hasOwn(CLIENTS, name) ? CLIENTS[name] : undefined;
}

/** The profile for a client name, or undefined for none given. Throws for an unknown name. */
export function clientProfile(name: string | undefined): ClientProfile | undefined {
  if (name === undefined) return undefined;
  const profile = profileOf(name);
  if (!profile) throw new Error(`unknown client "${name}": one of ${CLIENT_NAMES.join(', ')}`);
  return profile;
}

/** Whether a tool name fits the client's API, and why not. */
export function nameProblem(name: string, profile: ClientProfile): string | undefined {
  const rule = profile.namePattern?.value;
  if (!rule) return undefined;
  if (name.length > rule.max) return `${name.length} characters, over ${rule.max}`;
  if (!new RegExp(rule.pattern).test(name)) {
    const cls = rule.pattern.match(/\[([^\]]+)\]/)?.[1] ?? 'a-zA-Z0-9_-';
    const ok = new RegExp(`[${cls}]`);
    const bad = [...new Set([...name].filter((c) => !ok.test(c)))];
    const allowed = cls.includes('.') ? 'letters, digits, _, -, . and :' : 'letters, digits, _ and -';
    return `has ${bad.map((c) => (c === ' ' ? 'a space' : `"${c}"`)).join(', ')}, outside ${allowed}`;
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
  const profile = profileOf(name);
  if (!profile?.defers || profile.defers.value === 'none') return undefined;
  const loaded = profile.defers.value === 'all' ? menu.tools.filter(loadsUpfront) : [];
  const deferred = menu.tools.filter((t) => !loaded.includes(t));
  const loadedTokens = loaded.reduce((n, t) => n + t.tokens, 0);
  const seen = profile.beforeSearch?.value;
  // OpenAI keeps a deferred function's name and description up front: what a search adds is the rest.
  const seenUpfront = (t: MenuTool) => countTokens(`${t.name}\n${t.description ?? ''}`);
  const upfront =
    seen === 'name'
      ? countTokens(deferred.map((t) => t.name).join('\n')) + loadedTokens
      : seen === 'nothing'
        ? loadedTokens
        : seen === 'name-and-description'
          ? deferred.reduce((n, t) => n + seenUpfront(t), 0) + loadedTokens
          : undefined;
  const onDemand = (t: MenuTool) => (seen === 'name-and-description' ? Math.max(0, t.tokens - seenUpfront(t)) : t.tokens);
  const basis =
    seen === 'name' && name === 'antigravity'
      ? `${profile.label} lists each MCP tool's name and loads a tool's schema when the agent reads it; tools the user marks "eager" load in full and aren't counted here (${profile.beforeSearch!.source}, read ${profile.beforeSearch!.read})`
      : seen === 'name'
      ? `${profile.label} defers MCP tools and shows their names until a search loads one; the server's instructions load up front too and aren't counted here (${profile.beforeSearch!.source}, read ${profile.beforeSearch!.read})`
      : seen === 'nothing'
        ? `with every tool deferred, the model sees none of them until a search loads one, and the docs advise keeping the 3–5 tools used most loaded (${profile.beforeSearch!.source}, read ${profile.beforeSearch!.read})`
        : seen === 'name-and-description'
          ? `deferred as functions, each tool's name and description stay up front and its schema loads on demand; deferred as one MCP server, the model sees only the server's name and description (set where the server is added) until a search loads its tools (${profile.beforeSearch!.source}, read ${profile.beforeSearch!.read})`
          : `${profile.label} defers per function or per MCP server; what the model sees before a search isn't documented, so no up-front figure`;
  const perTool = deferred.length ? Math.round(deferred.reduce((n, t) => n + onDemand(t), 0) / deferred.length) : 0;
  const biggest = [...deferred].sort((a, b) => onDemand(b) - onDemand(a))[0];
  const largest = biggest ? { name: biggest.name, tokens: onDemand(biggest) } : undefined;
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
