// toolmenu auth check: OAuth discovery checked the way a spec-following client walks it,
// against a local server that plays each case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { authCheck, resourceMetadataOf, serverMetadataUrls, wellKnownResource } from '../dist/auth-check.js';

/** A server whose discovery documents are set by `docs` (path → JSON, or a status code). */
async function serve(docs, { header = true } = {}) {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.method === 'POST' && req.url === '/mcp') {
      res.writeHead(401, header ? { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } : {});
      return res.end();
    }
    const doc = docs(base)[req.url];
    if (typeof doc === 'number' || doc === undefined) {
      res.writeHead(doc ?? 404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(doc));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((r) => server.close(r)) };
}
const prm = (base, extra = {}) => ({ resource: `${base}/mcp`, authorization_servers: [base], ...extra });
const as = (extra = {}) => ({ issuer: 'x', code_challenge_methods_supported: ['S256'], registration_endpoint: '/register', ...extra });
const rules = (r) => r.findings.map((f) => `${f.rule}:${f.severity}`);

async function check(docs, opts) {
  const s = await serve(docs, opts);
  try {
    return await authCheck(s.url, 5000);
  } finally {
    await s.close();
  }
}

test('helpers: resource_metadata from the header, the well-known URIs in the spec\'s order', () => {
  assert.equal(resourceMetadataOf('Bearer realm="x", resource_metadata="https://a/.well-known/oauth-protected-resource/mcp"'), 'https://a/.well-known/oauth-protected-resource/mcp');
  assert.deepEqual(wellKnownResource('https://a.example/public/mcp'), { path: 'https://a.example/.well-known/oauth-protected-resource/public/mcp', root: 'https://a.example/.well-known/oauth-protected-resource' });
  assert.deepEqual(serverMetadataUrls('https://auth.example/tenant1'), [
    'https://auth.example/.well-known/oauth-authorization-server/tenant1',
    'https://auth.example/.well-known/openid-configuration/tenant1',
    'https://auth.example/tenant1/.well-known/openid-configuration',
  ]);
});

test('a server that does it all to spec: no findings', async () => {
  const r = await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b), '/.well-known/oauth-authorization-server': as() }));
  assert.deepEqual(rules(r), []);
  assert.equal(r.foundBy, 'header');
  assert.equal(r.registration, 'dynamic');
});

test('no WWW-Authenticate, but the well-known URI: info, it still works', async () => {
  const r = await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b), '/.well-known/oauth-authorization-server': as() }), { header: false });
  assert.deepEqual(rules(r), ['auth/discovery:info']);
  assert.equal(r.foundBy, 'well-known path');
});

test('a 401 naming metadata that isn\'t there (404): an error', async () => {
  assert.deepEqual(rules(await check(() => ({}))), ['auth/discovery:error']);
});

test('a 401 with no WWW-Authenticate and no metadata: OAuth not advertised, info (the server may take API keys)', async () => {
  assert.deepEqual(rules(await check(() => ({}), { header: false })), ['auth/discovery:info']);
});

test('metadata that can\'t be read (403 everywhere): not checked, said as info, never an error', async () => {
  assert.deepEqual(rules(await check(() => ({ '/.well-known/oauth-protected-resource/mcp': 403, '/.well-known/oauth-protected-resource': 403 }))), ['auth/discovery:info']);
  const r = await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b), '/.well-known/oauth-authorization-server': 403, '/.well-known/openid-configuration': 403 }));
  assert.deepEqual(rules(r), ['auth/server-metadata:info']);
});

test('a resource on another origin: an error; a same-origin parent, or a trailing slash only: a warning (the SDK accepts them)', async () => {
  assert.deepEqual(rules(await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b, { resource: 'https://elsewhere.example/mcp' }), '/.well-known/oauth-authorization-server': as() }))), ['auth/resource-metadata:error']);
  assert.deepEqual(rules(await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b, { resource: b }), '/.well-known/oauth-authorization-server': as() }))), ['auth/resource-metadata:warn']);
  assert.deepEqual(rules(await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b, { resource: `${b}/mcp/` }), '/.well-known/oauth-authorization-server': as() }))), ['auth/resource-metadata:warn']);
});

test('no authorization_servers: an error', async () => {
  assert.deepEqual(rules(await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b, { authorization_servers: [] }) }))), ['auth/resource-metadata:error']);
});

test('no S256 in code_challenge_methods_supported: an error (clients MUST refuse); no registration: info', async () => {
  assert.deepEqual(rules(await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b), '/.well-known/oauth-authorization-server': as({ code_challenge_methods_supported: ['plain'] }) }))), ['auth/pkce:error']);
  const r = await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': prm(b), '/.well-known/oauth-authorization-server': as({ registration_endpoint: undefined }) }));
  assert.deepEqual(rules(r), ['auth/registration:info']);
  assert.equal(r.registration, 'none');
});

test('a server that doesn\'t ask for credentials: nothing to check', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await authCheck(`http://127.0.0.1:${server.address().port}/mcp`, 5000);
    assert.deepEqual(rules(r), ['auth/discovery:info']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('metadata found at the root well-known URI has the origin as its resource (RFC 9728 §3.3): no finding', async () => {
  const r = await check((b) => ({ '/.well-known/oauth-protected-resource': { resource: b, authorization_servers: [b] }, '/.well-known/oauth-authorization-server': as() }), { header: false });
  assert.equal(r.foundBy, 'well-known root');
  assert.deepEqual(rules(r), ['auth/discovery:info']);
});

test('root well-known metadata whose resource is the server URL itself: a warning (the SDK accepts it), not an error', async () => {
  const r = await check((b) => ({ '/.well-known/oauth-protected-resource': { resource: `${b}/mcp`, authorization_servers: [b] }, '/.well-known/oauth-authorization-server': as() }), { header: false });
  assert.deepEqual(rules(r), ['auth/discovery:info', 'auth/resource-metadata:warn']);
  assert.match(r.findings[1].message, /server's own URL/);
});

test('authorization server metadata served where the protected resource metadata belongs: one error that names the mix-up', async () => {
  const r = await check((b) => ({ '/.well-known/oauth-protected-resource/mcp': { issuer: `${b}/`, authorization_endpoint: `${b}/authorize`, code_challenge_methods_supported: ['S256'] } }));
  assert.deepEqual(rules(r), ['auth/resource-metadata:error']);
  assert.match(r.findings[0].message, /serves authorization server metadata .* not protected resource metadata/);
});
