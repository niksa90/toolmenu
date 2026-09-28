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
