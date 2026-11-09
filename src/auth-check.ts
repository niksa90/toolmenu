/*
 * toolmenu auth check <url>: an MCP server's OAuth discovery, checked the way a client
 * that follows the spec walks it, without logging in. Every step is a plain GET or
 * the unauthenticated initialize a client sends first.
 *
 * From the 2025-11-25 authorization spec ("Authorization Server Location", "Protected
 * Resource Metadata Discovery Requirements", "Authorization Code Protection"):
 *   - servers MUST implement RFC 9728 Protected Resource Metadata, found through the
 *     WWW-Authenticate header's resource_metadata on a 401, or at a well-known URI;
 *   - that document MUST list at least one authorization server;
 *   - its `resource` must be the server's own URL, or the client MUST NOT use it
 *     (RFC 9728 §3.3);
 *   - clients MUST verify PKCE support from the authorization server's metadata
 *     (code_challenge_methods_supported) and refuse to go on without it.
 * Client registration (dynamic, or Client ID Metadata Documents) is a SHOULD/MAY:
 * without either, every client needs a pre-registered app. Said as info.
 */
import type { Finding } from './types.js';

export interface AuthCheck {
  url: string;
  /** What the unauthenticated initialize got: the status, and the WWW-Authenticate header. */
  status?: number;
  wwwAuthenticate?: string;
  /** Where the protected resource metadata was found, and how. */
  metadataUrl?: string;
  foundBy?: 'header' | 'well-known path' | 'well-known root';
  resource?: string;
  authorizationServers?: string[];
  /** The first authorization server's metadata URL, and what it says. */
  serverMetadataUrl?: string;
  pkce?: string[];
  registration?: 'dynamic' | 'client-id-metadata' | 'both' | 'none';
  findings: Finding[];
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'toolmenu-auth-check', version: '1' } } };

async function getJson(url: string, timeoutMs: number): Promise<{ status: number; json?: Record<string, unknown> }> {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!r.ok) return { status: r.status };
    const json = (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    return { status: r.status, json: json && typeof json === 'object' && !Array.isArray(json) ? json : undefined };
  } catch {
    return { status: 0 };
  }
}

/** `resource_metadata="…"` from a WWW-Authenticate header. */
export function resourceMetadataOf(header: string | undefined): string | undefined {
  return header ? /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)?.[1] ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(header)?.[1] : undefined;
}

/**
 * Whether failed fetches show the document isn't there (404, 410, or not JSON) or only
 * that it couldn't be read: a 401/403, a 5xx, or no answer (a firewall, a proxy that
 * blocks the host). The second is no finding against the server.
 */
function unreadable(statuses: number[]): boolean {
  return statuses.some((s) => s === 0 || s === 401 || s === 403 || s === 429 || s >= 500);
}

/** The well-known URIs RFC 9728 and the spec name, path-specific first. */
export function wellKnownResource(url: string): { path: string; root: string } {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, '');
  return { path: `${u.origin}/.well-known/oauth-protected-resource${path}`, root: `${u.origin}/.well-known/oauth-protected-resource` };
}

/** The spec's order for an authorization server's metadata: RFC 8414 then OpenID Connect, path-aware. */
export function serverMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  return path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
}

export async function authCheck(url: string, timeoutMs = 15_000): Promise<AuthCheck> {
  const out: AuthCheck = { url, findings: [] };
  const say = (rule: string, severity: Finding['severity'], message: string, fix?: string, detail?: string[]) =>
    out.findings.push({ rule, severity, message, ...(fix ? { fix } : {}), ...(detail?.length ? { detail } : {}) });

  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify(INIT), signal: AbortSignal.timeout(timeoutMs) });
    out.status = r.status;
    out.wwwAuthenticate = r.headers.get('www-authenticate') ?? undefined;
    await r.body?.cancel().catch(() => {});
  } catch (error) {
    say('auth/discovery', 'error', `Couldn't reach ${url}: ${error instanceof Error ? error.message : String(error)}.`, 'Check the URL and the network, then run it again.');
    return out;
  }
  if (out.status !== 401) {
    say('auth/discovery', 'info', out.status && out.status < 300 ? `${url} answered without credentials (HTTP ${out.status}), so it doesn't ask for OAuth: nothing to check.` : `${url} answered HTTP ${out.status} without credentials, not 401, so a client isn't told to log in.`, out.status === 403 ? 'A server that wants OAuth answers 401 with WWW-Authenticate, not 403.' : undefined);
    return out;
  }

  // 1. Where the protected resource metadata is: the header first, then the well-known URIs.
  const fromHeader = resourceMetadataOf(out.wwwAuthenticate);
  const known = wellKnownResource(url);
  const tries: [string, AuthCheck['foundBy']][] = [...(fromHeader ? ([[fromHeader, 'header']] as [string, AuthCheck['foundBy']][]) : []), [known.path, 'well-known path'], [known.root, 'well-known root']];
  let prm: Record<string, unknown> | undefined;
  const prmStatuses: number[] = [];
  for (const [where, how] of tries) {
    const got = await getJson(where, timeoutMs);
    prmStatuses.push(got.status);
    if (got.json) {
      prm = got.json;
      out.metadataUrl = where;
      out.foundBy = how;
      break;
    }
  }
  if (!out.wwwAuthenticate && !prm) {
    say('auth/discovery', 'info', `The 401 has no WWW-Authenticate header, and there's no OAuth protected resource metadata, so the server doesn't advertise OAuth. Authorization is OPTIONAL in MCP: if it takes an API key or another credential, that's fine; if it means OAuth, no client can find where to log in.`, 'If the server uses OAuth, answer 401 with WWW-Authenticate: Bearer resource_metadata="…" and serve the metadata (RFC 9728).', [`tried ${known.path}`, `tried ${known.root}`]);
    return out;
  }
  if (!out.wwwAuthenticate) {
    say('auth/discovery', prm ? 'info' : 'error', `The 401 has no WWW-Authenticate header${prm ? ', so clients find the metadata only at the well-known URI' : ''}.`, 'Answer 401 with WWW-Authenticate: Bearer resource_metadata="<your metadata URL>" (RFC 9728 §5.1).');
  } else if (!fromHeader && prm) {
    say('auth/discovery', 'info', `The 401's WWW-Authenticate header has no resource_metadata, so clients find the metadata only at the well-known URI (${out.foundBy}).`, 'Add resource_metadata="<your metadata URL>" to the WWW-Authenticate header (RFC 9728 §5.1).', [`WWW-Authenticate: ${out.wwwAuthenticate.slice(0, 200)}`]);
  }
  if (!prm && unreadable(prmStatuses)) {
    say('auth/discovery', 'info', `Couldn't read the protected resource metadata (HTTP ${prmStatuses.join(', ')}), so whether it's there wasn't checked: a 403, a 5xx or no answer says nothing about the document.`, 'Run the check again from another network.', tries.map(([u], i) => `${u}: HTTP ${prmStatuses[i] || 'no answer'}`));
    return out;
  }
  if (!prm) {
    say('auth/discovery',
      'error',
      `No OAuth protected resource metadata where the spec says to look, so a client that follows it can't find where to log in. MCP servers MUST serve it (RFC 9728), named in the 401's WWW-Authenticate header or at a well-known URI.`,
      'Serve the metadata at /.well-known/oauth-protected-resource (with the MCP path appended), and name it in the 401: WWW-Authenticate: Bearer resource_metadata="…".',
      [...(fromHeader ? [`named in WWW-Authenticate: ${fromHeader} (not JSON, or not there)`] : []), `tried ${known.path}`, `tried ${known.root}`],
    );
    return out;
  }
  if (fromHeader && out.metadataUrl !== fromHeader) {
    say('auth/discovery', 'warn', `The 401's WWW-Authenticate names ${fromHeader}, which isn't there, but the well-known URI serves the metadata. Clients use the header's URL when it's present.`, 'Point resource_metadata at the URL that serves the metadata.');
  }

  // 2. The metadata: its authorization servers, and its resource.
  out.resource = typeof prm.resource === 'string' ? prm.resource : undefined;
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((s): s is string => typeof s === 'string') : [];
  out.authorizationServers = servers;
  if (!servers.length) {
    say('auth/resource-metadata', 'error', `The protected resource metadata (${out.metadataUrl}) lists no authorization_servers. It MUST list at least one, or a client has nowhere to log in.`, 'Add "authorization_servers": ["https://your-auth-server"] to the metadata.');
  }
  // RFC 9728 §3.3: metadata named by WWW-Authenticate must have the URL the client
  // called as its resource; metadata from a well-known URI, the identifier that URI was
  // built from (the origin for the root one, origin and path for the path one).
  const u = new URL(url);
  const expected = out.foundBy === 'well-known root' ? u.origin : out.foundBy === 'well-known path' ? `${u.origin}${u.pathname.replace(/\/$/, '')}` : url;
  if (!out.resource) {
    say('auth/resource-metadata', 'error', `The protected resource metadata (${out.metadataUrl}) has no "resource". RFC 9728 requires it, and a client checks it against the server it's connecting to.`, `Add "resource": "${url}" to the metadata.`);
  } else if (out.resource !== expected) {
    const sameButSlash = out.resource.replace(/\/$/, '') === expected.replace(/\/$/, '');
    // The official SDK's checkResourceAllowed takes a resource on the same origin whose
    // path is a parent of the URL's (trailing slashes aside); RFC 9728 says identical.
    // What the official SDK compares: the server's URL against the resource, a same-origin
    // parent path accepted (checkResourceAllowed), whatever URI the metadata came from.
    const parent = (() => {
      try {
        const r = new URL(out.resource);
        const e = new URL(url);
        const slash = (p: string) => (p.endsWith('/') ? p : p + '/');
        return r.origin === e.origin && slash(e.pathname).startsWith(slash(r.pathname));
      } catch {
        return false;
      }
    })();
    say('auth/resource-metadata',
      sameButSlash || parent ? 'warn' : 'error',
      `The protected resource metadata (${out.foundBy === 'header' ? 'named by WWW-Authenticate' : `at the ${out.foundBy} URI`}) says resource "${out.resource}", not "${expected}"${out.foundBy === 'header' ? ', the URL the client called' : ', the identifier that URI is built from'}. RFC 9728 §3.3: a client MUST NOT use metadata whose resource isn't identical to it.${sameButSlash ? ' Only a trailing slash differs: the official MCP SDK client accepts it, a client that follows the RFC to the letter doesn\'t.' : parent ? (out.resource.replace(/\/$/, '') === url.replace(/\/$/, '') ? ' It\'s the server\'s own URL, which the official MCP SDK client compares against and accepts; a client that follows the RFC to the letter doesn\'t.' : ' It\'s a parent of the server\'s URL on the same origin: the official MCP SDK client accepts it, a client that follows the RFC to the letter doesn\'t.') : ''}`,
      `Make "resource" exactly ${expected}.`,
    );
  }
  if (!servers.length) return out;

  // 3. The first authorization server's metadata: PKCE, and how a client registers.
  let as: Record<string, unknown> | undefined;
  const asStatuses: number[] = [];
  for (const where of serverMetadataUrls(servers[0])) {
    const got = await getJson(where, timeoutMs);
    asStatuses.push(got.status);
    if (got.json) {
      as = got.json;
      out.serverMetadataUrl = where;
      break;
    }
  }
  if (!as && unreadable(asStatuses)) {
    say('auth/server-metadata', 'info', `Couldn't read ${servers[0]}'s authorization server metadata (HTTP ${asStatuses.join(', ')}), so PKCE and registration weren't checked: a 403, a 5xx or no answer says nothing about whether it's there.`, 'Run the check again from another network.', serverMetadataUrls(servers[0]).map((u, i) => `${u}: HTTP ${asStatuses[i] || 'no answer'}`));
    return out;
  }
  if (!as) {
    say('auth/server-metadata', 'error', `No authorization server metadata for ${servers[0]} at the URIs the spec has clients try (RFC 8414, then OpenID Connect Discovery), so a client can't find where to send the user.`, `Serve the metadata at ${serverMetadataUrls(servers[0])[0]}.`, serverMetadataUrls(servers[0]).map((u) => `tried ${u}`));
    return out;
  }
  out.pkce = Array.isArray(as.code_challenge_methods_supported) ? (as.code_challenge_methods_supported as unknown[]).map(String) : undefined;
  if (!out.pkce?.includes('S256')) {
    say('auth/pkce',
      'error',
      `The authorization server's metadata (${out.serverMetadataUrl}) ${out.pkce ? `lists code_challenge_methods_supported ${JSON.stringify(out.pkce)}, without S256` : 'has no code_challenge_methods_supported'}. MCP clients MUST verify PKCE support from it and MUST refuse to go on without it, so a client that follows the spec can't log in.`,
      'Add "code_challenge_methods_supported": ["S256"] to the authorization server metadata (and support it).',
    );
  }
  const dynamic = typeof as.registration_endpoint === 'string';
  const cimd = as.client_id_metadata_document_supported === true;
  out.registration = dynamic && cimd ? 'both' : dynamic ? 'dynamic' : cimd ? 'client-id-metadata' : 'none';
  if (out.registration === 'none') {
    say('auth/registration', 'info', `The authorization server offers no registration endpoint and no Client ID Metadata Documents, so every client needs an app registered ahead of time (toolmenu: --client-id).`, 'Support Client ID Metadata Documents (the spec\'s SHOULD) or dynamic client registration, so clients can log in without one.');
  }
  return out;
}
