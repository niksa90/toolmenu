// The GitHub Action's script (action/run.sh), run with a stub CLI that fails
// the way a real snapshot would. One test per branch of the fork-PR skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tempDir } from './helpers.mjs';

function runAction(env) {
  const dir = tempDir();
  const stub = join(dir, 'stub-cli.sh');
  // Prints STUB_ERR to stderr and exits with STUB_CODE, like a failed snapshot.
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$STUB_ERR" >&2\nexit "${STUB_CODE:-0}"\n');
  chmodSync(stub, 0o755);
  const r = spawnSync('bash', [join(ROOT, 'action/run.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, RUNNER_TEMP: dir, TOOLMENU_CLI: stub, TOOLMENU_COMMENT: 'false', ...env },
  });
  let comment = '';
  try {
    comment = readFileSync(join(dir, 'toolmenu/comment.md'), 'utf8');
  } catch {}
  return { code: r.status, stdout: r.stdout, comment };
}

const url = { TOOLMENU_URL: 'https://example.com/mcp' };

test('action: a fork PR whose secret came through empty is skipped with the fix', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: ', TOOLMENU_FORK_PR: 'true', STUB_CODE: '2', STUB_ERR: 'connection failed' });
  assert.equal(r.code, 0);
  assert.match(r.comment, /Skipped: this pull request comes from a fork/);
  assert.match(r.comment, /start the server inside the job/);
});

test('action: a fork PR the server answers 401 is skipped', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: something', TOOLMENU_FORK_PR: 'true', STUB_CODE: '2', STUB_ERR: 'HTTP 401 Unauthorized' });
  assert.equal(r.code, 0);
  assert.match(r.comment, /Skipped: this pull request comes from a fork/);
});

test('action: a fork PR whose server never started still fails', () => {
  const r = runAction({ TOOLMENU_URL: 'http://localhost:3999/mcp', TOOLMENU_FORK_PR: 'true', STUB_CODE: '2', STUB_ERR: 'connect ECONNREFUSED 127.0.0.1:3999' });
  assert.equal(r.code, 2);
  assert.match(r.comment, /Couldn't snapshot the server/);
  assert.doesNotMatch(r.comment, /Skipped/);
  assert.match(r.stdout, /The check couldn't run: the server didn't start or couldn't be reached/);
});

test('action: a same-repo PR with a 401 fails (secrets exist there)', () => {
  const r = runAction({ ...url, TOOLMENU_HEADERS: 'x-api-key: wrong', TOOLMENU_FORK_PR: 'false', STUB_CODE: '2', STUB_ERR: 'HTTP 401 Unauthorized' });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.comment, /Skipped/);
});

test('action: findings and a failed run get different error lines', () => {
  const r = runAction({ ...url, STUB_CODE: '1', STUB_ERR: '' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Findings at or above 'error'/);
  assert.doesNotMatch(r.stdout, /couldn't run/);
});
