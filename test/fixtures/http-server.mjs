// The forms server over Streamable HTTP, on a random local port.
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { build } from './forms.mjs';

export async function start({ factory = build } = {}) {
  const handler = createMcpHandler(factory);
  const seen = { authorization: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.authorization.push(req.headers.authorization);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const s = await start();
  console.log(s.url);
}
