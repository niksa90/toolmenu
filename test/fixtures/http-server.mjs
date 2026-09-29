// The forms server over Streamable HTTP, on a random local port.
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { build } from './forms.mjs';

// limit: answer every POST after the first `limit` with 429, the way a per-IP rate
// limiter does, until `resetAfterMs` has passed since the first refusal (never, if unset).
export async function start({ factory = build, limit = Infinity, resetAfterMs } = {}) {
  const handler = createMcpHandler(factory);
  const seen = { authorization: [], posts: 0, refused: 0 };
  let refusingSince;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && ++seen.posts > limit) {
      refusingSince ??= Date.now();
      if (resetAfterMs === undefined || Date.now() - refusingSince < resetAfterMs) {
        seen.refused++;
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '1' }).end('Too many requests, please try again later.');
        return;
      }
      seen.posts = 0;
      refusingSince = undefined;
    }
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
