import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type { OAuthClientInformationContext, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';
import { VERSION } from './version.js';

/**
 * The redirect port. Fixed, not random: dynamic registration records the exact
 * redirect URI, so a new port would invalidate the stored client on every login.
 */
export const DEFAULT_PORT = 33418;

/** What toolmenu keeps per server, in a file only the user can read. */
interface Stored {
  serverUrl: string;
  /** The authorization server the credentials belong to (RFC 9207 issuer). */
  issuer?: string;
  redirectUrl?: string;
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  /**
   * Which authorization server the login started with. The SDK checks the callback
   * against it (SEP-2352): a code and PKCE verifier are never sent to another
   * server's token endpoint.
   */
  discoveryState?: OAuthDiscoveryState;
  /**
   * Set when the SDK dropped the tokens because the server refused them: 'refresh' for
   * a refused refresh (invalid_grant), 'client' for a rejected client (invalid_client).
   * Without it, a file with no tokens is a login that never finished.
   */
  rejected?: 'refresh' | 'client';
  savedAt?: string;
}

/** Where logins live: $TOOLMENU_AUTH_DIR, else $XDG_CONFIG_HOME/toolmenu/auth, else ~/.config/toolmenu/auth. */
export function authDir(): string {
  if (process.env.TOOLMENU_AUTH_DIR) return process.env.TOOLMENU_AUTH_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'toolmenu', 'auth');
}

/** One file per server endpoint (origin and path), named by its hash. */
function storePath(serverUrl: string): string {
  const u = new URL(serverUrl);
  return join(authDir(), createHash('sha256').update(u.origin + u.pathname).digest('hex').slice(0, 32) + '.json');
}

async function load(serverUrl: string): Promise<Stored> {
  try {
    return JSON.parse(await readFile(storePath(serverUrl), 'utf8')) as Stored;
  } catch {
    return { serverUrl };
  }
}

async function save(data: Stored): Promise<void> {
  await mkdir(authDir(), { recursive: true, mode: 0o700 });
  const path = storePath(data.serverUrl);
  await writeFile(path, JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Is there a stored file for this server (a login, or what's left of one)? Why a login is needed reads its contents. */
export function hasLogin(serverUrl: string): boolean {
  return existsSync(storePath(serverUrl));
}

export interface ProviderOptions {
  /** A browser login may start (auth login). Otherwise a needed login is an error. */
  interactive?: boolean;
  port?: number;
  scope?: string;
  /** A pre-registered client, for servers that don't allow dynamic registration. */
  clientId?: string;
  clientSecret?: string;
  onRedirect?: (url: URL) => void | Promise<void>;
}

/**
 * The SDK's OAuthClientProvider, backed by toolmenu's store. Credentials are bound
 * to the authorization server's issuer: stored ones for a different issuer are
 * never handed out.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  private data: Stored | undefined;
  private expectedState: string | undefined;
  /** invalidateCredentials('all') deleted a file that held tokens, in this run. */
  private removedLogin = false;

  constructor(
    private readonly serverUrl: string,
    private readonly options: ProviderOptions = {},
  ) {}

  private async stored(): Promise<Stored> {
    this.data ??= await load(this.serverUrl);
    return this.data;
  }

  private async update(patch: Partial<Stored>): Promise<void> {
    this.data = { ...(await this.stored()), ...patch };
    await save(this.data);
  }

  /** The issuer check: no credentials for an authorization server they weren't issued by. */
  private async sameIssuer(ctx?: OAuthClientInformationContext): Promise<boolean> {
    const s = await this.stored();
    return !ctx?.issuer || !s.issuer || s.issuer === ctx.issuer;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.options.port ?? DEFAULT_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'toolmenu',
      client_uri: 'https://github.com/niksa90/toolmenu',
      software_id: 'toolmenu',
      software_version: VERSION,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.options.clientSecret ? 'client_secret_post' : 'none',
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    } as OAuthClientMetadata;
  }

  state(): string {
    this.expectedState = randomBytes(16).toString('base64url');
    return this.expectedState;
  }

  /** The state the authorization request carried, to check the callback against (the SDK doesn't). */
  get lastState(): string | undefined {
    return this.expectedState;
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const s = await this.stored();
    if (this.options.clientId) {
      // Stamped with the issuer, like everything the SDK stores (SEP-2352): the one
      // this server's login was first bound to, or on a first login the one being
      // discovered. The SDK then won't hand this client to another server.
      if (s.issuer && ctx?.issuer && s.issuer !== ctx.issuer) return undefined;
      const issuer = s.issuer ?? ctx?.issuer;
      const info = { client_id: this.options.clientId, ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}), ...(issuer ? { issuer } : {}) } as StoredOAuthClientInformation;
      // Kept like a registered client, so a later snapshot can refresh the token
      // without --client-id.
      if (JSON.stringify(s.clientInformation) !== JSON.stringify(info)) await this.update({ clientInformation: info, redirectUrl: this.redirectUrl });
      return info;
    }
    if (!(await this.sameIssuer(ctx))) return undefined;
    // Registered for another redirect URI (a different --port): register again.
    if (this.options.interactive && s.redirectUrl && s.redirectUrl !== this.redirectUrl) return undefined;
    return s.clientInformation;
  }

  async saveClientInformation(clientInformation: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.update({ clientInformation, redirectUrl: this.redirectUrl, ...(ctx?.issuer ? { issuer: ctx.issuer } : {}) });
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    if (!(await this.sameIssuer(ctx))) return undefined;
    return (await this.stored()).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.update({ tokens, rejected: undefined, ...(ctx?.issuer ? { issuer: ctx.issuer } : {}) });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.interactive) {
      throw new LoginNeededError(this.serverUrl, whyLoginNeeded(await this.stored(), this.removedLogin));
    }
    await this.options.onRedirect?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.stored()).codeVerifier;
    if (!v) throw new Error(`No PKCE code verifier is saved for ${this.serverUrl}: the stored login changed while this one ran (another login at the same time?).\n→ Next: Run toolmenu auth login ${this.serverUrl} again.`);
    return v;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.update({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.stored()).discoveryState;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const s = await this.stored();
    if (scope === 'all') {
      this.removedLogin ||= Boolean(s.tokens) || Boolean(s.rejected);
      this.data = { serverUrl: s.serverUrl };
      await rm(storePath(this.serverUrl), { force: true });
      return;
    }
    const patch: Partial<Stored> = {};
    if (scope === 'client') {
      patch.clientInformation = undefined;
      if (s.tokens) patch.rejected = 'client';
    }
    if (scope === 'tokens') {
      patch.tokens = undefined;
      if (s.tokens) patch.rejected ??= s.rejected ?? 'refresh';
    }
    if (scope === 'verifier') patch.codeVerifier = undefined;
    if (scope === 'discovery') patch.discoveryState = undefined;
    await this.update(patch);
  }
}

/**
 * Why snapshot or session needs a login, from what's stored: nothing, a registration
 * from a login that never finished, tokens the server refused, or a login the server
 * rejected and toolmenu removed (removedLogin: in this run).
 */
function whyLoginNeeded(s: Stored, removedLogin: boolean): string {
  if (removedLogin) return 'the server rejected the stored login for it, so toolmenu removed it';
  if (s.rejected === 'client') return "the stored login no longer works: the server doesn't accept the client toolmenu registered (it may have been deleted), so its tokens were dropped";
  if (s.rejected === 'refresh') return 'the stored login no longer works: its token expired or was revoked and the server refused to refresh it';
  if (s.tokens) return 'the stored login no longer works: the server refused its token';
  if (s.clientInformation) return "there's no stored login for it: an earlier toolmenu auth login registered a client but didn't finish";
  return `there's no stored login for it (stored in ${authDir()})`;
}

export class LoginNeededError extends Error {
  constructor(serverUrl: string, why = `there's no stored login for it (stored in ${authDir()})`) {
    super(
      `${serverUrl} asks for an OAuth login, and ${why}. snapshot and session don't open a browser.\n` +
        `→ Next: Log in once in a terminal with a browser: toolmenu auth login ${serverUrl}. Or pass a token: --header "Authorization: Bearer <token>".`,
    );
  }
}

export interface LoginOptions extends Omit<ProviderOptions, 'interactive' | 'onRedirect'> {
  /** How to show the authorization URL. Default: print it and try to open a browser. */
  open?: (url: URL) => void | Promise<void>;
  /** How long to wait for the browser to come back (default 5 min). */
  timeoutMs?: number;
}

/**
 * Log in to an OAuth-protected MCP server: register (or reuse a client), open the
 * authorization URL, receive the code on a loopback redirect, check `state`,
 * exchange the code (PKCE, issuer check: the SDK's), then connect once with the new
 * token to confirm it works. Returns the server's name and tool count.
 */
export async function login(serverUrl: string, options: LoginOptions = {}): Promise<{ name?: string; tools: number }> {
  const port = options.port ?? DEFAULT_PORT;
  const callback = await listenForCallback(port, options.timeoutMs ?? 300_000);
  try {
    const provider = new StoredOAuthProvider(serverUrl, { ...options, port, interactive: true, onRedirect: options.open ?? openInBrowser });
    // Each login discovers the authorization server afresh (a server may have
    // moved); the state is then kept for the callback leg's check.
    await provider.invalidateCredentials('discovery');
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
    const client = new Client({ name: 'toolmenu', version: VERSION });
    try {
      await client.connect(transport);
      // Already logged in with a valid (or refreshed) token.
      await client.close();
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const params = await callback.params;
      if (params.get('error')) {
        const described = params.get('error_description');
        throw new Error(
          `The authorization server refused the login for ${serverUrl}: ${params.get('error')}${described ? ` (“${described}”)` : ''}.\n` +
            `→ Next: Try again. If it repeats, ask for fewer scopes with --scope, or check the account may use this server.`,
        );
      }
      if (!provider.lastState || params.get('state') !== provider.lastState) {
        throw new Error(`The login callback for ${serverUrl} carried the wrong state (not the one this login sent), so it was ignored (an old browser tab, or a second login at once).\n→ Next: Run toolmenu auth login ${serverUrl} again and use the tab it opens.`);
      }
      await transport.finishAuth(params);
      await client.close().catch(() => {});
    }
    return await check(serverUrl);
  } catch (error) {
    // GitHub's hosted server, for one: no dynamic registration, so toolmenu can't
    // register itself. Say what works instead.
    if (error instanceof Error && /does not support dynamic client registration/i.test(error.message) && !options.clientId) {
      error.message =
        `${serverUrl} doesn't let clients register themselves (its authorization server has no dynamic client registration), so toolmenu can't log in without a client of its own.\n` +
        `→ Next: Register an OAuth app with the provider, with the callback URL http://127.0.0.1:${port}/callback, then:\n` +
        `      toolmenu auth login ${serverUrl} --client-id <id> --client-secret <secret>\n` +
        `  Or skip OAuth and pass a token the server accepts: toolmenu snapshot ${serverUrl} --header "Authorization: Bearer <token>"`;
    }
    throw error;
  } finally {
    callback.close();
  }
}

/** Connect with the stored login and list tools: the login works. */
async function check(serverUrl: string): Promise<{ name?: string; tools: number }> {
  const client = new Client({ name: 'toolmenu', version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: new StoredOAuthProvider(serverUrl) }));
  try {
    const { tools } = await client.listTools();
    return { name: client.getServerVersion()?.name, tools: tools.length };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function logout(serverUrl: string): Promise<boolean> {
  const had = hasLogin(serverUrl);
  await rm(storePath(serverUrl), { force: true });
  return had;
}

/** Stored logins: the server, its issuer, and when the tokens were saved. No secrets. */
export async function listLogins(): Promise<{ serverUrl: string; issuer?: string; savedAt?: string }[]> {
  if (!existsSync(authDir())) return [];
  const out = [];
  for (const f of readdirSync(authDir()).filter((f) => f.endsWith('.json'))) {
    try {
      const s = JSON.parse(await readFile(join(authDir(), f), 'utf8')) as Stored;
      out.push({ serverUrl: s.serverUrl, issuer: s.issuer, savedAt: s.savedAt });
    } catch {
      // not ours
    }
  }
  return out;
}

/** A one-shot HTTP server on 127.0.0.1 that resolves with the callback's query. */
function listenForCallback(port: number, timeoutMs: number): Promise<{ params: Promise<URLSearchParams>; close: () => void }> {
  return new Promise((ready, fail) => {
    let resolveParams!: (p: URLSearchParams) => void;
    let rejectParams!: (e: Error) => void;
    const params = new Promise<URLSearchParams>((resolve, reject) => {
      resolveParams = resolve;
      rejectParams = reject;
    });
    params.catch(() => {}); // surfaced where it's awaited
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>toolmenu</title><p>Logged in. You can close this tab and go back to the terminal.</p>');
      resolveParams(url.searchParams);
    });
    const timer = setTimeout(
      () =>
        rejectParams(
          new Error(
            `The browser login didn't come back within ${Math.round(timeoutMs / 1000)} s: nothing reached http://127.0.0.1:${port}/callback.\n` +
              `→ Next: Run toolmenu auth login again and finish it in the browser. The browser has to run on this machine (127.0.0.1); over SSH, log in on your own machine and copy ${authDir()}, or pass a token with --header.`,
          ),
        ),
      timeoutMs,
    );
    server.on('error', (error: NodeJS.ErrnoException) =>
      fail(
        error.code === 'EADDRINUSE'
          ? new Error(
              `Couldn't wait for the login's redirect: port ${port} on 127.0.0.1 is in use (another toolmenu login, or another program).\n` +
                `→ Next: Close it, or pick another port with --port <n>. The login registers http://127.0.0.1:<n>/callback, so use the same port the next time too.`,
            )
          : error,
      ),
    );
    server.listen(port, '127.0.0.1', () =>
      ready({
        params,
        close: () => {
          clearTimeout(timer);
          server.closeAllConnections();
          server.close();
        },
      }),
    );
  });
}

/** Print the URL (always) and try to open it (best effort). */
function openInBrowser(url: URL): void {
  const scope = url.searchParams.get('scope');
  // toolmenu only lists tools and calls read-only ones, but it asks for the
  // server's default scopes, as other clients do: some servers show tools by scope.
  if (scope) process.stderr.write(`Asking for the server's default scopes: ${scope} (narrower: --scope; toolmenu never calls a write tool on its own)\n`);
  process.stderr.write(`Opening your browser to log in. If it doesn't open, visit:\n  ${url.href}\n`);
  // Not `cmd /c start` on Windows: cmd reads the URL's `&` as a command separator,
  // cutting the URL, and the URL comes from the server's metadata. rundll32 opens
  // it in the default browser without a shell.
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url.href]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url.href]]
        : ['xdg-open', [url.href]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // printed above
  }
}
