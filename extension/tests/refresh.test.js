const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function load({ collect, complexity = async () => null, fileSystem = fs, childProcess = {} } = {}) {
  const context = {
    module: { exports: {} }, process, Buffer, setImmediate, complexity,
    collect: collect || (async (repoPath) => ({ repoPath, staged: [], unstaged: [], untracked: [] })),
    require: (name) => {
      if (name === 'vscode') return {
        workspace: { getConfiguration: () => ({ get: () => '' }) },
        window: { createOutputChannel: () => ({ appendLine() {} }) },
      };
      if (name === 'fs') return fileSystem;
      if (name === 'child_process') return childProcess;
      return require(name);
    },
  };
  return vm.runInNewContext(source + `
    const collectOriginal = collectRepo;
    collectRepo = collect;
    collectComplexity = complexity;
    scanAgents = () => ({});
    scanTestingSerials = () => new Set();
    ({ StatsViewProvider, git, countLines, collectOriginal });
  `, context);
}

test('startup publishes the first completed row while other repositories are still loading', async () => {
  const work = deferredRepos();
  const { StatsViewProvider } = load(work);
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/fast', '/repos/slow', '/repos/queued'];
  const published = [];
  provider.push = () => published.push([...provider.data.keys()]);
  const done = provider.refresh();
  await tick();
  work.pending.shift()();
  await tick();
  assert.deepEqual(published, [['/repos/fast']]);
  while (work.pending.length) {
    work.pending.shift()();
    await tick();
  }
  await done;
  assert.deepEqual([...provider.data.keys()], provider.repos);
});

test('complexity waits until all basic rows are published and stays bounded', async () => {
  const work = deferredRepos();
  const collected = [];
  const { StatsViewProvider } = load({
    collect: async (repoPath) => {
      collected.push(repoPath);
      return { repoPath, staged: [], unstaged: [], untracked: [],
        vsMaster: { mergeBase: 'base', headSha: 'snapshot', files: [], renames: {}, cx: null } };
    },
    complexity: async (repoPath, mergeBase, files, renames, headSha) => {
      assert.equal(provider.data.size, 3, 'every row must be usable before scoring starts');
      assert.equal(headSha, 'snapshot', 'score the revision whose diff is on screen');
      await work.collect(repoPath);
      return { cognitive: 7 };
    },
  });
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/a', '/repos/b', '/repos/c'];
  const done = provider.refresh();
  await tick();
  assert.deepEqual(collected, provider.repos);
  assert.equal(work.calls.length, 2);
  assert.equal(provider.data.get('/repos/a').vsMaster.cx, null);
  while (work.pending.length) {
    work.pending.shift()();
    await tick();
  }
  await done;
  assert.equal(work.peak(), 2);
  assert.equal(provider.data.get('/repos/a').vsMaster.cx.cognitive, 7);
});

test('repository collection returns its diff without running complexity', async () => {
  let scored = false;
  const { collectOriginal } = load({
    complexity: async () => { scored = true; },
    childProcess: { execFile(command, args, options, callback) {
      const output = args[0] === 'rev-parse'
        ? args.includes('--abbrev-ref') ? 'feature\n' : 'master-sha\nhead-sha\n'
        : args[0] === 'merge-base' ? 'base-sha\n'
        : args[0] === 'diff' && args.includes('master-sha...head-sha')
          ? args.includes('--numstat') ? '2\t1\tcode.py\n' : 'M\tcode.py\n'
          : '';
      setImmediate(() => callback(null, output));
    } },
  });
  const result = await collectOriginal('/repos/example', new Set());
  assert.equal(scored, false);
  assert.equal(result.vsMaster.headSha, 'head-sha');
  assert.equal(result.vsMaster.files[0].add, 2);
  assert.equal(result.vsMaster.cx, null);
});

test('refresh keeps known complexity visible only for an unchanged revision', async () => {
  let revision = 'old';
  const { StatsViewProvider } = load({
    collect: async (repoPath) => ({ repoPath, staged: [], unstaged: [], untracked: [],
      vsMaster: { headSha: revision, mergeBase: 'base', files: [{ path: 'code.py' }], renames: {}, cx: null } }),
    complexity: async (repoPath, base, files) => {
      files[0].cx = { cognitive: 7 };
      return { cognitive: 7 };
    },
  });
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/a'];
  await provider.refresh();
  const published = [];
  provider.push = () => {
    const v = provider.data.get('/repos/a').vsMaster;
    published.push({ total: v.cx?.cognitive, file: v.files[0].cx?.cognitive });
  };
  await provider.refresh();
  assert.deepEqual(published[0], { total: 7, file: 7 });
  revision = 'new';
  published.length = 0;
  await provider.refresh();
  assert.deepEqual(published[0], { total: undefined, file: undefined });
});

test('startup distinguishes loading from an empty workspace and completes after failed scans', async () => {
  const { StatsViewProvider } = load({ collect: async () => { throw new Error('unavailable'); } });
  const provider = new StatsViewProvider();
  const messages = [];
  provider.view = { webview: { postMessage: (message) => messages.push(message) } };
  await provider.onMessage({ type: 'ready' });
  assert.equal(messages.at(-1).loading, true);
  provider.setRepos([]);
  await provider.refreshPromise;
  assert.equal(messages.at(-1).loading, false);
  provider.setRepos(['/repos/missing']);
  await provider.refreshPromise;
  assert.equal(messages.at(-1).loading, false);
  assert.equal(messages.at(-1).repos.length, 0);
});

test('repository removal while scoring does not publish obsolete complexity or score queued rows', async () => {
  const work = deferredRepos();
  const { StatsViewProvider } = load({
    collect: async (repoPath) => ({ repoPath, staged: [], unstaged: [], untracked: [],
      vsMaster: { mergeBase: 'base', files: [], renames: {}, cx: null } }),
    complexity: work.collect,
  });
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/a', '/repos/b', '/repos/obsolete'];
  const published = [];
  provider.push = () => published.push([...provider.data.keys()]);
  const done = provider.refresh();
  await tick();
  published.length = 0;
  provider.setRepos(['/repos/current']);
  while (work.pending.length) {
    work.pending.shift()();
    await tick();
  }
  await done;
  assert.ok(!work.calls.includes('/repos/obsolete'));
  assert.ok(published.length > 0);
  assert.ok(published.every((keys) => keys.length === 1 && keys[0] === '/repos/current'));
});

test('rediscovering identical worktrees does not queue a redundant startup scan', async () => {
  const work = deferredRepos();
  const { StatsViewProvider } = load(work);
  const provider = new StatsViewProvider();
  provider.setRepos(['/repos/a']);
  const done = provider.refreshPromise;
  await tick();
  provider.setRepos(['/repos/a']);
  work.pending.shift()();
  await tick();
  assert.equal(work.calls.length, 1);
  await done;
});

test('removed repositories stop consuming queued collection work', async () => {
  const work = deferredRepos();
  const { StatsViewProvider } = load(work);
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/a', '/repos/b', '/repos/obsolete'];
  const done = provider.refresh();
  await tick();
  provider.setRepos(['/repos/current']);
  while (work.pending.length) {
    work.pending.shift()();
    await tick();
  }
  await done;
  assert.ok(!work.calls.includes('/repos/obsolete'));
  assert.deepEqual([...provider.data.keys()], ['/repos/current']);
});

function deferredRepos() {
  const pending = [];
  const calls = [];
  let active = 0, peak = 0;
  const collect = (repoPath) => new Promise((resolve) => {
    calls.push(repoPath);
    peak = Math.max(peak, ++active);
    pending.push(() => {
      active--;
      resolve({ repoPath, staged: [], unstaged: [], untracked: [] });
    });
  });
  return { collect, calls, pending, peak: () => peak };
}

test('refresh bursts coalesce into one follow-up without overlapping scans', async () => {
  const work = deferredRepos();
  const { StatsViewProvider } = load(work);
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/a'];
  const requests = [provider.refresh()];
  await tick();
  for (let i = 0; i < 20; i++) requests.push(provider.refresh());
  assert.equal(work.calls.length, 1, 'a busy refresh must not start another scan');

  work.pending.shift()();
  await tick();
  assert.equal(work.calls.length, 2, 'changes during a scan need one fresh result');
  work.pending.shift()();
  await Promise.all(requests);
  assert.equal(work.calls.length, 2);
  assert.equal(work.peak(), 1);
});

test('a 29-worktree refresh bounds collection concurrency and keeps every row', async () => {
  const work = deferredRepos();
  const { StatsViewProvider } = load(work);
  const provider = new StatsViewProvider();
  provider.repos = Array.from({ length: 29 }, (_, i) => `/repos/worktree-${i}`);
  const done = provider.refresh();
  await tick();
  assert.ok(work.peak() <= 2, `started ${work.peak()} repositories at once`);

  while (work.pending.length) {
    work.pending.shift()();
    await tick();
  }
  await done;
  assert.equal(provider.data.size, 29);
  assert.deepEqual([...provider.data.keys()], provider.repos);
});

test('repository changes during a refresh discard the obsolete scan', async () => {
  const work = deferredRepos();
  const { StatsViewProvider } = load(work);
  const provider = new StatsViewProvider();
  const published = [];
  provider.push = () => published.push([...provider.data.keys()]);
  provider.repos = ['/repos/removed'];
  const done = provider.refresh();
  await tick();
  provider.setRepos(['/repos/current']);
  assert.equal(work.calls.length, 1);
  work.pending.shift()();
  await tick();
  assert.deepEqual(work.calls, ['/repos/removed', '/repos/current']);
  work.pending.shift()();
  await done;
  assert.deepEqual(published, [['/repos/current']]);
});

test('a failed repository does not prevent later refreshes', async () => {
  let fail = true;
  const { StatsViewProvider } = load({ collect: async (repoPath) => {
    if (fail) throw new Error('repository unavailable');
    return { repoPath, staged: [], unstaged: [], untracked: [] };
  } });
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/a'];
  await provider.refresh();
  fail = false;
  await provider.refresh();
  assert.equal(provider.data.size, 1);
});

test('a refresh requested just after publication is not lost during cleanup', async () => {
  const { StatsViewProvider } = load();
  const provider = new StatsViewProvider();
  provider.repos = ['/repos/a'];
  let published = 0;
  provider.push = () => {
    if (++published === 1) queueMicrotask(() => provider.refresh());
  };
  await provider.refresh();
  await tick();
  assert.equal(published, 2);
});

test('read-only Git queries cannot rewrite the index and trigger another refresh', async () => {
  let options;
  const { git } = load({ childProcess: { execFile(command, args, opts, callback) {
    options = opts;
    callback(null, 'clean');
  } } });
  assert.equal(await git('/repos/a', ['status', '--porcelain']), 'clean');
  assert.equal(options.env?.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(options.env.PATH, process.env.PATH);
});

test('untracked line counts use asynchronous file reads and preserve their values', async () => {
  const contents = new Map([
    ['empty', Buffer.from('')], ['trailing', Buffer.from('a\nb\n')],
    ['partial', Buffer.from('a\nb')], ['binary', Buffer.from([0, 10])],
  ]);
  const reads = [];
  const { countLines } = load({ fileSystem: { promises: {
    stat: async (file) => ({ isFile: () => true, size: file === 'large' ? 6 * 1024 * 1024 : contents.get(file).length }),
    readFile: async (file) => { reads.push(file); return contents.get(file); },
  } } });
  assert.equal(await countLines('empty'), 0);
  assert.equal(await countLines('trailing'), 2);
  assert.equal(await countLines('partial'), 2);
  assert.equal(await countLines('binary'), null);
  assert.equal(await countLines('large'), null);
  assert.deepEqual(reads, ['empty', 'trailing', 'partial', 'binary']);
});

test('repository results wait for untracked line counts before publishing totals', async () => {
  const { collectOriginal } = load({
    childProcess: { execFile(command, args, options, callback) {
      const output = args[0] === 'ls-files' ? 'new.txt\n'
        : args[0] === 'rev-parse' ? 'master\n' : '';
      setImmediate(() => callback(null, output));
    } },
    fileSystem: { promises: {
      stat: async () => ({ isFile: () => true, size: 3 }),
      readFile: async () => Buffer.from('a\nb'),
    } },
  });
  const result = await collectOriginal('/repos/example', new Set());
  assert.equal(result.untracked[0].add, 2);
  assert.equal(result.totals.add, 2);
  assert.equal(result.untracked[0].binary, false);
});
