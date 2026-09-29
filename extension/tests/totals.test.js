const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(declarations = []) {
  return vm.runInNewContext(source + `
    collectComplexity = async () => null;
    ({ collectRepo, StatsViewProvider, sumFiles, parseNumstat, getHtml });
  `, {
    module: { exports: {} }, process, Buffer,
    require: (name) => name === 'vscode' ? {
      Uri: { file: (file) => file },
      workspace: { getConfiguration: () => ({ get: (key) => key === 'vendorLibraries' ? declarations : '' }) },
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
  assert.deepEqual(plain(sumFiles(files)), { add: 16, del: 108 });
  assert.equal(files.length, 10);
  assert.equal(files[0].add, 100, 'individual file counts stay available');
  assert.deepEqual(plain(sumFiles(files.slice(0, 5))), { add: 0, del: 90 });
});

test('all totals share complexity exclusions while application templates and tools still count', () => {
  const { sumFiles } = load();
  const excluded = [
    'invoice/tests.py', 'tests/fixture.json', 'src/widget.spec.ts',
    'scripts/ci', 'scripts/audit_runner.py', 'scripts/ci_settings.py',
    'kylie/tests_visual/engine.py', 'kylie/management/commands/visual_baselines.py',
    '.github/workflows/ci.yml', '"tests/quoted\\tname.py"',
  ].map((path) => ({ path, add: 100, del: 50 }));
  const application = [
    'invoice/views.py', 'invoice/templates/invoice/list.html',
    'invoice/static/invoice/style.css', 'scripts/kylie_cases.py',
    'contest.py', 'invoice/audit_runner.py',
  ].map((path) => ({ path, add: 2, del: 1 }));
  assert.deepEqual(plain(sumFiles([...excluded, ...application])), { add: 12, del: 6 });
  assert.deepEqual(plain(sumFiles(excluded)), { add: 0, del: 0 });
  assert.equal(excluded[0].add, 100);
});

test('renamed line additions and deletions use their own side of the exclusions', () => {
  const { sumFiles, parseNumstat } = load();
  for (const [oldPath, newPath, expected] of [
    ['app/helper.py', 'tests/helper.py', { add: 0, del: 3 }],
    ['tests/helper.py', 'app/helper.py', { add: 7, del: 0 }],
    ['app/helper.py', 'scripts/audit_runner.py', { add: 0, del: 3 }],
    ['scripts/audit_runner.py', 'app/helper.py', { add: 7, del: 0 }],
  ]) {
    assert.deepEqual(plain(sumFiles(parseNumstat(`7\t3\t${oldPath} => ${newPath}`))), expected);
  }
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
    staged: [{ path: 'docs/guide.md', add: 100, del: 50 }, { path: 'code.py', add: 4, del: 1 },
      { path: 'scripts/audit_runner.py', add: 100, del: 50 }],
    unstaged: [{ path: 'docs/PR_1/spec.md', add: 200, del: 60 },
      { path: 'tests/helper.py', add: 100, del: 50 },
      { path: 'vendor/library/main.js', add: 100, del: 50, vendorHead: true, vendorBase: true }],
    untracked: [{ path: 'new.py', add: 3, del: 2 }], commits: [],
  }] } });
  const rows = root.innerHTML.match(/<div class="row [^]*?<\/div>/g);
  assert.match(rows.find((row) => row.includes('Staged (3)')), /class="add">\+4<\/span><span class="del">−1/);
  assert.match(rows.find((row) => row.includes('Changes (4)')), /class="add">\+3<\/span><span class="del">−2/);
  assert.match(root.innerHTML, /guide\.md/);
  assert.match(root.innerHTML, /spec\.md/);
  assert.match(root.innerHTML, /audit_runner\.py/);
  assert.match(root.innerHTML, /main\.js/);
  assert.match(root.innerHTML, /class="add">\+100/);
});

test('real Git totals omit docs, CI, tests and vendors across dirty files, branches, and commits', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-hq-totals-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const excluded = ['docs/guide.md', 'invoice/tests.py', 'scripts/audit_runner.py',
    'kylie/tests_visual/engine.py', 'vendor/library/main.js', 'assets/explicit/main.js'];
  git('init', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  write('code.py', 'original\n');
  for (const file of excluded) write(file, 'original\n');
  write('vendor/library/package.json', '{"name":"library","version":"1.0.0"}\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Base');

  const { collectRepo, StatsViewProvider } = load([{ name: 'Explicit', path: 'assets/explicit' }]);
  const master = await collectRepo(repo, new Set());
  assert.equal(master.commits[0].add, 1, 'recent master history uses the same exclusions');
  assert.equal(master.commits[0].files, 8);

  git('switch', '-c', 'feature');
  write('code.py', 'replacement\nsecond\n');
  for (const file of excluded) write(file, 'excluded\nsecond\nthird\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Mixed change');
  write('docs/nested/spec.md', 'documentation only\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Docs only');

  write('code.py', 'replacement\nsecond\nstaged\n');
  for (const file of excluded) write(file, 'excluded\nsecond\nthird\nstaged\n');
  git('add', '.');
  write('code.py', 'replacement\nsecond\nstaged\nunstaged\n');
  for (const file of excluded) write(file, 'excluded\nsecond\nthird\nstaged\nunstaged\n');
  write('new.py', 'new\n');
  for (const file of ['docs/new.md', 'tests/new.py', 'vendor/library/new.js', 'assets/explicit/new.js']) {
    write(file, 'new excluded line\n');
  }

  const result = await collectRepo(repo, new Set());
  assert.deepEqual(plain(result.totals), { add: 3, del: 0 });
  assert.deepEqual(plain(result.vsMaster.totals), { add: 2, del: 1 });
  assert.equal(result.staged.length, 7);
  assert.equal(result.unstaged.length, 7);
  assert.equal(result.untracked.length, 5);
  assert.equal(result.vsMaster.files.length, 8);
  assert.deepEqual(plain(result.commits.map(({ subject, add, del, files }) => ({ subject, add, del, files }))), [
    { subject: 'Docs only', add: 0, del: 0, files: 1 },
    { subject: 'Mixed change', add: 2, del: 1, files: 7 },
  ]);

  const provider = new StatsViewProvider();
  let expanded;
  provider.view = { webview: { postMessage: (message) => { expanded = message; } } };
  await provider.onMessage({ type: 'expandCommit', repoPath: repo, hash: result.commits[0].hash });
  assert.equal(expanded.files[0].path, 'docs/nested/spec.md');
  assert.equal(expanded.files[0].add, 1);
});

test('vendor line exclusions use each revision, index, and working copy metadata independently', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-hq-vendor-totals-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (file, content) => fs.writeFileSync(path.join(repo, file), content);
  git('init', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(repo, 'vendor/library'), { recursive: true });
  write('vendor/library/main.js', 'old\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Unidentified code');
  git('switch', '-c', 'feature');

  write('vendor/library/main.js', 'replacement\n');
  git('add', '.');
  write('vendor/library/main.js', 'replacement\nworking\n');
  write('vendor/library/new.js', 'new\n');
  write('vendor/library/package.json', '{"name":"library","version":"1.0.0"}\n');
  const { collectRepo } = load();
  let result = await collectRepo(repo, new Set());
  assert.deepEqual(plain(result.totals), { add: 1, del: 1 }, 'untracked metadata only excludes working additions');
  assert.equal(result.staged[0].vendorHead, false);
  assert.equal(result.unstaged[0].vendorHead, true);

  git('add', 'vendor/library/package.json');
  result = await collectRepo(repo, new Set());
  assert.deepEqual(plain(result.totals), { add: 0, del: 1 }, 'staged metadata excludes additions but not the application base');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Identify library');
  result = await collectRepo(repo, new Set());
  assert.deepEqual(plain(result.vsMaster.totals), { add: 0, del: 1 });
  assert.deepEqual(plain({ add: result.commits[0].add, del: result.commits[0].del }), { add: 0, del: 1 });

  fs.unlinkSync(path.join(repo, 'vendor/library/package.json'));
  git('add', 'vendor/library');
  result = await collectRepo(repo, new Set());
  assert.deepEqual(plain(result.totals), { add: 2, del: 0 }, 'removing metadata makes new index code count again');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Return to application code');
  result = await collectRepo(repo, new Set());
  assert.deepEqual(plain(result.vsMaster.totals), { add: 3, del: 1 });
  assert.deepEqual(plain({ add: result.commits[0].add, del: result.commits[0].del }), { add: 2, del: 0 });
});
