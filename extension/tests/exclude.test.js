const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

const excludedPath = vm.runInNewContext(source + '\nexcludedPath;', {
  module: { exports: {} },
  require: (name) => {
    if (name === 'vscode') return { window: { createOutputChannel: () => ({}) } };
    if (name === 'child_process') return {};
    return require(name);
  },
});

const codex = '/home/azrael/.codex/worktrees/6b53/kylie';
const verify = '/home/azrael/kylie-worktrees/verify';
const pr = '/home/azrael/kylie-worktrees/pr-290';
const master = '/home/azrael/kylie';

test('a ** glob drops every agent scratch worktree, not the real ones', () => {
  const patterns = ['**/.codex/worktrees/**'];
  assert.equal(excludedPath(codex, patterns), true);
  assert.equal(excludedPath(pr, patterns), false);
  assert.equal(excludedPath(master, patterns), false);
});

test('a plain path excludes itself and its children only', () => {
  const patterns = ['/home/azrael/kylie-worktrees/verify'];
  assert.equal(excludedPath(verify, patterns), true);
  assert.equal(excludedPath(verify + '/sub', patterns), true);
  assert.equal(excludedPath(pr, patterns), false);
  assert.equal(excludedPath(master, patterns), false);
});

test('a bare name matches the worktree folder anywhere', () => {
  assert.equal(excludedPath(verify, ['verify']), true);
  assert.equal(excludedPath(pr, ['verify']), false);
});

test('a single star stays inside one path segment', () => {
  assert.equal(excludedPath(pr, ['pr-*']), true);
  assert.equal(excludedPath(pr, ['/home/*']), false);
  assert.equal(excludedPath(pr, ['/home/**']), true);
});

test('empty and blank patterns exclude nothing', () => {
  assert.equal(excludedPath(pr, []), false);
  assert.equal(excludedPath(pr, ['', '  ']), false);
});
