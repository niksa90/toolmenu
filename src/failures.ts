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
// a valid access token" (Supabase). Not a bare "token": plenty of errors mention one.
const AUTH = /\b(401|403)\b|unauthori[sz]ed|forbidden|bad credentials|authori[sz]ation expired|re-?authori[sz]e|not authenticated|authentication (token|failed|required|error)|(invalid|expired|revoked) (api[ _-]?key|access token|token|credentials)|(token|api[ _-]?key|credentials) (is |are )?(not valid|invalid|expired)|valid (access )?token/i;
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
 * within them. TOOLMENU_RATE_LIMIT_WAITS_MS ("100,200") sets others (the CLI's tests).
 */
export const RATE_LIMIT_WAITS_MS = (process.env.TOOLMENU_RATE_LIMIT_WAITS_MS?.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0) ?? [
  2000, 4000, 8000, 16_000, 32_000,
]);

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
