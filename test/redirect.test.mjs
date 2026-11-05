// A server that redirects to another origin: the MCP SDK (2.3 and later) doesn't follow
// it, so toolmenu says so, with the URL to use, and clients fail the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { crossOriginRedirect } from '../dist/connect.js';
import { start } from './fixtures/http-server.mjs';
import { run } from './helpers.mjs';

const redirect = (status, location) => new Response(null, { status, headers: location ? { location } : {} });

test('crossOriginRedirect: the SDK origin rule, exactly', () => {
  const from = 'http://example.com/mcp';
  assert.deepEqual(crossOriginRedirect(from, redirect(307, 'http://other.example.com/mcp')), { from, to: 'http://other.example.com/mcp' });
  assert.deepEqual(crossOriginRedirect(from, redirect(308, 'http://example.com:8080/mcp')), { from, to: 'http://example.com:8080/mcp' }, 'another port is another origin');
  assert.equal(crossOriginRedirect(from, redirect(307, '/v2/mcp')), undefined, 'same origin, another path');
  assert.equal(crossOriginRedirect(from, redirect(301, 'https://example.com/mcp')), undefined, 'http to https on the same host, default ports');
  assert.ok(crossOriginRedirect('http://example.com:8080/mcp', redirect(301, 'https://example.com:8443/mcp')), 'http to https with ports is another origin');
  assert.ok(crossOriginRedirect('https://example.com/mcp', redirect(302, 'http://example.com/mcp')), 'https to http is not followed');
  assert.equal(crossOriginRedirect(from, redirect(200)), undefined);
  assert.equal(crossOriginRedirect(from, redirect(304, 'http://other.example.com/')), undefined, '304 is not a redirect');
  assert.equal(crossOriginRedirect(from, redirect(307)), undefined, 'no Location header');
  assert.equal(crossOriginRedirect(from, redirect(307, 'http://[bad')), undefined, 'a Location that is not a URL');
});

async function redirector(to) {
  const r = createServer((req, res) => res.writeHead(307, { location: to(req) }).end()).listen(0, '127.0.0.1');
  await new Promise((ok) => r.once('listening', ok));
  return { url: `http://127.0.0.1:${r.address().port}/mcp`, port: r.address().port, close: () => new Promise((ok) => r.close(ok)) };
}

test('snapshot: a redirect to another origin is an error naming the URL to use', async () => {
  const s = await start();
  const r = await redirector(() => s.url);
  try {
    const out = await run(['snapshot', '--no-write', '--timeout', '10000', r.url]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /redirects to another origin \(HTTP 307\)\. toolmenu doesn't follow it, and neither do clients built on the MCP TypeScript SDK 2\.3 or later/);
    assert.ok(out.stderr.includes(`redirects to  ${s.url}`), out.stderr);
    assert.ok(out.stderr.includes(`→ Next: Check with the URL it redirects to: toolmenu snapshot ${s.url}. If it's your server, give clients that URL`), out.stderr);
    assert.doesNotMatch(out.stderr, /most clients/, 'only the TypeScript SDK is known not to follow it');
    assert.doesNotMatch(out.stderr, /timed out|firewall/);
  } finally {
    await r.close();
    await s.close();
  }
});

test('snapshot: a redirect within the origin is followed, as the SDK does', async () => {
  const s = await start();
  // The redirector on its own port sends /old to itself at /mcp, which it forwards to the fixture.
  const forward = createServer(async (req, res) => {
    if (req.url === '/old') return res.writeHead(307, { location: '/mcp' }).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { ...req.headers };
    delete headers.host;
    const upstream = await fetch(s.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }).listen(0, '127.0.0.1');
  await new Promise((ok) => forward.once('listening', ok));
  try {
    const out = await run(['snapshot', '--no-write', '--json', '--timeout', '10000', `http://127.0.0.1:${forward.address().port}/old`]);
    assert.equal(out.code, 0, out.stderr);
    // --json gives the tool count, as in headers.test.mjs.
    const json = JSON.parse(out.stdout);
    assert.equal(json.tools.length ?? json.tools, 3);
    assert.equal(json.server.name, 'forms-fixture');
  } finally {
    await new Promise((ok) => forward.close(ok));
    await s.close();
  }
});
