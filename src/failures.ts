/*
 * Why a tool call failed, from its error text. The patterns come from real
 * servers run with dummy credentials (FINDINGS F12): a failure that stops a call
 * before the tool's own logic runs says nothing about the menu, and shouldn't read
 * as a finding.
 */

export type FailureClass = 'auth' | 'environment' | 'network' | 'not-found' | 'invalid-arguments' | 'other';

/** Failures of the setup (credentials, this machine, the network), not of the server. */
export const SETUP_FAILURES = new Set<FailureClass>(['auth', 'environment', 'network', 'not-found']);

// Something this machine lacks: "Could not find Google Chrome executable"
// (Chrome DevTools), "Chromium distribution 'chrome' is not found at" (Playwright).
const ENVIRONMENT = /could not find [^.]{0,40}executable|is not found at \/|\bnot installed\b|command not found|cannot find (module|package)|\bENOENT\b/i;
// "401 Bad credentials" (GitHub), "Authorization Expired" (Sentry), "Invalid
// token" (Firecrawl), "authentication token is not valid" (Apify), "Please provide
// a valid access token" (Supabase), "NetlifyUnauthError: You're not logged into
// Netlify" (Netlify), "The API key you provided was rejected" (Pinecone). Not a
// bare "token": plenty of errors mention one.
const AUTH = /\b(401|403)\b|unauthori[sz]ed|unauth(enticated|error)|forbidden|bad credentials|authori[sz]ation expired|re-?authori[sz]e|not (authenticated|logged in)|authentication (token|failed|required|error)|(invalid|expired|revoked) (api[ _-]?key|access token|token|credentials)|(token|api[ _-]?key|credentials) (is |are )?(not valid|invalid|expired)|(api[ _-]?key|access token|credentials)\b[^.]{0,30}\b(was|were|is|are) (rejected|refused|revoked)|valid (access )?token/i;
const NETWORK = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH)\b|socket hang up|getaddrinfo|network error/i;
// "Either 'page_id' OR both 'title' and 'space_key' must be provided" (Atlassian),
// "**Input Error**" (Sentry), JSON-RPC's invalid params.
const INVALID_ARGUMENTS = /invalid (params|parameters|arguments|input)|input error|validation (error|failed)|must be provided|is required\b|\beither\b[^.]{0,80}\bor\b[^.]{0,80}\b(must|required)/i;
const NOT_FOUND = /\b404\b|not found/i;
/**
 * A refusal for too many requests, in a server's or an upstream API's words: "Too many
 * requests, please try again later." (express-rate-limit), "API rate limit exceeded"
 * (GitHub), "Request failed with status code 429" (axios). Not a bare "429" or
 * "rateLimit": "Order 429 not found", "rateLimit must be a positive number".
 */
export const RATE_LIMITED = /too many requests|rate[ _-]?limit(?:ed\b|s?[ _-](?:exceeded|reached|hit)\b)|exceeded (?:the |your )?rate[ _-]?limit|(?:status(?: code)?|HTTP) 429\b|\b429 too many/i;

/** The HTTP status a transport refused a request with: the SDK's SdkHttpError carries it, its SSE transport says "(HTTP 429)". */
export function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status;
  const m = /\(HTTP (\d{3})\)/.exec(error instanceof Error ? error.message : String(error));
  return m ? Number(m[1]) : undefined;
}

/** A thrown error that is a refusal for too many requests: a 429 from the transport, or the words for one. */
export function tooMany(error: unknown): boolean {
  return httpStatus(error) === 429 || RATE_LIMITED.test(error instanceof Error ? error.message : String(error));
}

/**
 * How long to wait before each retry of a refused request: a per-minute limit clears
 * within them. TOOLMENU_RATE_LIMIT_WAITS_MS ("100,200") sets others, for the CLI's
 * tests; a value that isn't a list of milliseconds keeps these, so a typo can't turn
 * the waiting off.
 */
export const RATE_LIMIT_WAITS_MS = waitsFrom(process.env.TOOLMENU_RATE_LIMIT_WAITS_MS) ?? [2000, 4000, 8000, 16_000, 32_000];

/** What to do about a rate limit toolmenu couldn't wait out. */
export const RATE_LIMIT_ADVICE = "The limit counts every request from this address, toolmenu's included: give the run its own server instance, or raise the limit for it.";

/** Quoted words that end a sentence: “Rate limit exceeded”. but “Try again later.” (no second period). */
export function quotedSentence(words: string): string {
  return `“${words}”${/[.!?…]$/.test(words) ? '' : '.'}`;
}

/** Why a check was skipped, as a clause: "rate-limited, and still after waiting 0.3 s (“…”)", or the server's words. */
export function whyNot(error: unknown, waitedMs: number): string {
  return tooMany(error) ? `rate-limited, and still after waiting ${waitedFor(waitedMs)} (“${serverWords(error)}”)` : serverWords(error, 200);
}

/** A wait, for a message: "0.3 s", "62 s". */
export function waitedFor(ms: number): string {
  return `${ms < 10_000 ? Math.round(ms / 100) / 10 : Math.round(ms / 1000)} s`;
}

export function waitsFrom(value: string | undefined): number[] | undefined {
  const parts = value?.split(',').map((p) => p.trim());
  if (!parts?.length || !parts.every((p) => /^\d+$/.test(p))) return undefined;
  return parts.map(Number);
}

/**
 * What the server said, from an error: the JSON-RPC error's message when the
 * transport quotes the response body ("Error POSTing to endpoint: {"jsonrpc":…}"),
 * without that prefix; the first line, at most `max` characters.
 */
export function serverWords(error: unknown, max = 100): string {
  let text = (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^.*?endpoint(?: \(HTTP \d{3}\))?:\s*/i, '').trim();
  const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  if (quoted !== undefined) {
    try {
      text = JSON.parse(`"${quoted}"`);
    } catch {
      text = quoted;
    }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Send a request, and again after each wait while it's refused for being too many.
 * `error` and `result` say whether a thrown error or a result is such a refusal and
 * safe to send again; `waited` adds up the time spent waiting.
 */
export async function patiently<T>(
  request: () => Promise<T>,
  options: { waits?: number[]; error?: (e: unknown) => boolean; result?: (r: T) => boolean; waited?: { ms: number } } = {},
): Promise<T> {
  const waits = options.waits ?? RATE_LIMIT_WAITS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await request();
      if (attempt >= waits.length || !options.result?.(r)) return r;
    } catch (error) {
      if (attempt >= waits.length || !options.error?.(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    if (options.waited) options.waited.ms += waits[attempt];
  }
}

/**
 * Classify a failed call. `code` is the JSON-RPC error code when the call threw.
 * `hadArguments`: a 404 on a call that named nothing (no arguments) means the
 * account or site behind the credentials isn't there (HubSpot answers a bad token
 * with 404; a made-up Jira URL 404s), which is setup, not the server's fault.
 */
export function classifyFailure(text: string, options: { code?: number; hadArguments?: boolean } = {}): FailureClass {
  if (ENVIRONMENT.test(text)) return 'environment';
  if (AUTH.test(text)) return 'auth';
  if (NETWORK.test(text)) return 'network';
  if (options.code === -32602 || INVALID_ARGUMENTS.test(text)) return 'invalid-arguments';
  if (NOT_FOUND.test(text) && !options.hadArguments) return 'not-found';
  return 'other';
}

export const FAILURE_LABELS: Record<FailureClass, string> = {
  auth: 'authentication',
  environment: 'something missing on this machine',
  network: 'the network',
  'not-found': 'a 404 on a call that named nothing (usually the account or site behind the credentials)',
  'invalid-arguments': 'the arguments',
  other: 'other errors',
};

/**
 * The next step for calls that failed before reaching the tool, per SPEC §25.
 * The class is read from the error's words, so it's a guess: `confidence` is
 * 'unsure', and the step says what to check rather than what's wrong.
 */
export function setupFailureAdvice(classes: Iterable<FailureClass>, transport: 'stdio' | 'http'): { fix: string; confidence: 'unsure' } {
  const set = new Set(classes);
  const credentials = transport === 'http' ? '--header "Authorization: …"' : '--env KEY=…';
  const steps: string[] = [];
  if (set.has('auth') || set.has('not-found')) steps.push(`If the errors are about credentials, rerun with real ones (${credentials}); a test account is enough.`);
  if (set.has('environment')) steps.push('If something is missing on this machine (a browser, a binary, a module), install it where the server runs, or run the server in its own container image.');
  if (set.has('network')) steps.push('If the server calls an upstream API, check this machine can reach it (DNS, proxy, firewall).');
  return { fix: steps.join(' ') || 'Check the quoted errors: they came from before the tool ran.', confidence: 'unsure' };
}
