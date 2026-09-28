import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasLogin, listLogins, login, logout } from '../dist/auth.js';
import { snapshot } from '../dist/snapshot.js';
import { start } from './fixtures/oauth-server.mjs';
import { run, tempDir } from './helpers.mjs';

// Every test stores its logins in its own directory, never the user's.
const isolated = () => (process.env.TOOLMENU_AUTH_DIR = tempDir());
let nextPort = 41000 + Math.floor(Math.random() * 2000);
const port = () => nextPort++;

/** A "browser" that follows the authorization redirect back to toolmenu's loopback. */
const browser = (tamper = (u) => u) => async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  const back = new URL(r.headers.get('location'));
  await fetch(tamper(back));
};

test('auth login: register, authorize, exchange, and snapshot uses the login', async () => {
  const dir = isolated();
  const server = await start();
  try {
    const p = port();
    // The SDK warns when a provider can't keep the discovery state (SEP-2352).
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    const result = await login(server.url, { port: p, open: browser() }).finally(() => (console.warn = warn));
    assert.deepEqual(warnings.filter((w) => w.includes('mcp-sdk')), []);
    assert.equal(result.tools > 0, true);
    assert.equal(server.seen.registrations, 1);
    assert.equal(hasLogin(server.url), true);
    // Stored where only the user can read it, with no token in the listing.
    const file = readdirSync(dir).find((f) => f.endsWith('.json'));
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
    const logins = await listLogins();
    assert.equal(logins.length, 1);
    assert.equal(logins[0].serverUrl, server.url);
    assert.equal(JSON.stringify(logins).includes('access_token'), false);
    // PKCE and state were sent.
    const params = server.seen.authorizeParams[0];
    assert.equal(params.code_challenge_method, 'S256');
    assert.ok(params.state);
    const { menu, findings } = await snapshot({ kind: 'http', url: server.url }, { timeoutMs: 15_000 });
    assert.ok(menu.tools.length > 0);
    assert.equal(findings.some((f) => f.rule === 'menu/connection-variance'), false);
    // A second login reuses the registered client.
    await login(server.url, { port: p, open: browser() });
    assert.equal(server.seen.registrations, 1);
  } finally {
    await server.close();
  }
});

test('auth: an expired token is refreshed; a revoked login says to log in again', async () => {
  isolated();
  const server = await start();
  try {
    await login(server.url, { port: port(), open: browser() });
    server.expireTokens();
    const { menu } = await snapshot({ kind: 'http', url: server.url }, { timeoutMs: 15_000, processes: 1 });
    assert.ok(menu.tools.length > 0);
    assert.equal(server.seen.refreshes, 1);
    server.revokeAll();
    await assert.rejects(snapshot({ kind: 'http', url: server.url }, { timeoutMs: 15_000, processes: 1 }), /toolmenu auth login/);
  } finally {
    await server.close();
  }
});

test('auth: a callback with the wrong state is refused', async () => {
  isolated();
  const server = await start();
  try {
    const tamper = (u) => {
      u.searchParams.set('state', 'forged');
      return u;
    };
    await assert.rejects(login(server.url, { port: port(), open: browser(tamper) }), /wrong state/);
  } finally {
    await server.close();
  }
});

test('auth: without a login, a 401 says how to log in; logout removes it; --no-auth skips it', async () => {
  isolated();
  const server = await start();
  try {
    await assert.rejects(snapshot({ kind: 'http', url: server.url }, { timeoutMs: 15_000, processes: 1 }), /toolmenu auth login/);
    await login(server.url, { port: port(), open: browser() });
    await assert.rejects(snapshot({ kind: 'http', url: server.url, noAuth: true }, { timeoutMs: 15_000, processes: 1 }), /401|nauthorized/);
    assert.equal(await logout(server.url), true);
    assert.equal(hasLogin(server.url), false);
    assert.equal(await logout(server.url), false);
  } finally {
    await server.close();
  }
});

test('cli: auth usage', async () => {
  isolated();
  assert.equal((await run(['auth'])).code, 2);
  assert.equal((await run(['auth', 'login'])).code, 2);
  assert.equal((await run(['auth', 'login', 'not-a-url'])).code, 2);
  assert.equal((await run(['auth', 'login', 'https://x.example/mcp', '--port', '99999'])).code, 2);
  assert.equal((await run(['auth', 'login', 'https://x.example/mcp', '--client-secret', 's'])).code, 2);
  const list = await run(['auth', 'list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /No logins/);
});

