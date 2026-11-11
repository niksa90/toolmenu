import { APPS_MIME_TYPE } from '../connect.js';
import { isAppOnly, isAppsMimeType, LEGACY_URI_KEY, uiMeta, type AppResource } from '../apps.js';
import { runs, type UnreadReason } from '../resource-read.js';
import { tooMany } from '../failures.js';
import { clip, count, kept, names, type Rule, type RuleFinding } from './rule.js';

/*
 * MCP Apps (ext-apps): checks on the UI a tool names, as an Apps host reads it.
 * Each traced to specification/draft/apps.mdx:
 *   "URI MUST start with ui:// scheme"; "Resource MUST exist on the server";
 *   "mimeType MUST be text/html;profile=mcp-app"; "Content MUST be provided via
 *   either text or blob"; visibility "model" | "app", "Host MUST NOT include tools in
 *   the agent's tool list when their visibility does not include "model"".
 */

const FALLBACK = 'An Apps host then shows no UI for the tool; the agent still gets its text result.';

export const appsResource: Rule = {
  id: 'apps/resource',
  severity: 'warn',
  summary: "The UI a tool names (MCP Apps _meta.ui.resourceUri) is a ui:// resource the server serves as an app",
  run(ctx) {
    const problems: { tool: string; why: string }[] = [];
    // Reads that failed for the run's reasons: said, but not as the server's.
    const unread: { tool: string; uri: string; reason: UnreadReason; error: string }[] = [];
    const read = new Map((ctx.appResources ?? []).map((r) => [r.uri, r]));
    for (const tool of kept(ctx.menu.tools, ctx)) {
      const ui = uiMeta(tool);
      if (!ui || (ui.resourceUri === undefined && ui.legacyUri === undefined)) continue;
      const uri = ui.resourceUri ?? ui.legacyUri;
      if (typeof uri !== 'string' || !uri) {
        problems.push({ tool: tool.name, why: `_meta.ui.resourceUri is ${JSON.stringify(uri)}, not a ui:// URI` });
        continue;
      }
      if (typeof ui.resourceUri === 'string' && typeof ui.legacyUri === 'string' && ui.resourceUri !== ui.legacyUri) {
        problems.push({ tool: tool.name, why: `_meta.ui.resourceUri is ${ui.resourceUri} but _meta["${LEGACY_URI_KEY}"] is ${ui.legacyUri}: hosts that read the old key render another UI` });
      }
      if (!uri.startsWith('ui://')) {
        problems.push({ tool: tool.name, why: `${clip(uri, 80)} isn't a ui:// URI, which MCP Apps require` });
        continue;
      }
      const r = read.get(uri);
      if (!r) continue; // not read (over the limit, or the run read none)
      const reason = r.error ? runsReason(r) : undefined;
      if (reason) {
        unread.push({ tool: tool.name, uri, reason, error: r.error! });
        continue;
      }
      const why = resourceProblem(r);
      if (why) problems.push({ tool: tool.name, why });
    }
    const findings: RuleFinding[] = [];
    if (unread.length) {
      const tools = [...new Set(unread.map((u) => u.tool))];
      const one = tools.length === 1;
      const credentials = unread.some((u) => u.reason === 'auth' || u.reason === 'payment');
      findings.push({
        severity: 'info',
        ...(one ? { tool: tools[0] } : {}),
        message: `${one ? `${tools[0]} names an MCP Apps UI` : `${count(tools.length, 'tool')} name MCP Apps UIs`} that toolmenu couldn't read here (${UNREAD[unread[0].reason]}: ${clip(unread[0].error, 120)}), so ${one ? "it wasn't" : "they weren't"} checked: a setup problem, not the server's.`,
        ...(unread.length > 1 ? { detail: unread.map((u) => `${u.tool}: ${u.uri}: ${UNREAD[u.reason]} (${clip(u.error, 120)})`) } : {}),
        fix: credentials ? 'Rerun with the credentials the server needs (--header, --env) to check the UI.' : 'Rerun where the server can answer (the network, the backend it reads from, more --timeout) to check the UI.',
      });
    }
    if (!problems.length) return findings;
    const tools = [...new Set(problems.map((p) => p.tool))];
    const one = tools.length === 1;
    return [
      ...findings,
      {
        ...(one ? { tool: tools[0] } : {}),
        message: `${one ? `${tools[0]} names` : `${count(tools.length, 'tool')} name`} an MCP Apps UI that a host can't render: ${one ? problems[0].why : names(tools, 6)}. ${FALLBACK}`,
        ...(one && problems.length === 1 ? {} : { detail: problems.map((p) => `${p.tool}: ${p.why}`) }),
        fix: `Serve each UI as a ui:// resource that resources/read returns with mimeType "${APPS_MIME_TYPE}" and the HTML as text or blob, and point _meta.ui.resourceUri at it.`,
      } satisfies RuleFinding,
    ];
  },
};

const UNREAD: Record<UnreadReason, string> = {
  auth: 'credentials',
  payment: 'payment',
  network: 'the network',
  client: "a client capability toolmenu doesn't declare",
  environment: 'something this run lacks',
  'rate-limit': 'a rate limit',
  timeout: 'no answer in time',
  'input-required': 'the server asked for input',
  budget: 'the reads ran out of time',
  bytes: 'enough content already',
  'max-reads': '--max-reads',
  'declared-size': 'its declared size',
  web: 'an http(s) URL',
  gone: 'gone from the list',
};

/** Why a failed read is the run's (credentials, the network, time), or undefined when it's the server's. */
function runsReason(r: AppResource): UnreadReason | undefined {
  if (r.notRead) return 'budget';
  if (tooMany(r.error)) return 'rate-limit';
  if (r.code === undefined && /timed out|timeout/i.test(r.error ?? '')) return 'timeout';
  return runs(r.error ?? '', r.code);
}

function resourceProblem(r: AppResource): string | undefined {
  if (r.error) return `resources/read of ${r.uri} failed (${clip(r.error, 120)}): the spec says the resource MUST exist on the server`;
  const types = r.mimeTypes ?? [];
  if (!types.length) return `resources/read of ${r.uri} returned no contents`;
  const wrong = types.filter((m) => !isAppsMimeType(m));
  if (wrong.length) return `resources/read of ${r.uri} gave mimeType ${wrong.map((m) => (m ? `"${m}"` : 'none')).join(', ')}, not "${APPS_MIME_TYPE}"`;
  if (!r.hasContent) return `resources/read of ${r.uri} returned no text or blob`;
  return undefined;
}

export const appsLegacyKey: Rule = {
  id: 'apps/legacy-key',
  severity: 'info',
  summary: 'Tools name their UI with _meta.ui.resourceUri, not the deprecated _meta["ui/resourceUri"]',
  run(ctx) {
    const old = kept(ctx.menu.tools, ctx).filter((t) => {
      const ui = uiMeta(t);
      return ui && ui.legacyUri !== undefined && ui.resourceUri === undefined;
    });
    if (!old.length) return [];
    const one = old.length === 1;
    return [
      {
        ...(one ? { tool: old[0].name } : {}),
        message: `${one ? `${old[0].name} names its UI` : `${count(old.length, 'tool')} name their UI`} only with _meta["${LEGACY_URI_KEY}"], which MCP Apps deprecate ("will be removed before GA"). A host that reads only _meta.ui.resourceUri shows ${one ? 'it' : 'them'} without a UI.`,
        ...(one ? {} : { detail: [names(old.map((t) => t.name), 20)] }),
        fix: `Add _meta: { ui: { resourceUri: "<the same ui:// URI>" } } to ${one ? old[0].name : 'each'}; keep the old key while older hosts need it.`,
      },
    ];
  },
};

const VISIBILITIES = new Set(['model', 'app']);

export const appsVisibility: Rule = {
  id: 'apps/visibility',
  severity: 'warn',
  summary: 'MCP Apps _meta.ui.visibility is a list of "model" and "app"',
  run(ctx) {
    const problems: { tool: string; why: string }[] = [];
    for (const tool of kept(ctx.menu.tools, ctx)) {
      const v = uiMeta(tool)?.visibility;
      if (v === undefined) continue;
      if (!Array.isArray(v)) {
        problems.push({ tool: tool.name, why: `visibility is ${clip(JSON.stringify(v), 60)}, not a list` });
        continue;
      }
      const unknown = v.filter((x) => typeof x !== 'string' || !VISIBILITIES.has(x));
      if (unknown.length) problems.push({ tool: tool.name, why: `visibility has ${unknown.map((x) => JSON.stringify(x)).join(', ')}, which hosts don't know` });
      if (!v.includes('model') && !v.includes('app')) problems.push({ tool: tool.name, why: 'visibility names neither "model" nor "app", so no one can call it: not the agent, not the app' });
    }
    if (!problems.length) return [];
    const tools = [...new Set(problems.map((p) => p.tool))];
    const one = tools.length === 1;
    return [
      {
        ...(one ? { tool: tools[0] } : {}),
        message: `${one ? `${tools[0]}'s` : `${count(tools.length, 'tool')}' `} MCP Apps visibility ${one ? 'is' : 'are'} not what hosts read: ${one ? problems[0].why : names(tools, 6)}. Hosts show a tool to the agent only when visibility includes "model", and let the app call it only when it includes "app".`,
        ...(one && problems.length === 1 ? {} : { detail: problems.map((p) => `${p.tool}: ${p.why}`) }),
        fix: 'Set _meta.ui.visibility to ["model", "app"] (the default when it is left out), ["model"], or ["app"] for a tool only the app calls.',
      },
    ];
  },
};

/**
 * App-only tools listed to a client that didn't declare MCP Apps. Such a client doesn't
 * read _meta.ui, so it puts them in its agent's list: tools meant to be called by an
 * app's UI, offered to the agent. ext-apps: "Servers SHOULD check client capabilities
 * before registering UI-enabled tools".
 */
export const appsAppOnlyListed: Rule = {
  id: 'apps/app-only-listed',
  severity: 'warn',
  summary: 'App-only tools are listed only to clients that declare MCP Apps',
  run(ctx) {
    const plain = ctx.plain?.tools;
    if (!plain) return [];
    // Marked for the app: a visibility that names neither is apps/visibility's.
    const leaked = kept(plain.filter((t) => isAppOnly(t) && (uiMeta(t)?.visibility as unknown[]).includes('app')), ctx);
    if (!leaked.length) return [];
    const one = leaked.length === 1;
    const list = leaked.map((t) => t.name);
    return [
      {
        ...(one ? { tool: list[0] } : {}),
        message: `${one ? `${list[0]} is` : `${names(list, 6)} are`} marked for the app only (_meta.ui.visibility without "model"), yet listed to a client that doesn't declare MCP Apps too. That client doesn't read _meta.ui, so its agent is offered ${one ? 'a tool' : 'tools'} meant for an app's UI.`,
        ...(one ? {} : { detail: [list.join(', ')] }),
        fix: `List ${one ? 'it' : 'them'} only when the client declares the io.modelcontextprotocol/ui extension (ext-apps' getUiCapability), as the spec asks servers to.`,
      },
    ];
  },
};
