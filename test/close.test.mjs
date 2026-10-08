import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { endSession } from '../dist/close.js';

const transportWith = (terminateSession) => {
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'));
  Object.defineProperty(transport, 'sessionId', { value: 'abc' });
  transport.terminateSession = terminateSession;
  return transport;
};

test('endSession: a server that never answers the DELETE does not hold the run up', async () => {
  let closed = false;
  const client = { close: async () => { closed = true; } };
  const started = Date.now();
  await endSession(client, transportWith(() => new Promise(() => {})));
  assert.ok(Date.now() - started < 6000, 'gave up after its own limit');
  assert.ok(closed, 'the client was still closed');
});

test('endSession: a refused DELETE is fine, and no session means no DELETE', async () => {
  let closed = 0;
  const client = { close: async () => { closed++; } };
  await endSession(client, transportWith(async () => { throw new Error('405'); }));
  let sent = 0;
  const none = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'));
  none.terminateSession = async () => { sent++; };
  await endSession(client, none);
  assert.equal(closed, 2);
  assert.equal(sent, 0);
});
