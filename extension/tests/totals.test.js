const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  return vm.runInNewContext(source + `
    collectComplexity = async () => null;
    ({ collectRepo, StatsViewProvider, sumFiles, parseNumstat, getHtml });
  `, {
    module: { exports: {} }, process, Buffer,
    require: (name) => name === 'vscode' ? {
      workspace: { getConfiguration: () => ({ get: () => '' }) },
      window: { createOutputChannel: () => ({ appendLine() {} }) },
    } : require(name),
  });
}

test('totals exclude root docs recursively, including quoted and renamed paths', () => {
  const { sumFiles, parseNumstat } = load();
  const files = parseNumstat([
    '100\t50\tdocs/guide.md',
    '200\t60\tdocs/PR_1/spec.md',
    '300\t70\t"docs/quoted\\tname.md"',
    '400\t80\tdocs/{old => new}/guide.md',
    '500\t90\t{src => docs}/example.py',
    '1\t2\t{docs => src}/example.py',
    '3\t4\tapp/docs/help.md',
    '5\t6\tdocs-extra/guide.md',
    '7\t8\tREADME.md',
    '-\t-\timage.png',
  ].join('\n'));
  assert.deepEqual(plain(sumFiles(files)), { add: 16, del: 20 });
  assert.equal(files.length, 10);
  assert.equal(files[0].add, 100, 'individual file counts stay available');
  assert.deepEqual(plain(sumFiles(files.slice(0, 5))), { add: 0, del: 0 });
});

test('rendered Staged and Changes totals exclude docs while file rows stay visible', () => {
  const script = load().getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  const root = {};
  const handlers = {};
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage() {} }),
    document: { getElementById: () => root, addEventListener() {} },
    window: { addEventListener: (name, handler) => { handlers[name] = handler; } },
  });
  handlers.message({ data: { type: 'data', repos: [{
    repoPath: '/repo', name: 'repo', branch: 'master', totals: { add: 7, del: 3 },
    staged: [{ path: 'docs/guide.md', add: 100, del: 50 }, { path: 'code.py', add: 4, del: 1 }],
    unstaged: [{ path: 'docs/PR_1/spec.md', add: 200, del: 60 }],
    untracked: [{ path: 'new.py', add: 3, del: 2 }], commits: [],
  }] } });
  assert.match(root.innerHTML, /Staged \(2\)[^]*?class="add">\+4<\/span><span class="del">−1/);
  assert.match(root.innerHTML, /Changes \(2\)[^]*?class="add">\+3<\/span><span class="del">−2/);
  assert.match(root.innerHTML, /guide\.md/);
  assert.match(root.innerHTML, /spec\.md/);
  assert.match(root.innerHTML, /class="add">\+100/);
});

test('real Git totals omit docs across dirty files, branch changes, and commit history', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-hq-totals-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  git('init', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  write('code.py', 'original\n');
  write('docs/guide.md', 'original\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Base');

  const { collectRepo, StatsViewProvider } = load();
  const master = await collectRepo(repo, new Set());
  assert.equal(master.commits[0].add, 1, 'recent master history excludes docs too');
  assert.equal(master.commits[0].files, 2);

  git('switch', '-c', 'feature');
  write('code.py', 'replacement\nsecond\n');
  write('docs/guide.md', 'documentation\nsecond\nthird\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Mixed change');
  write('docs/nested/spec.md', 'documentation only\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Docs only');

  write('code.py', 'replacement\nsecond\nstaged\n');
  write('docs/guide.md', 'documentation\nsecond\nthird\nstaged\n');
  git('add', '.');
  write('code.py', 'replacement\nsecond\nstaged\nunstaged\n');
  write('docs/guide.md', 'documentation\nsecond\nthird\nstaged\nunstaged\n');
  write('new.py', 'new\n');
  write('docs/new.md', 'new documentation\n');

  const result = await collectRepo(repo, new Set());
  assert.deepEqual(plain(result.totals), { add: 3, del: 0 });
  assert.deepEqual(plain(result.vsMaster.totals), { add: 2, del: 1 });
  assert.equal(result.staged.length, 2);
  assert.equal(result.unstaged.length, 2);
  assert.equal(result.untracked.length, 2);
  assert.equal(result.vsMaster.files.length, 3);
  assert.deepEqual(plain(result.commits.map(({ subject, add, del, files }) => ({ subject, add, del, files }))), [
    { subject: 'Docs only', add: 0, del: 0, files: 1 },
    { subject: 'Mixed change', add: 2, del: 1, files: 2 },
  ]);

  const provider = new StatsViewProvider();
  let expanded;
  provider.view = { webview: { postMessage: (message) => { expanded = message; } } };
  await provider.onMessage({ type: 'expandCommit', repoPath: repo, hash: result.commits[0].hash });
  assert.equal(expanded.files[0].path, 'docs/nested/spec.md');
  assert.equal(expanded.files[0].add, 1);
});
