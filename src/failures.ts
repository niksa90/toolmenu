/*
 * Why a tool call failed, from its error text. The patterns come from real
 * servers run with dummy credentials (FINDINGS F12): a failure that stops a call
 * before the tool's own logic runs says nothing about the menu, and shouldn't read
 * as a finding.
 */

export type FailureClass = 'auth' | 'payment' | 'environment' | 'network' | 'not-found' | 'client' | 'invalid-arguments' | 'other';

/** Failures of the setup (credentials, this machine, the network), not of the server. */
export const SETUP_FAILURES = new Set<FailureClass>(['auth', 'payment', 'environment', 'network', 'not-found', 'client']);

// A tool that asks the client for something toolmenu doesn't offer: "Cannot request
// input 'roots' (roots/list): the request's client capabilities do not declare the
// required capability" (server-everything's get-roots-list), sampling, elicitation.
const CLIENT = /client capabilit(?:y|ies)\b[^.]{0,60}\b(?:do(?:es)? not|don't|doesn't|lack|missing|without)\b|\b(?:roots|sampling|elicitation)\b[^.]{0,40}\bnot (?:supported|declared|available)\b[^.]{0,20}\bclient\b|client does not support (?:roots|sampling|elicitation)/i;

// Something this machine lacks: "Could not find Google Chrome executable"
// (Chrome DevTools), "Chromium distribution 'chrome' is not found at" (Playwright),
// or the wrong operating system: "Editmamei runs on Windows and macOS; this process
// is on "linux"" (editmamei), "Unsupported platform: linux" (an OS name, not any
// "platform" argument: "Unsupported platform: myspace" is the tool's own error).
const ENVIRONMENT = /could not find [^.]{0,40}executable|is not found at \/|\bnot installed\b|command not found|cannot find (module|package)|\bENOENT\b|\bruns on [^.;]{0,40}; this (?:process|machine|system) is on\b|\bunsupported (?:platform|operating system|OS)(?:\s*[.!]?\s*$|\s*\.\s|[^.\n]{0,40}?\b(?:linux|darwin|macos|win32|windows(?:_nt)?|freebsd|openbsd|aix|sunos|android)(?![a-z]))|\bnot supported on (?:this|the current) (?:platform|operating system|OS)\b/i;
// "401 Bad credentials" (GitHub), "Authorization Expired" (Sentry), "Invalid
// token" (Firecrawl), "authentication token is not valid" (Apify), "Please provide
// a valid access token" (Supabase), "NetlifyUnauthError: You're not logged into
// Netlify" (Netlify), "The API key you provided was rejected" (Pinecone), "Admin
// auth is missing", "Runtime credentials are missing" (securenow). Not a bare
// "token": plenty of errors mention one.
// Hosted servers ask the user to sign in in their own words: "Sign in to Ideal (or create
// your creator account) to continue", "Connect your Novamris account to read its saved chart".
const SIGN_IN = /\bsign in to\b|\blog ?in to (?:continue|use)\b|\bconnect your [\w .'-]{1,40}? account\b/i;
// A paid tool: "Payment required: $0.50 over MPP" (a hosted server), HTTP 402, no credits left.
const PAYMENT = /\bpayment required\b|\b(?:HTTP|status(?: code)?) 402\b|\binsufficient (?:credits?|balance|funds)\b/i;
const AUTH = /\b(?:auth|authentication|credentials?|api[ _-]?key|access token)\b (?:is |are )?missing\b|\bno (?:authentication|auth|credentials?|api[ _-]?keys?|access tokens?|auth tokens?) (?:was |were )?(?:found|provided|configured|set|given)\b|\b(401|403)\b|unauthori[sz]ed|unauth(enticated|error)|forbidden|bad credentials|authori[sz]ation expired|re-?authori[sz]e|not authenticated|not logged (?:in|into)\b(?! to the browser)|authentication (token|failed|required|error)|(invalid|expired|revoked) (api[ _-]?key|access token|token|credentials)|(token|api[ _-]?key|credentials) (is |are )?(not valid|invalid|expired)|(api[ _-]?key|access token|credentials)\b[^.]{0,30}\b(was|were|is|are) (rejected|refused|revoked)|valid (access )?token/i;
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

/**
 * A tool's error text with the reason up front: "400 Bad Request: {"message":"Filter by
 * X is mandatory"}" says "400 Bad Request: Filter by X is mandatory". Text with no JSON
 * message in it is returned as it is.
 */
export function errorWords(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return text;
  let reason: string | undefined;
  try {
    const body: unknown = JSON.parse(text.slice(start, end + 1));
    const pick = (o: unknown): string | undefined => {
      if (typeof o !== 'object' || o === null) return undefined;
      const r = o as Record<string, unknown>;
      for (const key of ['message', 'detail', 'error_description', 'error']) {
        const v = r[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
        const inner = typeof v === 'object' ? pick(v) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    reason = pick(body);
  } catch {
    reason = undefined;
  }
  if (!reason) return text;
  const lead = text.slice(0, start).trim().replace(/[:\-–]+$/, '').trim();
  const tail = text.slice(end + 1).trim();
  return [lead ? `${lead}: ${reason}` : reason, tail].filter(Boolean).join(' ');
}

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
  // 2026-07-28's MissingRequiredClientCapabilityError, by its code.
  if (options.code === -32021 || CLIENT.test(text)) return 'client';
  if (ENVIRONMENT.test(text)) return 'environment';
  if (PAYMENT.test(text)) return 'payment';
  if (AUTH.test(text) || SIGN_IN.test(text)) return 'auth';
  if (NETWORK.test(text)) return 'network';
  if (options.code === -32602 || INVALID_ARGUMENTS.test(text)) return 'invalid-arguments';
  if (NOT_FOUND.test(text) && !options.hadArguments) return 'not-found';
  return 'other';
}

export const FAILURE_LABELS: Record<FailureClass, string> = {
  auth: 'authentication',
  payment: 'payment (a paid tool)',
  environment: 'something missing on this machine',
  network: 'the network',
  'not-found': 'a 404 on a call that named nothing (usually the account or site behind the credentials)',
  client: "a client capability the request didn't declare",
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
  if (set.has('payment')) steps.push('If a tool asks for payment, it can\'t be checked without paying: leave it out of the scenario, or run with an account that has credit.');
  if (set.has('environment')) steps.push('If something is missing on this machine (a browser, a binary, a module), install it where the server runs, or run the server in its own container image.');
  if (set.has('client')) steps.push("If a tool needs a client capability toolmenu doesn't declare (roots and sampling, which 2026-07-28 deprecates, or one the error names), those calls only checked that the menu stays put, and the server isn't at fault.");
  if (set.has('network')) steps.push('If the server calls an upstream API, check this machine can reach it (DNS, proxy, firewall).');
  return { fix: steps.join(' ') || 'Check the quoted errors: they came from before the tool ran.', confidence: 'unsure' };
}

const DENIED_CODES = /^(?:unauthori[sz]ed|unauthenticated|forbidden|invalid_auth|invalid_token|not_authed|authentication_(?:required|failed)|permission_denied)$/i;

/**
 * A result not marked isError whose content is an HTTP auth error in structured form:
 * the API the tool calls said 401 or 403 and the server passed the body on as an
 * answer. Notion's server returns `{"status":401,"object":"error","code":"unauthorized"}`
 * as a plain result. Only a JSON object whose own status or code says so counts, not
 * "401" anywhere in the data. Says what it saw, or undefined.
 */
export function deniedAnswer(result: { content?: unknown; structuredContent?: unknown }, options: { fetches?: boolean } = {}): string | undefined {
  // A tool that fetches a URL (options.fetches) answers with the page's status: only an
  // auth code (unauthorized, invalid_auth) counts there, never a status.
  const objects: unknown[] = [result.structuredContent];
  for (const c of Array.isArray(result.content) ? result.content : []) {
    const text = c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text.trim() : '';
    if (!text.startsWith('{')) continue;
    try {
      objects.push(JSON.parse(text));
    } catch {
      // not JSON
    }
  }
  for (const o of objects) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    for (const v of [o as Record<string, unknown>, (o as Record<string, unknown>).error]) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const r = v as Record<string, unknown>;
      const status = [r.status, r.statusCode, r.status_code, r.code].find((x) => x === 401 || x === 403 || x === '401' || x === '403');
      const code = [r.code, r.error, r.type].find((x) => typeof x === 'string' && DENIED_CODES.test(x));
      // A status alone may be what the tool was asked to fetch ({"status":403,"body":…});
      // with it, the object has to say it's an error.
      const isError = v !== o || r.object === 'error' || (r.error !== undefined && r.error !== null && r.error !== false && r.error !== '') || typeof r.message === 'string';
      if (code === undefined && (status === undefined || !isError || options.fetches)) continue;
      const message = typeof r.message === 'string' ? `: ${r.message}` : '';
      return `${status !== undefined ? `HTTP ${status}` : String(code)}${message}`;
    }
  }
  return undefined;
}
