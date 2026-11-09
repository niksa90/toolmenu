import { nameProblem, profileOf } from '../clients.js';
import { count, kept, type Rule } from './rule.js';

/**
 * --client: tool names the client's API doesn't take. MCP allows names its APIs
 * refuse ("files.read", "get user"): Claude's tool definitions must match
 * ^[a-zA-Z0-9_-]{1,128}$, OpenAI's function names ^[a-zA-Z0-9_-]+$ up to 128.
 */
export const clientName: Rule = {
  id: 'naming/client-name',
  scope: 'agent',
  severity: 'warn',
  summary: "Tool names the client's API doesn't accept as they are",
  run(ctx) {
    const profile = profileOf(ctx.client);
    if (!profile?.namePattern) return [];
    const bad = kept(ctx.menu.tools, ctx)
      .map((t) => ({ tool: t.name, why: nameProblem(t.name, profile) }))
      .filter((b): b is { tool: string; why: string } => !!b.why);
    if (!bad.length) return [];
    const rule = profile.namePattern;
    return [
      {
        ...(bad.length === 1 ? { tool: bad[0].tool } : {}),
        message: rule.value.rewrites
          ? `${count(bad.length, 'tool name')} ${bad.length === 1 ? "doesn't" : "don't"} fit the tool names ${rule.value.api} keeps as they are (${rule.value.pattern}, at most ${rule.value.max} characters). It ${rule.value.rewrites}, so its model sees a name that isn't the server's, and two names can end up the same.`
          : `${count(bad.length, 'tool name')} ${bad.length === 1 ? "doesn't" : "don't"} fit the tool name format of ${rule.value.api}${ctx.client === 'claude-code' ? `, which ${profile.label} sends tools to` : ''} (${rule.value.pattern}, at most ${rule.value.max} characters). MCP allows them, but a request that passes them to the API as they are is refused; a client that rewrites them shows the model a name that isn't the server's.`,
        detail: [...bad.slice(0, 12).map((b) => `${b.tool}: ${b.why}`), ...(bad.length > 12 ? [`and ${bad.length - 12} more`] : []), `Source: ${rule.source} (read ${rule.read}).`],
        fix: `Use letters, digits, _ and - in tool names (files_read, not files.read), at most ${Math.min(rule.value.max, 128)} characters.`,
      },
    ];
  },
};

/**
 * --client: more tools than the client sends the model at once (VS Code: "A chat request
 * can have a maximum of 128 tools enabled at a time"). This server alone is over it, so
 * a user has to turn tools off before the client works with it.
 */
export const clientLimit: Rule = {
  id: 'menu/client-limit',
  scope: 'agent',
  severity: 'warn',
  summary: 'More tools than the client sends the model at once',
  run(ctx) {
    const profile = profileOf(ctx.client);
    const limit = profile?.toolLimit;
    const n = ctx.menu.tools.length;
    if (!profile || !limit || n <= limit.value) return [];
    return [
      {
        message: `${n} tools, over the ${limit.value} ${profile.label} allows in one request, and that's this server alone, before any other server the user has. The user has to turn ${n - limit.value} or more off before it works, and picks which without knowing which ones the agent needs.`,
        detail: [`Source: ${limit.source} (read ${limit.read}).`],
        fix: 'Group the tools into toolsets a user turns on (the GitHub server\'s --toolsets), or fold several into one tool with an action parameter.',
      },
    ];
  },
};

/**
 * --client: what the client leaves out of what the server offers (GitHub Copilot cloud agent
 * and code review use MCP tools only; code review only tools marked readOnlyHint: true).
 */
export const clientFeatures: Rule = {
  id: 'menu/client-features',
  scope: 'agent',
  severity: 'info',
  summary: "Parts of the server the client doesn't use",
  run(ctx) {
    const profile = profileOf(ctx.client);
    if (!profile) return [];
    const out = [];
    const prompts = ctx.menu.prompts?.length ?? 0, resources = (ctx.menu.resources?.length ?? 0) + (ctx.menu.resourceTemplates?.length ?? 0);
    if (profile.toolsOnly && prompts + resources) {
      out.push({
        message: `${profile.label} uses only MCP tools, not ${profile.toolsOnly.value}, so the server's ${[prompts && count(prompts, 'prompt'), resources && count(resources, 'resource')].filter(Boolean).join(' and ')} aren't available there. Anything an agent needs from them has to come through a tool for it to work in ${profile.label}.`,
        detail: [`Source: ${profile.toolsOnly.source} (read ${profile.toolsOnly.read}).`],
        fix: 'If an agent needs the content, offer it through a tool as well.',
      });
    }
    if (profile.readOnlyOnly) {
      const tools = kept(ctx.menu.tools, ctx);
      const off = tools.filter((t) => (t.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint !== true);
      if (off.length) {
        out.push({
          message: `${profile.label} uses only tools marked readOnlyHint: true, and ${off.length === tools.length ? `none of the ${count(tools.length, 'tool')} is` : `${count(off.length, 'tool')} of ${tools.length} ${off.length === 1 ? "isn't" : "aren't"}`}, so ${off.length === 1 ? "it isn't" : "they aren't"} available there.`,
          detail: [...off.slice(0, 12).map((t) => t.name), ...(off.length > 12 ? [`and ${off.length - 12} more`] : []), `Source: ${profile.readOnlyOnly.source} (read ${profile.readOnlyOnly.read}).`],
          fix: 'Mark the tools that only read with readOnlyHint: true (and only those: clients act on it).',
        });
      }
    }
    return out;
  },
};
