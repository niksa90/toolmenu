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

/** Is there a stored login for this server? */
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
    if (this.options.clientId) {
      return { client_id: this.options.clientId, ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}) } as StoredOAuthClientInformation;
    }
    const s = await this.stored();
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
    await this.update({ tokens, ...(ctx?.issuer ? { issuer: ctx.issuer } : {}) });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.interactive) {
      throw new LoginNeededError(this.serverUrl);
    }
    await this.options.onRedirect?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.stored()).codeVerifier;
    if (!v) throw new Error('No PKCE code verifier saved for this login.');
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
      this.data = { serverUrl: s.serverUrl };
      await rm(storePath(this.serverUrl), { force: true });
      return;
    }
    const patch: Partial<Stored> = {};
    if (scope === 'client') patch.clientInformation = undefined;
    if (scope === 'tokens') patch.tokens = undefined;
    if (scope === 'verifier') patch.codeVerifier = undefined;
    if (scope === 'discovery') patch.discoveryState = undefined;
    await this.update(patch);
  }
}

export class LoginNeededError extends Error {
  constructor(serverUrl: string) {
    super(`${serverUrl} needs an OAuth login, and toolmenu can't open a browser here. Run: toolmenu auth login ${serverUrl}`);
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
      if (params.get('error')) throw new Error(`The authorization server refused the login: ${params.get('error')}`);
      if (!provider.lastState || params.get('state') !== provider.lastState) throw new Error('The login callback carried the wrong state, so it was ignored. Try again.');
      await transport.finishAuth(params);
      await client.close().catch(() => {});
    }
    return await check(serverUrl);
  } catch (error) {
    // GitHub's hosted server, for one: no dynamic registration, so toolmenu can't
    // register itself. Say what works instead.
    if (error instanceof Error && /does not support dynamic client registration/i.test(error.message) && !options.clientId) {
      error.message =
        `${serverUrl} doesn't let clients register themselves (no dynamic client registration). Two ways in:\n` +
        `  - register an OAuth app with the provider, with the callback URL http://127.0.0.1:${port}/callback, then:\n` +
        `      toolmenu auth login ${serverUrl} --client-id <id> --client-secret <secret>\n` +
        `  - or skip OAuth and pass a token the server accepts: toolmenu snapshot ${serverUrl} --header "Authorization: Bearer <token>"`;
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
    const timer = setTimeout(() => rejectParams(new Error(`No login came back within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    server.on('error', (error: NodeJS.ErrnoException) =>
      fail(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use: pick another with --port (the login registers that redirect).`) : error),
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
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url.href]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.href]] : ['xdg-open', [url.href]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // printed above
  }
}
