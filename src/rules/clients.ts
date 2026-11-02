import { CLIENTS, nameProblem } from '../clients.js';
import { count, kept, type Rule } from './rule.js';

/**
 * --client: tool names the client's API doesn't take. MCP allows names its APIs
 * refuse ("files.read", "get user"): Claude's tool definitions must match
 * ^[a-zA-Z0-9_-]{1,128}$, OpenAI's function names ^[a-zA-Z0-9_-]+$ up to 128.
 */
export const clientName: Rule = {
  id: 'naming/client-name',
  severity: 'warn',
  summary: "Tool names the client's API doesn't accept as they are",
  run(ctx) {
    const profile = ctx.client ? CLIENTS[ctx.client] : undefined;
    if (!profile?.namePattern) return [];
    const bad = kept(ctx.menu.tools, ctx)
      .map((t) => ({ tool: t.name, why: nameProblem(t.name, profile) }))
      .filter((b): b is { tool: string; why: string } => !!b.why);
    if (!bad.length) return [];
    const rule = profile.namePattern;
    return [
      {
        ...(bad.length === 1 ? { tool: bad[0].tool } : {}),
        message: `${count(bad.length, 'tool name')} ${bad.length === 1 ? "doesn't" : "don't"} fit the tool name format of ${rule.value.api}${ctx.client === 'claude-code' ? `, which ${profile.label} sends tools to` : ''} (${rule.value.pattern}, at most ${rule.value.max} characters). MCP allows them, but a request that passes them to the API as they are is refused; a client that rewrites them shows the model a name that isn't the server's.`,
        detail: [...bad.slice(0, 12).map((b) => `${b.tool}: ${b.why}`), ...(bad.length > 12 ? [`and ${bad.length - 12} more`] : []), `Source: ${rule.source} (read ${rule.read}).`],
        fix: 'Use letters, digits, _ and - in tool names (files_read, not files.read), at most 128 characters.',
      },
    ];
  },
};
