const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

class Uri {
  constructor(parts) { Object.assign(this, { scheme: 'file', query: '' }, parts); }
  static file(file) { return new Uri({ path: file, fsPath: file }); }
  with(parts) { return new Uri({ ...this, ...parts }); }
}

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-open-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'file.py'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'Base');
  const base = git('rev-parse', 'HEAD');
  return { repo, git, base };
}

function harness(childProcess = cp) {
  const commands = [], errors = [], contents = new Map(), fileSystems = new Map();
  let provider;
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri, FileType: { File: 1 },
    FileSystemError: {
      NoPermissions: () => new Error('Read only'),
      FileNotADirectory: () => new Error('Not a directory'),
    },
    EventEmitter: class { event() {} fire() {} dispose() {} },
    commands: {
      registerCommand: disposable,
      executeCommand: async (...args) => { commands.push(args); },
    },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      showErrorMessage: async (message) => { errors.push(message); },
      registerWebviewViewProvider: (name, value) => { provider = value; return disposable(); },
      registerFileDecorationProvider: disposable,
    },
    workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: () => '' }),
      registerTextDocumentContentProvider: (scheme, value) => { contents.set(scheme, value); return disposable(); },
      registerFileSystemProvider: (scheme, value) => { fileSystems.set(scheme, value); return disposable(); },
      onDidSaveTextDocument: disposable, onDidChangeConfiguration: disposable,
    },
    tasks: { onDidEndTaskProcess: disposable },
    // No Git extension, discovered repositories, or repository registration.
    extensions: { getExtension: () => undefined },
  };
  const context = {
    module: { exports: {} }, process, Buffer, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    require: (name) => name === 'vscode' ? vscode : name === 'child_process' ? childProcess : require(name),
  };
  vm.runInNewContext(source, context);
  context.module.exports.activate({ subscriptions: [] });
  async function read(uri) {
    if (uri.scheme === 'file') return fs.readFileSync(uri.fsPath);
    if (fileSystems.has(uri.scheme)) return fileSystems.get(uri.scheme).readFile(uri);
    assert.ok(contents.has(uri.scheme), `unregistered scheme: ${uri.scheme}`);
    return Buffer.from(await contents.get(uri.scheme).provideTextDocumentContent(uri));
  }
  return { provider, commands, errors, read, fileSystems };
}

test('Vs master opens the selected worktree while Git discovery and panel refresh are pending', async (t) => {
  const { repo, git, base } = fixture(t);
  const worktree = path.join(repo, 'linked-worktree');
  git('worktree', 'add', '--detach', worktree, base);
  fs.writeFileSync(path.join(worktree, 'file.py'), 'working\n');
  const h = harness();
  h.provider.refreshPromise = new Promise(() => {});
  await h.provider.onMessage({ type: 'open', mode: 'vsmaster', repoPath: worktree, mergeBase: base, path: 'file.py' });
  const [command, left, right] = h.commands.at(-1);
  assert.equal(command, 'vscode.diff');
  assert.equal((await h.read(left)).toString(), 'base\n');
  assert.equal((await h.read(right)).toString(), 'working\n');
  assert.deepEqual(h.errors, []);
});

test('commit diffs open both revisions without the Git extension', async (t) => {
  const { repo, git, base } = fixture(t);
  fs.writeFileSync(path.join(repo, 'file.py'), 'committed\n');
  git('commit', '-qam', 'Change');
  const hash = git('rev-parse', 'HEAD');
  const h = harness();
  await h.provider.onMessage({ type: 'open', mode: 'commit', repoPath: repo, hash, path: 'file.py' });
  assert.equal(h.commands.at(-1)[0], 'vscode.diff');
  assert.equal((await h.read(h.commands.at(-1)[1])).toString(), 'base\n');
  assert.equal((await h.read(h.commands.at(-1)[2])).toString(), 'committed\n');
  await h.provider.onMessage({ type: 'open', mode: 'commit', repoPath: repo, hash: base, path: 'file.py' });
  assert.equal((await h.read(h.commands.at(-1)[1])).length, 0, 'root commit has an empty parent');
});

test('staged and working diffs use the correct index snapshot without Git discovery', async (t) => {
  const { repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, 'file.py'), 'staged\n');
  git('add', '.');
  fs.writeFileSync(path.join(repo, 'file.py'), 'working\n');
  const h = harness();
  await h.provider.onMessage({ type: 'open', mode: 'staged', repoPath: repo, path: 'file.py' });
  let [command, left, right] = h.commands.at(-1);
  assert.equal(command, 'vscode.diff');
  assert.equal((await h.read(left)).toString(), 'base\n');
  assert.equal((await h.read(right)).toString(), 'staged\n');
  await h.provider.onMessage({ type: 'open', mode: 'working', repoPath: repo, path: 'file.py' });
  [command, left, right] = h.commands.at(-1);
  assert.equal(command, 'vscode.diff');
  assert.equal((await h.read(left)).toString(), 'staged\n');
  assert.equal((await h.read(right)).toString(), 'working\n');
  git('add', '.');
  assert.equal((await h.read(left)).toString(), 'staged\n', 'already opened snapshot must not change with the index');
});

test('added and deleted files keep an empty side and binary snapshots preserve bytes', async (t) => {
  const { repo, git, base } = fixture(t);
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  fs.writeFileSync(path.join(repo, 'image.bin'), bytes);
  git('add', '.');
  git('commit', '-qm', 'Binary');
  fs.unlinkSync(path.join(repo, 'image.bin'));
  fs.unlinkSync(path.join(repo, 'file.py'));
  const h = harness();
  await h.provider.onMessage({ type: 'open', mode: 'vsmaster', repoPath: repo, mergeBase: base, path: 'file.py' });
  assert.equal((await h.read(h.commands.at(-1)[1])).toString(), 'base\n');
  assert.equal((await h.read(h.commands.at(-1)[2])).length, 0);
  await h.provider.onMessage({ type: 'open', mode: 'commit', repoPath: repo, hash: git('rev-parse', 'HEAD'), path: 'image.bin' });
  const [, left, right] = h.commands.at(-1);
  assert.equal((await h.read(left)).length, 0);
  assert.deepEqual(await h.read(right), bytes);
  const fileSystem = h.fileSystems.get(right.scheme);
  assert.equal((await fileSystem.stat(right)).size, bytes.length);
  assert.throws(() => fileSystem.writeFile(right, bytes), /Read only/);
});

test('failed revision reads report an error instead of silently opening a different view', async (t) => {
  const { repo } = fixture(t);
  const h = harness();
  await h.provider.onMessage({ type: 'open', mode: 'vsmaster', repoPath: repo, mergeBase: 'missing-ref', path: 'file.py' });
  assert.equal(h.commands.length, 0);
  assert.match(h.errors[0], /file.py/);
});

test('untracked files open directly and staged additions on an unborn branch have an empty base', async (t) => {
  const { repo, git } = fixture(t);
  const h = harness();
  fs.writeFileSync(path.join(repo, 'new.py'), 'new\n');
  await h.provider.onMessage({ type: 'open', mode: 'working', repoPath: repo, path: 'new.py' });
  assert.equal(h.commands.at(-1)[0], 'vscode.open');
  assert.equal((await h.read(h.commands.at(-1)[1])).toString(), 'new\n');
  git('checkout', '--orphan', 'unborn');
  git('add', '.');
  await h.provider.onMessage({ type: 'open', mode: 'staged', repoPath: repo, path: 'new.py' });
  const [command, left, right] = h.commands.at(-1);
  assert.equal(command, 'vscode.diff');
  assert.equal((await h.read(left)).length, 0);
  assert.equal((await h.read(right)).toString(), 'new\n');
});

test('renamed staged and branch files retain their original comparison path', async (t) => {
  const { repo, git, base } = fixture(t);
  git('mv', 'file.py', 'renamed.py');
  const h = harness();
  await h.provider.onMessage({ type: 'open', mode: 'staged', repoPath: repo, path: 'renamed.py' });
  assert.equal((await h.read(h.commands.at(-1)[1])).toString(), 'base\n');
  h.provider.data.set(repo, { vsMaster: { renames: { 'renamed.py': 'file.py' } } });
  await h.provider.onMessage({ type: 'open', mode: 'vsmaster', repoPath: repo, mergeBase: base, path: 'renamed.py' });
  assert.equal((await h.read(h.commands.at(-1)[1])).toString(), 'base\n');
});

test('rendered staged and working rows send their own comparison mode', () => {
  const html = vm.runInNewContext(source + '\ngetHtml("N");', {
    module: { exports: {} }, require: (name) => name === 'vscode' ? {} : require(name),
  });
  const root = {}, events = {}, messages = [], windowEvents = {};
  vm.runInNewContext(html.match(/<script nonce="N">([^]*)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (m) => messages.push(m) }),
    document: { getElementById: () => root, addEventListener: (name, fn) => { events[name] = fn; } },
    window: { addEventListener: (name, fn) => { windowEvents[name] = fn; } },
  });
  windowEvents.message({ data: { type: 'data', repos: [{
    repoPath: '/repo', name: 'repo', branch: 'branch', totals: { add: 2, del: 1 },
    staged: [{ path: 'file.py', add: 1, del: 1 }], unstaged: [{ path: 'file.py', add: 1, del: 0 }],
    untracked: [], commits: [],
  }] } });
  const actions = [...root.innerHTML.matchAll(/data-act="([sw]\|[^"]+)"/g)].map((m) => m[1]);
  assert.equal(actions.length, 2);
  for (const act of actions) {
    events.click({ target: { closest: (selector) => selector === '.row' ? { dataset: { act } } : null } });
  }
  assert.deepEqual(messages.slice(-2).map((m) => m.mode), ['staged', 'working']);
});
