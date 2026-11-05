import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasLogin, listLogins, login, LoginNeededError, logout, StoredOAuthProvider } from '../dist/auth.js';
import { snapshot } from '../dist/snapshot.js';
import { start } from './fixtures/oauth-server.mjs';
import { CLI, run, tempDir, TIMEOUT_MS } from './helpers.mjs';

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
    const { menu, findings } = await snapshot({ kind: 'http', url: server.url }, { timeoutMs: TIMEOUT_MS });
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
    const { menu } = await snapshot({ kind: 'http', url: server.url }, { timeoutMs: TIMEOUT_MS, processes: 1 });
    assert.ok(menu.tools.length > 0);
    assert.equal(server.seen.refreshes, 1);
    server.revokeAll();
    await assert.rejects(snapshot({ kind: 'http', url: server.url }, { timeoutMs: TIMEOUT_MS, processes: 1 }), /toolmenu auth login/);
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
    await assert.rejects(snapshot({ kind: 'http', url: server.url }, { timeoutMs: TIMEOUT_MS, processes: 1 }), /toolmenu auth login/);
    await login(server.url, { port: port(), open: browser() });
    await assert.rejects(snapshot({ kind: 'http', url: server.url, noAuth: true }, { timeoutMs: TIMEOUT_MS, processes: 1 }), /401|nauthorized/);
    assert.equal(await logout(server.url), true);
    assert.equal(hasLogin(server.url), false);
    assert.equal(await logout(server.url), false);
  } finally {
    await server.close();
  }
});

// 2026-11-05 corpus run: scan took --no-auth without a word and used the stored logins anyway.
test('scan --no-auth skips stored logins; without it scan uses them', async () => {
  isolated();
  const server = await start();
  try {
    await login(server.url, { port: port(), open: browser() });
    const list = join(tempDir(), 'servers.txt');
    writeFileSync(list, `api\t${server.url}\n`);
    const used = JSON.parse((await run(['scan', '--json', list])).stdout).servers[0];
    assert.equal(used.checked, true, JSON.stringify(used));
    const skipped = await run(['scan', '--json', '--no-auth', list]);
    const row = JSON.parse(skipped.stdout).servers[0];
    assert.equal(row.checked, false);
    assert.match(row.failed, /wants credentials: .*401/);
    assert.doesNotMatch(skipped.stderr, /ignores/);
    assert.equal(skipped.code, 2);
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

test('auth: a server without dynamic registration says how to get in (GitHub\'s hosted server)', async () => {
  isolated();
  const server = await start({ registration: false });
  try {
    await assert.rejects(login(server.url, { port: port(), open: browser() }), (e) => /register an OAuth app/i.test(e.message) && /--client-id/.test(e.message) && /Authorization: Bearer/.test(e.message));
  } finally {
    await server.close();
  }
});

test('auth: a pre-registered app (--client-id, --client-secret) logs in without registering', async () => {
  isolated();
  const p = port();
  const app = { client_id: 'toolmenu-app', client_secret: 's3cret', redirect_uris: [`http://127.0.0.1:${p}/callback`] };
  const server = await start({ registration: false, preRegistered: app });
  try {
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    const result = await login(server.url, { port: p, clientId: app.client_id, clientSecret: app.client_secret, open: browser() }).finally(() => (console.warn = warn));
    assert.ok(result.tools > 0);
    // The pre-registered client carries the issuer stamp like stored ones (SEP-2352).
    assert.deepEqual(warnings.filter((w) => w.includes('mcp-sdk')), []);
    assert.equal(server.seen.registrations, 0);
    // Later commands refresh with the stored app, no --client-id needed.
    server.expireTokens();
    const { menu } = await snapshot({ kind: 'http', url: server.url }, { timeoutMs: TIMEOUT_MS, processes: 1 });
    assert.ok(menu.tools.length > 0);
    assert.equal(server.seen.refreshes, 1);
    // A wrong secret fails the exchange (after the stored login is revoked, so there is one).
    server.revokeAll();
    await assert.rejects(login(server.url, { port: p, clientId: app.client_id, clientSecret: 'wrong', open: browser() }), /invalid_client|401/);
  } finally {
    await server.close();
  }
});


test('auth: a login abandoned after registration is no login, not an expired one', async () => {
  isolated();
  const server = await start();
  try {
    // The browser never comes back: the client is registered, no token is ever issued.
    await assert.rejects(login(server.url, { port: port(), open: () => {}, timeoutMs: 300 }));
    assert.equal(hasLogin(server.url), true, 'the registration is on disk');
    const e = await snapshot({ kind: 'http', url: server.url }, { timeoutMs: TIMEOUT_MS, processes: 1 }).catch((x) => x);
    assert.match(e.message, /no stored login for it: an earlier toolmenu auth login registered a client but didn't finish/);
    assert.doesNotMatch(e.message, /refresh was refused|no longer works/);
    assert.match(e.message, /→ Next: .*toolmenu auth login/);
  } finally {
    await server.close();
  }
});

test('auth: a refused refresh is said so on this run and the next; a login the server rejected and removed is said so', async () => {
  isolated();
  const server = await start();
  try {
    await login(server.url, { port: port(), open: browser() });
    server.revokeAll();
    for (let i = 0; i < 2; i++) {
      const e = await snapshot({ kind: 'http', url: server.url }, { timeoutMs: TIMEOUT_MS, processes: 1 }).catch((x) => x);
      assert.match(e.message, /the server refused to refresh it/, `run ${i + 1}`);
      assert.doesNotMatch(e.message, /didn't finish|no stored login/, `run ${i + 1}`);
    }
    // invalidateCredentials('all') deletes the file: the message says the login was
    // rejected and removed, not that there never was one.
    await login(server.url, { port: port(), open: browser() });
    const provider = new StoredOAuthProvider(server.url);
    assert.ok(await provider.tokens());
    await provider.invalidateCredentials('all');
    assert.equal(hasLogin(server.url), false);
    const e = await provider.redirectToAuthorization(new URL(server.url)).catch((x) => x);
    assert.ok(e instanceof LoginNeededError);
    assert.match(e.message, /the server rejected the stored login for it, so toolmenu removed it/);
    assert.doesNotMatch(e.message, /no stored login/);
  } finally {
    await server.close();
  }
});

// 0.21: --no-browser. The browser runs elsewhere (a phone, a laptop with an SSH session
// open); the address it ends on is pasted back instead of reaching the loopback.
test('auth login --no-browser: the address the browser ends on, pasted back, finishes the login', async () => {
  isolated();
  const server = await start();
  try {
    const p = port();
    let shown;
    // The "other device": follows the authorization redirect but never reaches 127.0.0.1;
    // the user copies the address it ended on.
    const paste = async () => {
      while (!shown) await new Promise((r) => setTimeout(r, 10));
      const r = await fetch(shown, { redirect: 'manual' });
      return `  ${r.headers.get('location')}  `;
    };
    const err = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      const m = /https?:\/\/\S+\/authorize\S*/.exec(String(chunk));
      if (m) shown = m[0];
      return true;
    };
    const result = await login(server.url, { port: p, noBrowser: true, paste }).finally(() => (process.stderr.write = err));
    assert.ok(shown, 'the authorization URL is printed');
    assert.equal(result.tools > 0, true);
    assert.equal(hasLogin(server.url), true);
  } finally {
    await server.close();
  }
});

test('pastedRedirect: the whole address or its query; anything without a code or error is refused', async () => {
  const { pastedRedirect } = await import('../dist/auth.js');
  assert.equal(pastedRedirect('http://127.0.0.1:33418/callback?code=abc&state=xyz').get('code'), 'abc');
  assert.equal(pastedRedirect('"http://127.0.0.1:33418/callback?code=abc&state=xyz"').get('state'), 'xyz');
  assert.equal(pastedRedirect('?code=abc&state=xyz').get('code'), 'abc');
  assert.equal(pastedRedirect('code=abc&state=xyz').get('code'), 'abc');
  assert.equal(pastedRedirect('http://127.0.0.1:33418/callback?error=access_denied').get('error'), 'access_denied');
  assert.equal(pastedRedirect('hello'), undefined);
  assert.equal(pastedRedirect('http://127.0.0.1:33418/callback'), undefined);
});

// 0.21, from review: stdin that ends (</dev/null, a script) says so, and the loopback can still finish the login.
test('auth login --no-browser: stdin that ends says nothing can be pasted, and waits for the loopback instead', async () => {
  isolated();
  const server = await start();
  try {
    const { spawn } = await import('node:child_process');
    const p = port();
    const child = spawn(process.execPath, [CLI, 'auth', 'login', '--no-browser', '--port', String(p), server.url], { env: process.env });
    child.stdin.end();
    let stderr = '';
    const said = new Promise((resolve) => child.stderr.on('data', (d) => {
      stderr += d;
      if (/stdin ended/.test(stderr) && /\/authorize\S*/.test(stderr)) resolve();
    }));
    await said;
    assert.match(stderr, /Nothing can be pasted here \(stdin ended\): waiting for the browser to reach http:\/\/127\.0\.0\.1:\d+\/callback instead\./);
    // The browser, on this machine: follows the authorization URL to the loopback.
    const url = /https?:\/\/\S+\/authorize\S*/.exec(stderr)[0];
    const r = await fetch(url, { redirect: 'manual' });
    await fetch(r.headers.get('location'));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.equal(hasLogin(server.url), true);
  } finally {
    await server.close();
  }
});

test('auth login --no-browser: a bad line, then the address, piped in: the second line isn\'t lost', async () => {
  isolated();
  const server = await start();
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [CLI, 'auth', 'login', '--no-browser', '--port', String(port()), server.url], { env: process.env });
    let stderr = '';
    let sent = false;
    child.stderr.on('data', async (d) => {
      stderr += d;
      const m = /https?:\/\/\S+\/authorize\S*/.exec(stderr);
      if (m && !sent) {
        sent = true;
        child.stdin.end(`junk\n${(await fetch(m[0], { redirect: 'manual' })).headers.get('location')}\n`);
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stderr, /That has no code= or error= in it/);
    assert.doesNotMatch(stderr, /Nothing can be pasted/);
  } finally {
    await server.close();
  }
});
