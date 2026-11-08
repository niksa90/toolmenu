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

test('action: catalog true passes --catalog to snapshot', () => {
  const on = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_CATALOG: 'true' });
  assert.match(on.args, /^snapshot\n--catalog\n/);
  const off = runAction({ TOOLMENU_COMMAND: 'node server.js' });
  assert.doesNotMatch(off.args, /--catalog/);
});


test('action: sarif writes one SARIF file per command into the folder, results at the baseline', () => {
  const r = runAction({ ...url, TOOLMENU_SARIF: 'code scanning', TOOLMENU_BASELINE: 'server/menu.json' });
  const lines = r.args.split('\n');
  const at = lines.indexOf('--sarif');
  assert.ok(at > 0, r.args);
  assert.equal(lines[at + 1], 'code scanning/snapshot.sarif', 'a folder with a space stays one argument');
  assert.equal(lines[lines.indexOf('--sarif-menu') + 1], 'server/menu.json');
  assert.ok(existsSync(join(r.dir, 'code scanning')), 'the folder is made');
});

test('action: without sarif, no SARIF arguments', () => {
  const r = runAction(url);
  assert.doesNotMatch(r.args, /--sarif/);
});

/** The PR comment step, with a `gh` stub: `api user` answers GH_USER (or fails, like the job's token), the comments list is COMMENTS, run through the script's own --jq filter. */
function runComment(comments, user) {
  return runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_COMMENT: 'true', TOOLMENU_PR: '7', GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, (dir) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'comments.json'), JSON.stringify(comments));
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$GH_LOG"',
        'if [ "$2" = user ]; then [ -n "$GH_USER" ] && { echo "$GH_USER"; exit 0; }; echo "Resource not accessible by integration" >&2; exit 1; fi',
        'for ((i=1;i<=$#;i++)); do if [ "${!i}" = --jq ]; then j=$((i+1)); jq -r "${!j}" "$GH_COMMENTS"; exit; fi; done',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    return { PATH: `${bin}:${process.env.PATH}`, GH_LOG: join(dir, 'gh.log'), GH_COMMENTS: join(dir, 'comments.json'), GH_USER: user ?? '' };
  });
}
const ghCalls = (r) => readFileSync(join(r.dir, 'gh.log'), 'utf8');
const MARKER = '<!-- toolmenu-report -->';
const hasJq = spawnSync('jq', ['--version']).status === 0;

test('action: the PR comment updated is the bot\'s own, never one anyone else wrote with the marker', { skip: !hasJq && 'needs jq' }, () => {
  const someone = { id: 11, user: { login: 'mallory', type: 'User' }, body: `${MARKER}\nall clear` };
  const bot = { id: 22, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${MARKER}\n## toolmenu` };
  // Only someone else's: a new comment, theirs untouched.
  let r = runComment([someone]);
  assert.match(ghCalls(r), /--method POST repos\/o\/r\/issues\/7\/comments/);
  assert.doesNotMatch(ghCalls(r), /PATCH/);
  // Theirs first, then the bot's: the bot's is updated.
  r = runComment([someone, bot]);
  assert.match(ghCalls(r), /--method PATCH repos\/o\/r\/issues\/comments\/22/);
  assert.doesNotMatch(ghCalls(r), /comments\/11/);
  // The marker quoted in the middle of a bot's comment isn't the report.
  r = runComment([{ ...bot, id: 33, body: `see ${MARKER}` }]);
  assert.match(ghCalls(r), /--method POST/);
});

test('action: with a personal token, only that account\'s comment is updated', { skip: !hasJq && 'needs jq' }, () => {
  const mine = { id: 44, user: { login: 'maintainer', type: 'User' }, body: `${MARKER}\n## toolmenu` };
  const otherBot = { id: 55, user: { login: 'other-app[bot]', type: 'Bot' }, body: `${MARKER}\nfake` };
  const r = runComment([otherBot, mine], 'maintainer');
  assert.match(ghCalls(r), /--method PATCH repos\/o\/r\/issues\/comments\/44/);
  assert.doesNotMatch(ghCalls(r), /comments\/55/);
});

/** A checkout whose base branch (main, fetched from origin) has package.json at `before`; the working tree has `after`. */
function releaseRepo(before, after) {
  return (dir) => {
    const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: before }));
    writeFileSync(join(dir, 'menu.json'), JSON.stringify({ toolmenu: 1, tools: [] }));
    git('add', 'package.json', 'menu.json');
    git('commit', '-q', '-m', 'base');
    git('remote', 'add', 'origin', dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: after }));
    return {};
  };
}
const diffArgs = (r) => readFileSync(join(r.dir, 'stub-cli.sh.diff.args'), 'utf8').trim().split('\n');

test('action: release auto passes the two versions as one --release value', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_BASE_REF: 'main' }, releaseRepo('1.0.0', '1.1.0'));
  assert.ok(r.ran('diff'), r.stdout + r.stderr);
  const args = diffArgs(r);
  assert.equal(args[args.indexOf('--release') + 1], '1.0.0..1.1.0');
});

test('action: a manifest version with spaces or options in it adds no CLI arguments', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_BASE_REF: 'main' }, releaseRepo('1.0.0', '1.1.0 --html /tmp/pwned.html *'));
  assert.ok(r.ran('diff'), r.stdout + r.stderr);
  const args = diffArgs(r);
  assert.ok(!args.includes('--html'), args.join(' '));
  assert.ok(!args.includes('--release'), 'not checked with a version that isn\'t one');
  assert.match(r.stdout, /::warning title=toolmenu::package\.json's version isn't a plain version number/);
});

test('action: the release input is passed as one argument, glob characters and all', () => {
  const r = runAction({ TOOLMENU_COMMAND: 'node server.js', TOOLMENU_BASE_REF: 'main', TOOLMENU_RELEASE: '1.0.0..2.0.0 *' }, releaseRepo('1.0.0', '1.1.0'));
  const args = diffArgs(r);
  assert.equal(args[args.indexOf('--release') + 1], '1.0.0..2.0.0 *');
});
