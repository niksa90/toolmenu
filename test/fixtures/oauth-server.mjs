// The forms server behind OAuth, with its own minimal authorization server on the
// same local port: protected-resource and authorization-server metadata, dynamic
// registration, an authorize endpoint that approves at once, and token + refresh
// with PKCE. Enough for a real login flow in tests; not a real server.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { build } from './forms.mjs';

export async function start({ tokenLifetime = 3600 } = {}) {
  const handler = createMcpHandler(build);
  const clients = new Map();
  const codes = new Map();
  const tokens = new Map(); // access token → expiry (ms)
  const refreshes = new Set();
  const seen = { registrations: 0, refreshes: 0, authorizeParams: [] };
  let base = '';

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const issue = () => {
    const access = randomBytes(16).toString('hex');
    const refresh = randomBytes(16).toString('hex');
    tokens.set(access, Date.now() + tokenLifetime * 1000);
    refreshes.add(refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: tokenLifetime, refresh_token: refresh };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse(body);
      const client_id = `client-${++seen.registrations}`;
      clients.set(client_id, meta);
      return json(res, 201, { ...meta, client_id, token_endpoint_auth_method: 'none' });
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      seen.authorizeParams.push(Object.fromEntries(p));
      const client = clients.get(p.get('client_id'));
      const redirect = p.get('redirect_uri');
      if (!client || !client.redirect_uris?.includes(redirect)) return json(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect_uri' });
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: p.get('code_challenge'), redirect });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      if (p.get('state')) back.searchParams.set('state', p.get('state'));
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const entry = codes.get(p.get('code'));
        codes.delete(p.get('code'));
        const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (!entry || entry.challenge !== challenge) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue());
      }
      if (p.get('grant_type') === 'refresh_token' && refreshes.delete(p.get('refresh_token'))) {
        seen.refreshes++;
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const expiry = tokens.get(token);
      if (!expiry || expiry < Date.now()) {
        return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const response = await handler.fetch(new Request(`${base}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      return res.end();
    }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/mcp`,
    seen,
    /** Expire every access token now (refresh tokens stay valid). */
    expireTokens: () => {
      for (const k of tokens.keys()) tokens.set(k, 0);
    },
    /** Revoke everything: the next request needs a new login. */
    revokeAll: () => {
      tokens.clear();
      refreshes.clear();
    },
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
