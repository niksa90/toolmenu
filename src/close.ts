import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Client, Transport } from '@modelcontextprotocol/client';

/** A server that never answers the DELETE must not hold the run up. */
const END_SESSION_MS = 3000;

/**
 * Close a client and end its HTTP session. Closing the client only drops the
 * connection: the server keeps the session (Mcp-Session-Id) until a DELETE ends
 * it, and servers that keep idle sessions for hours under a cap fill up after a
 * few dozen runs. A server that doesn't allow the DELETE (405) is fine.
 */
export async function endSession(client: Client, transport: Transport): Promise<void> {
  if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) await Promise.race([transport.terminateSession().catch(() => {}), new Promise<void>((done) => setTimeout(done, END_SESSION_MS).unref())]);
  await client.close().catch(() => {});
}
