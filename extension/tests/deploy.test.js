const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'checkout with spaces');
  const caller = path.join(root, 'other folder');
  const remote = path.join(root, 'remote.git');
  const command = path.join(root, 'minion-hq-deploy');
  fs.mkdirSync(repo);
  fs.mkdirSync(caller);
  const git = (...args) => cp.execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--bare', remote);
  git('init', '-b', 'release');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', remote);
  fs.copyFileSync(path.join(__dirname, '..', '..', 'deploy.sh'), path.join(repo, 'deploy.sh'));
  fs.writeFileSync(path.join(repo, '.nvmrc'), process.versions.node.split('.')[0] + '\n');
  fs.writeFileSync(path.join(repo, 'ci.sh'), '#!/bin/sh\necho checked >> .git/deploy-events\nexit "${TEST_CI_EXIT:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'build.sh'), '#!/bin/sh\necho installed >> .git/deploy-events\nexit "${TEST_INSTALL_EXIT:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  fs.symlinkSync(path.join(repo, 'deploy.sh'), command);
  fs.writeFileSync(path.join(caller, 'untouched.txt'), 'unrelated\n');
  const run = (env = {}) => cp.spawnSync(command, ['Deploy tested changes'], {
    cwd: caller, encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath, ...env },
  });
  const events = () => fs.readFileSync(path.join(repo, '.git', 'deploy-events'), 'utf8').trim().split('\n');
  const change = () => fs.writeFileSync(path.join(repo, 'README.md'), 'updated\n');
  return { repo, remote, caller, git, run, events, change };
}

test('deploy from another folder follows its symlink, checks, commits, pushes, and installs', (t) => {
  const f = fixture(t);
  f.change();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.events(), ['checked', 'installed']);
  assert.equal(f.git('log', '-1', '--format=%s'), 'Deploy tested changes');
  assert.equal(f.git('--git-dir', f.remote, 'rev-parse', 'release'), f.git('rev-parse', 'HEAD'));
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(f.caller, 'untouched.txt'), 'utf8'), 'unrelated\n');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(f.run().status, 0, 'a clean checkout can be deployed again');
  assert.equal(f.git('rev-parse', 'HEAD'), head, 'retry creates no empty commit');
});

test('a failed check leaves changes uncommitted and skips push and install', (t) => {
  const f = fixture(t);
  const head = f.git('rev-parse', 'HEAD');
  f.change();
  assert.equal(f.run({ TEST_CI_EXIT: '7' }).status, 7);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('--git-dir', f.remote, 'for-each-ref'), '');
  assert.deepEqual(f.events(), ['checked']);
});

test('a rejected push skips installation and retains the local commit for retry', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  f.change();
  assert.notEqual(f.run().status, 0);
  assert.equal(f.git('log', '-1', '--format=%s'), 'Deploy tested changes');
  assert.deepEqual(f.events(), ['checked']);
  assert.equal(f.git('--git-dir', f.remote, 'for-each-ref'), '');
});

test('installation failure is reported after a successful push', (t) => {
  const f = fixture(t);
  f.change();
  assert.equal(f.run({ TEST_INSTALL_EXIT: '8' }).status, 8);
  assert.equal(f.git('--git-dir', f.remote, 'rev-parse', 'release'), f.git('rev-parse', 'HEAD'));
});

test('detached HEAD is refused before checks or mutations', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Checkout a branch/);
  assert.equal(fs.existsSync(path.join(f.repo, '.git', 'deploy-events')), false);
});
