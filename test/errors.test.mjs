import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { FIXTURES, run } from './helpers.mjs';
import { bodyExcerpt, formatBlock, stderrFact, Trace } from '../dist/explain.js';
import { setupFailureAdvice } from '../dist/failures.js';

const broken = (mode, timeout = 5000) => ['snapshot', '--no-write', '--timeout', String(timeout), '--env', `MODE=${mode}`, '--', process.execPath, join(FIXTURES, 'broken-server.mjs')];

test('errors: stdout that isn\'t JSON-RPC is quoted, with the fix', async () => {
  const r = await run(broken('stray', 800));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: initialize timed out after [\d.]+ s: the server wrote lines that aren't JSON-RPC to stdout/);
  assert.match(r.stderr, /stdout +“hello I am not json”\n +“Server listening on stdio”/);
  assert.match(r.stderr, /→ Next: Log to stderr; stdout carries the protocol/);
});

test('errors: a silent server says which stage timed out, how long each waited, and why twice', async () => {
  const r = await run(broken('silent', 800));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: initialize timed out after [\d.]+ s: the server is running but never answered\./);
  assert.match(r.stderr, /waited +[\d.]+ s on server\/discover \(no answer\), then [\d.]+ s on initialize \(--timeout 800 applies to each request\)/);
  assert.match(r.stderr, /why twice +server\/discover/);
  assert.match(r.stderr, /stderr +\(nothing\)/);
});

test('errors: a crash gives the exit code, the stage and the stderr', async () => {
  const r = await run(broken('crash'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: The server exited with code 3 before it answered initialize\./);
  assert.match(r.stderr, /│ boom: missing config/);
  const killed = await run(broken('signal'));
  assert.match(killed.stderr, /^toolmenu: The server was killed by SIGKILL/);
});

test('errors: a wrapper that keeps stderr open: the timeout is the cause, not toolmenu stopping it', async () => {
  const r = await run(['snapshot', '--no-write', '--timeout', '800', '--env', 'MODE=silent', '--', 'sh', '-c', `${process.execPath} ${join(FIXTURES, 'broken-server.mjs')}; true`]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: initialize timed out after [\d.]+ s: the server is running but never answered\./);
  assert.doesNotMatch(r.stderr, /killed by SIGTERM/);
  assert.match(r.stderr, /→ Next: Check the command starts an MCP server on stdio/);
});

test('errors: the server\'s own error answer is its words, even when they say "timed out"', async () => {
  const r = await run(broken('rpcerror'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: The server answered initialize with an error: “upstream API request timed out” \(-32603\)\./);
  assert.doesNotMatch(r.stderr, /never answered|closed its stdout/);
  assert.match(r.stderr, /→ Next: /);
});

test('errors: a long stderr shows its last lines, and says how many were cut', async () => {
  const r = await run(broken('longerr'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /last 12 of 301 lines \(289 earlier lines not shown\)/);
  assert.match(r.stderr, /│ Error: the real reason, at the end/);
  assert.doesNotMatch(r.stderr, /header-1:/);
  assert.ok(r.stderr.split('\n').length < 25, r.stderr);
});

test('errors: a server whose stderr says its key was rejected: the headline says so, as a guess', async () => {
  const hung = await run(broken('badkey', 800));
  assert.equal(hung.code, 2);
  assert.match(hung.stderr, /^toolmenu: initialize timed out after [\d.]+ s: the server is running but never answered; its stderr looks like rejected credentials \(“401 Unauthorized”\)\./);
  assert.match(hung.stderr, /→ Next: .*API key or token.*not certain/);
  const exited = await run(broken('badkeyexit'));
  assert.equal(exited.code, 2);
  assert.match(exited.stderr, /^toolmenu: The server exited with code 1 before it answered initialize; its stderr looks like rejected credentials \(“401”\)\./);
  assert.match(exited.stderr, /→ Next: .*API key or token/);
});

test('errors: a server that dies on tools/list: its stderr is read to the end, reason included', async () => {
  const r = await run(broken('listcrash'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: The server exited with code 1 before it answered tools\/list\./);
  assert.match(r.stderr, /│ Error: the tool registry failed to load/);
});

test('errors: a missing module is called a packaging problem', async () => {
  const r = await run(broken('missing'));
  assert.match(r.stderr, /missing one of its own dependencies/);
});

test('errors: a missing binary', async () => {
  const r = await run(['snapshot', '--no-write', '--', 'no-such-mcp-server-x', '--stdio']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: Couldn't start the server: “no-such-mcp-server-x” wasn't found \(spawn ENOENT\)\.\n +command +no-such-mcp-server-x --stdio\n +→ Next: Check it's installed/);
});

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

test('errors: a web page isn\'t an MCP endpoint: status, type, URL, a short excerpt, never the body', async () => {
  const page = `<!doctype html><html><head><title>Acme Docs</title><style>body{color:red}</style></head><body>${'<p>lorem ipsum</p>'.repeat(200)}</body></html>`;
  const s = await serve((req, res) => res.writeHead(req.url === '/sse' ? 404 : 405, { 'content-type': 'text/html; charset=utf-8' }).end(page));
  try {
    const r = await run(['snapshot', '--no-write', `${s.url}/mcp`]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, new RegExp(`^toolmenu: ${s.url}/mcp isn't an MCP endpoint: initialize got HTTP 405 Method Not Allowed \\(text/html\\)`));
    assert.match(r.stderr, /page +“Acme Docs”/);
    assert.doesNotMatch(r.stderr, /<html|lorem|color:red/);
    assert.match(r.stderr, /→ Next: Check the endpoint's path/);
    const sse = await run(['snapshot', '--no-write', `${s.url}/sse`]);
    assert.match(sse.stderr, /HTTP 404 Not Found/);
    assert.match(sse.stderr, new RegExp(`try ${s.url}/mcp`));
  } finally {
    await s.close();
  }
});

test('errors: a 200 web page, a 502 and a JSON-RPC refusal', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/html') res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Welcome</body></html>');
    else if (req.url === '/down') res.writeHead(502, { 'content-type': 'text/plain' }).end('upstream connect error');
    else res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Missing tenant query parameter' } }));
  });
  try {
    const html = await run(['snapshot', '--no-write', `${s.url}/html`]);
    assert.match(html.stderr, /isn't an MCP endpoint/);
    const down = await run(['snapshot', '--no-write', `${s.url}/down`]);
    assert.match(down.stderr, /^toolmenu: 127\.0\.0\.1 failed: server\/discover got HTTP 502 Bad Gateway\./);
    assert.match(down.stderr, /body +“upstream connect error”/);
    const rpc = await run(['snapshot', '--no-write', `${s.url}/rpc`]);
    assert.match(rpc.stderr, /The server refused initialize \(HTTP 400 Bad Request\): “Missing tenant query parameter”/);
  } finally {
    await s.close();
  }
});

test('errors: refused, blocked port, unknown host', async () => {
  const s = await serve(() => {});
  const url = s.url;
  await s.close();
  const refused = await run(['snapshot', '--no-write', `${url}/mcp`]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /^toolmenu: Nothing is listening at 127\.0\.0\.1:\d+: the connection was refused \(ECONNREFUSED\)\./);
  assert.match(refused.stderr, /stage +server\/discover, the first request/);
  const blocked = await run(['snapshot', '--no-write', 'http://127.0.0.1:9/mcp']);
  assert.match(blocked.stderr, /port 9: it's one of the ports Node blocks/);
  const dns = await run(['snapshot', '--no-write', 'https://toolmenu-test.invalid/mcp']);
  assert.match(dns.stderr, /^toolmenu: Couldn(?:'t find|'t look up) toolmenu-test\.invalid/);
});

test('errors: an HTTP server that never answers', async () => {
  const s = await serve(() => {});
  try {
    const r = await run(['snapshot', '--no-write', '--timeout', '500', `${s.url}/mcp`]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^toolmenu: server\/discover timed out after 0\.5 s: no response from 127\.0\.0\.1\./);
  } finally {
    s.close();
  }
});

test('errors: an HTTP server\'s own error answer is its words, not a timeout', async () => {
  const s = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const message = JSON.parse(body);
      if (message.id === undefined) return res.writeHead(202).end();
      const error = message.method === 'initialize' ? { code: -32603, message: 'upstream API request timed out' } : { code: -32601, message: 'Method not found' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error }));
    });
  });
  try {
    const r = await run(['snapshot', '--no-write', '--timeout', '3000', `${s.url}/mcp`]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^toolmenu: The server answered initialize with an error: “upstream API request timed out” \(-32603\)\./);
    assert.doesNotMatch(r.stderr, /no JSON-RPC reply|no response from/);
  } finally {
    await s.close();
  }
});

test('errors: a 401 keeps the OAuth hint and the status the action looks for', async () => {
  const s = await serve((req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'));
  try {
    const r = await run(['snapshot', '--no-write', `${s.url}/mcp`]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /HTTP 401 Unauthorized/);
    assert.match(r.stderr, new RegExp(`toolmenu auth login ${s.url}/mcp`));
    const own = await run(['snapshot', '--no-write', '--header', 'Authorization: Bearer x', `${s.url}/mcp`]);
    assert.match(own.stderr, /The credentials you sent were refused/);
  } finally {
    await s.close();
  }
});

test('errors: a mistyped option gets the nearest one; a broken menu file says what to do', async () => {
  const r = await run(['snapshot', '--timout', '5', 'https://x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^toolmenu: Unknown option --timout\. Did you mean --timeout\?\n +→ Next: toolmenu snapshot --help lists its options/);
  const missing = await run(['diff', 'nope.json', 'nope.json']);
  assert.match(missing.stderr, /nope\.json: no such file/);
});

test('errors: an unknown option is matched against the command\'s own options', async () => {
  const r = await run(['diff', '--relase', '1..2', 'a.json', 'b.json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option --relase\. Did you mean --release\?\n +→ Next: toolmenu diff --help lists its options/);
});

test('errors: an unknown option with no command points to the overview and command help', async () => {
  const r = await run(['--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /→ Next: toolmenu --help lists the commands; toolmenu <command> --help lists its options/);
});

test('errors: snapshot without a server shows both forms', async () => {
  const r = await run(['snapshot']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /→ Next: toolmenu snapshot -- node dist\/server\.js \(stdio\) or toolmenu snapshot https:\/\/example\.com\/mcp \(HTTP\)/);
});

test('errors: session without a server keeps --auto in the example', async () => {
  const r = await run(['session', '--auto']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /→ Next: toolmenu session --auto -- node dist\/server\.js \(stdio\)/);
});

test('explain: the pieces', () => {
  const t = new Trace();
  t.stdout('{"jsonrpc":"2.0","id":1,"result":{}}\n{"level":30,"msg":"pino log"}\nplain line\n');
  t.stdout('partial ');
  t.stdout('line\n');
  assert.deepEqual(t.stray, ['{"level":30,"msg":"pino log"}', 'plain line']);
  assert.equal(t.strayCount, 3);
  const e = new Trace();
  e.stderr('\x1b[31mred\x1b[0m\n');
  for (let i = 0; i < 20; i++) e.stderr(`line ${i}\n`);
  e.stderr('no newline at the end');
  const [, text] = stderrFact(e);
  assert.match(text, /^last 12 of 22 lines \(10 earlier lines not shown\)/);
  assert.match(text, /│ no newline at the end$/);
  assert.doesNotMatch(text, /\x1b/);
  assert.equal(bodyExcerpt('<html><head><title>Not Found</title></head></html>'), 'Not Found');
  assert.equal(bodyExcerpt('{"error":{"message":"Bad \\"tenant\\""}}'), 'Bad "tenant"');
  assert.equal(bodyExcerpt('x'.repeat(500)).length, 100);
  assert.equal(bodyExcerpt('  '), undefined);
  assert.equal(formatBlock('Head.', [['a', 'one'], ['long', 'two\nthree']], 'Do it.'), 'Head.\n  a     one\n  long  two\n        three\n  → Next: Do it.');
});

test('setupFailureAdvice: a next step per class, marked unsure', () => {
  const a = setupFailureAdvice(['auth'], 'http');
  assert.equal(a.confidence, 'unsure');
  assert.match(a.fix, /--header "Authorization: …"/);
  assert.match(setupFailureAdvice(['environment', 'network'], 'stdio').fix, /install it.*reach it/);
});
