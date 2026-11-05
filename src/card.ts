/*
 * MCP Server Cards (SEP-2127, ext-server-card): a static document describing a remote
 * server, read before connecting. Its reserved location is `<streamable-http-url>/server-card`,
 * served as application/mcp-server-card+json. Its version and protocol versions SHOULD NOT
 * contradict what the live connection reports (ext-server-card docs/discovery.md,
 * "Consistency with Runtime Behavior"). Schema: schemas/server-card.json, from
 * modelcontextprotocol/ext-server-card at 526201bb.
 */

export const CARD_MEDIA_TYPE = 'application/mcp-server-card+json';

export interface CardRead {
  /** Where it was asked for: the server URL's origin and path, then /server-card. */
  url: string;
  status?: number;
  contentType?: string;
  /** The document, when the answer was JSON. */
  card?: unknown;
  /** Why it couldn't be read (network, timeout). */
  error?: string;
}

/** The reserved card location for a Streamable HTTP URL: its query left out, /server-card appended to its path. */
export function cardUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/server-card`;
}

/**
 * GET the card from its reserved location. No credentials: cards are public by design,
 * and the request goes to a path the MCP endpoint didn't ask to receive them on.
 */
export async function readServerCard(serverUrl: string, timeoutMs = 10_000): Promise<CardRead> {
  const url = cardUrl(serverUrl);
  try {
    const response = await fetch(url, { headers: { Accept: `${CARD_MEDIA_TYPE}, application/json;q=0.9` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const contentType = response.headers.get('content-type') ?? '';
    const out: CardRead = { url, status: response.status, contentType };
    if (!response.ok || !/json/i.test(contentType)) return out;
    const text = await response.text();
    try {
      out.card = JSON.parse(text);
    } catch {
      // Says JSON, isn't: no card.
    }
    return out;
  } catch (error) {
    return { url, error: (error instanceof Error ? error.message : String(error)).split('\n')[0] };
  }
}
