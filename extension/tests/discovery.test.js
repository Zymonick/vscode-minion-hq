const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function start(groups, initial, { deferred = false, excluded = [] } = {}) {
  const calls = [], pending = [], intervals = [];
  let provider, opened;
  const disposable = () => ({ dispose() {} });
  const repo = (file) => ({ rootUri: { fsPath: file }, state: { onDidChange: disposable } });
  const api = {
    repositories: initial.map(repo),
    onDidOpenRepository: (callback) => { opened = callback; return disposable(); },
    onDidCloseRepository: disposable,
  };
  const vscode = {
    EventEmitter: class { fire() {} dispose() {} event() {} },
    commands: { registerCommand: disposable },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      registerWebviewViewProvider: (id, value) => { provider = value; return disposable(); },
      registerFileDecorationProvider: disposable,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (key) => key === 'excludePaths' ? excluded : '' }),
      registerTextDocumentContentProvider: disposable,
      registerFileSystemProvider: disposable,
      onDidSaveTextDocument: disposable,
      onDidChangeConfiguration: disposable,
    },
    tasks: { onDidEndTaskProcess: disposable },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => api }) }) },
  };
  const activate = vm.runInNewContext(source + `
    StatsViewProvider.prototype.refresh = function () { return Promise.resolve(); };
    scanAgents = () => ({});
    activate;
  `, {
    module: { exports: {} }, process, Buffer,
    setTimeout: disposable, clearTimeout() {}, clearInterval() {},
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; },
    require: (name) => {
      if (name === 'vscode') { return vscode; }
      if (name === 'fs') { return { existsSync: () => true }; }
      if (name === 'child_process') {
        return { execFile(command, args, options, callback) {
          assert.equal(command, 'git');
          assert.deepEqual(Array.from(args), ['worktree', 'list', '--porcelain']);
          calls.push(options.cwd);
          const group = groups.find((paths) => paths.includes(options.cwd));
          const finish = () => callback(null, group.map((file) => 'worktree ' + file + '\n').join('\n'));
          if (deferred) { pending.push(finish); } else { setImmediate(finish); }
        } };
      }
      return require(name);
    },
  });
  activate({ subscriptions: [] });
  return {
    calls, pending, provider: () => provider,
    open(file) { const value = repo(file); api.repositories.push(value); opened(value); },
    poll() { intervals.find((timer) => timer.ms === 15000).callback(); },
  };
}

async function drain(work) {
  for (let i = 0; i < 100; i++) {
    await tick();
    while (work.pending.length) { work.pending.shift()(); }
  }
}

test('discovery queries each shared worktree list once and keeps independent repositories', async () => {
  const siblings = Array.from({ length: 47 }, (_, i) => '/project/pr-' + i);
  const independent = ['/other/main', '/other/feature'];
  const work = start([siblings, independent], [...siblings, independent[0]], { excluded: ['/project/pr-46'] });
  await drain(work);
  assert.deepEqual(work.calls, [siblings[0], independent[0]]);
  assert.equal(work.provider().repos.length, 48);
  assert.ok(!work.provider().repos.includes('/project/pr-46'));
  assert.ok(work.provider().repos.includes('/other/feature'));
});

test('startup discovery bursts and polling share one scan plus a follow-up for newly opened repositories', async () => {
  const siblings = Array.from({ length: 47 }, (_, i) => '/project/pr-' + i);
  const work = start([siblings, ['/other/main']], [siblings[0]], { deferred: true });
  await tick();
  for (const file of siblings.slice(1)) { work.open(file); }
  work.open('/other/main');
  work.poll();
  work.poll();
  assert.equal(work.calls.length, 1, 'discovery requests must not overlap');
  await drain(work);
  assert.deepEqual(work.calls, [siblings[0], siblings[0], '/other/main']);
  assert.equal(work.provider().repos.length, 48);
  assert.ok(work.provider().repos.includes('/other/main'));
});
