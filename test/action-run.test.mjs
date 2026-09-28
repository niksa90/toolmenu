// The GitHub Action's script (action/run.sh), run with a stub CLI that fails
// the way a real snapshot would. One test per branch of the fork-PR skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tempDir } from './helpers.mjs';

function runAction(env, setup) {
  const dir = tempDir();
  const extra = setup ? setup(dir) : {};
  const stub = join(dir, 'stub-cli.sh');
  // Records its arguments, prints STUB_ERR to stderr and exits with STUB_CODE,
  // like a failed snapshot.
  // Also writes the file --union-out names, like session does.
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$0.$1.args"\nfor ((i=1;i<$#;i++)); do if [ "${!i}" = --union-out ]; then j=$((i+1)); echo "{}" > "${!j}"; fi; done\nprintf "%s\\n" "$STUB_ERR" >&2\nexit "${STUB_CODE:-0}"\n');
  chmodSync(stub, 0o755);
  const r = spawnSync('bash', [join(ROOT, 'action/run.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, RUNNER_TEMP: dir, TOOLMENU_CLI: stub, TOOLMENU_COMMENT: 'false', ...env, ...extra },
  });
  let comment = '';
  try {
    comment = readFileSync(join(dir, 'toolmenu/comment.md'), 'utf8');
  } catch {}
  let args = '';
  try {
    args = readFileSync(join(dir, 'stub-cli.sh.snapshot.args'), 'utf8');
  } catch {}
  const ran = (cmd) => existsSync(join(dir, `stub-cli.sh.${cmd}.args`));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, comment, args, ran, dir };
}

const url = { TOOLMENU_URL: 'https://example.com/mcp' };

test('action: a fork PR whose secret came through empty is skipped with the fix', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: ', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'connection failed' });
  assert.equal(r.code, 0);
  assert.match(r.comment, /Skipped: this pull request runs without the repository's secrets/);
  assert.match(r.comment, /start the server inside the job/);
});

test('action: a fork PR the server answers 401 is skipped', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: something', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'HTTP 401 Unauthorized' });
  assert.equal(r.code, 0);
  assert.match(r.comment, /Skipped: this pull request runs without the repository's secrets/);
});

test('action: a fork PR whose server never started still fails', () => {
  const r = runAction({ TOOLMENU_URL: 'http://localhost:3999/mcp', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'connect ECONNREFUSED 127.0.0.1:3999' });
  assert.equal(r.code, 2);
  assert.match(r.comment, /Couldn't snapshot the server/);
  assert.doesNotMatch(r.comment, /Skipped/);
  assert.match(r.stdout, /The check couldn't run: the server didn't start or couldn't be reached/);
});

test('action: a same-repo PR with a 401 fails (secrets exist there)', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: wrong', TOOLMENU_NO_SECRETS: 'false', STUB_CODE: '2', STUB_ERR: 'HTTP 401 Unauthorized' });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.comment, /Skipped/);
});

test('action: findings and a failed run get different error lines', () => {
  const r = runAction({ ...url, STUB_CODE: '1', STUB_ERR: '' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Findings at or above 'error'/);
  assert.doesNotMatch(r.stdout, /couldn't run/);
});

test('action: a 401 from a server started in the job (localhost) is a real failure, not a missing secret', () => {
  const r = runAction({ TOOLMENU_URL: 'http://127.0.0.1:3000/mcp', TOOLMENU_HEADERS: 'x-api-key: ci-only-key', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'HTTP 401 Unauthorized' });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.comment, /Skipped/);
});

test('action: a stdio server starts with the job\'s own PATH', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node dist/server.js', STUB_CODE: '0' });
  const script = r.args.split('\n').find((a) => a.startsWith('PATH='));
  assert.ok(script, r.args);
  assert.match(script, new RegExp(`^PATH=${process.env.PATH.split(':')[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(script, /export PATH; exec node dist\/server\.js$/);
});

test('action: "Authorization: Bearer" with an empty secret counts as missing', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'Authorization: Bearer ', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'connection failed' });
  assert.equal(r.code, 0);
  assert.match(r.comment, /Skipped/);
});

test('action: a stdio server whose env secret came through empty is skipped', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_ENV: 'API_KEY=', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'server exited' });
  assert.equal(r.code, 0);
  assert.match(r.comment, /Skipped/);
});

test('action: a stdio server that fails with its env set is a real failure', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_ENV: 'API_KEY=ci-only', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'HTTP 401 Unauthorized' });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.comment, /Skipped/);
});

for (const u of ['http://LOCALHOST.:3000/mcp', 'http://api.localhost/mcp', 'http://127.1.2.3/mcp', 'http://0.0.0.0:8080', 'http://[::1]:3000/mcp', 'http://mcp:3000/mcp', 'http://user@mcp-server/mcp']) {
  test(`action: a 401 from a server inside the job (${u}) is a real failure`, () => {
    const r = runAction({ TOOLMENU_URL: u, TOOLMENU_HEADERS: 'x-api-key: ci-only-key', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'HTTP 401 Unauthorized' });
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.comment, /Skipped/);
  });
}

test('action: a port number that contains 401 is not a 401', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: something', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'connect ECONNREFUSED 10.0.0.5:4010' });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.comment, /Skipped/);
});

test('action: a skipped check skips the session too', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: ', TOOLMENU_SCENARIO: 'scenario.yml', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'connection failed' });
  assert.equal(r.code, 0);
  assert.equal(r.ran('session'), false);
});

// A fake bin directory whose `node` reports an old version, so the script
// looks for Node 22 of its own.
function oldNode(dir, extra = '') {
  const bin = join(dir, 'oldbin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho 18\n');
  chmodSync(join(bin, 'node'), 0o755);
  if (extra) {
    writeFileSync(join(bin, 'uname'), extra);
    chmodSync(join(bin, 'uname'), 0o755);
  }
  return bin;
}

test('action: on an unsupported platform with old Node, it says to install Node 22', () => {
  const r = runAction({ ...url, STUB_CODE: '0' }, (dir) => ({ PATH: `${oldNode(dir, '#!/bin/sh\necho MINGW64_NT\n')}:${process.env.PATH}` }));
  assert.equal(r.code, 2);
  assert.match(r.stdout, /needs Node 22 or later, and this runner has Node 18\. Install Node 22 before the Action \(actions\/setup-node, or your container's package manager\)/);
  assert.equal(r.ran('snapshot'), false);
});

test('action: a Node 22 fetched earlier in the job is reused, for toolmenu only', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node dist/server.js', STUB_CODE: '0' }, (dir) => {
    const bin = oldNode(dir);
    const fetched = join(dir, 'toolmenu-node/bin');
    mkdirSync(fetched, { recursive: true });
    writeFileSync(join(fetched, 'node'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fetched, 'node'), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  });
  assert.equal(r.code, 0);
  // The server still gets the job's PATH, old Node first.
  assert.match(r.args, /PATH=[^;]*oldbin/);
  assert.doesNotMatch(r.args, /PATH=[^;]*toolmenu-node/);
});

test('action: a skip sets the skipped output, a real run does not', () => {
  const out = (dir) => ({ GITHUB_OUTPUT: join(dir, 'out.txt') });
  let file;
  runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: ', TOOLMENU_NO_SECRETS: 'true', STUB_CODE: '2', STUB_ERR: 'x' }, (dir) => ((file = join(dir, 'out.txt')), out(dir)));
  assert.match(readFileSync(file, 'utf8'), /^skipped=true$/m);
  runAction({ ...url, STUB_CODE: '0' }, (dir) => ((file = join(dir, 'out.txt')), out(dir)));
  assert.match(readFileSync(file, 'utf8'), /^skipped=false$/m);
});

test('action: an early stop still writes the outputs', () => {
  let file;
  const r = runAction({ STUB_CODE: '0' }, (dir) => ((file = join(dir, 'out.txt')), { GITHUB_OUTPUT: file }));
  assert.equal(r.code, 2);
  assert.equal(readFileSync(file, 'utf8'), 'exit-code=2\nskipped=false\n');
});

test('action: a PR whose base branch cannot be fetched fails instead of comparing with itself', () => {
  const r = runAction({ ...url, TOOLMENU_BASE_REF: 'main', STUB_CODE: '0' }, (dir) => {
    writeFileSync(join(dir, 'menu.json'), '{}');
    return {};
  });
  assert.equal(r.code, 2);
  assert.match(r.comment, /Couldn't read the base branch/);
  assert.match(r.stdout, /::error title=toolmenu::Couldn't read the base branch/);
  assert.doesNotMatch(r.stdout, /the server didn't start/);
  assert.equal(r.ran('diff'), false);
});

test('action: a tag push with a non-version tag fails instead of comparing with itself', () => {
  const r = runAction({ ...url, GITHUB_REF: 'refs/tags/mcp-v1.3.0', STUB_CODE: '0' }, (dir) => {
    writeFileSync(join(dir, 'menu.json'), '{}');
    return {};
  });
  assert.equal(r.code, 2);
  assert.match(r.comment, /`mcp-v1\.3\.0` isn't a version tag/);
  assert.match(r.stdout, /::error title=toolmenu::'mcp-v1\.3\.0' isn't a version tag/);
  assert.doesNotMatch(r.stdout, /the server didn't start/);
  assert.equal(r.ran('diff'), false);
});

test('action: by default it runs the toolmenu release matching the Action, with no connection options', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_CLI: '' }, (dir) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$RUNNER_TEMP/npx.args"\nexit 2\n');
    chmodSync(join(bin, 'npx'), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  });
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const args = readFileSync(join(r.dir, 'npx.args'), 'utf8').split('\n');
  assert.ok(args.includes(`toolmenu@${version}`), args.join(' '));
  assert.doesNotMatch(r.stdout + r.stderr, /unbound variable/);
});


test('action: baseline-from session diffs the union menu, and runs the session once', () => {
  let diffArgs = '';
  let sessionArgs = '';
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_SCENARIO: 'scenario.yml', TOOLMENU_BASELINE_FROM: 'session', TOOLMENU_RELEASE: 'off' }, (dir) => {
    writeFileSync(join(dir, 'menu.json'), '{}');
    return {};
  });
  diffArgs = readFileSync(join(r.dir, 'stub-cli.sh.diff.args'), 'utf8');
  sessionArgs = readFileSync(join(r.dir, 'stub-cli.sh.session.args'), 'utf8');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(sessionArgs, /--union-out\n.*union\.json/);
  assert.match(diffArgs, /union\.json\n?$/);
  assert.equal((r.comment.match(/Baseline:/g) ?? []).length, 1);
});

test('action: baseline-from session without a scenario, or a typo, fails clearly', () => {
  const none = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_BASELINE_FROM: 'session' });
  assert.equal(none.code, 2);
  assert.match(none.stdout, /needs a 'scenario'/);
  const typo = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_BASELINE_FROM: 'sesion' });
  assert.equal(typo.code, 2);
  assert.match(typo.stdout, /'snapshot' or 'session'/);
});

test('action: scenario auto runs session --auto', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_SCENARIO: 'auto' });
  const args = readFileSync(join(r.dir, 'stub-cli.sh.session.args'), 'utf8');
  assert.match(args, /^session\n--auto\n/);
  assert.doesNotMatch(args, /--scenario/);
});

