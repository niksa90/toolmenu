// Reports, in its one tool's description, which proxy and CA variables it was started with.
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SECRET_TOKEN'];
const seen = Object.fromEntries(KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

serveStdio(() => {
  const server = new Server({ name: 'env-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: [{ name: 'report_env', description: JSON.stringify(seen), inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
    ttlMs: 60_000,
    cacheScope: 'private',
  }));
  return server;
});
