import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Client, Transport } from '@modelcontextprotocol/client';

/**
 * Close a client and end its HTTP session. Closing the client only drops the
 * connection: the server keeps the session (Mcp-Session-Id) until a DELETE ends
 * it, and servers that keep idle sessions for hours under a cap fill up after a
 * few dozen runs. A server that doesn't allow the DELETE (405) is fine.
 */
export async function endSession(client: Client, transport: Transport): Promise<void> {
  if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {});
}
