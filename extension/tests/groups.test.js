const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function load() {
  return vm.runInNewContext(source + '\n({ fileGroup, getHtml, StatsViewProvider });', {
    module: { exports: {} }, process, Buffer,
    require: (name) => name === 'vscode' ? {
      Uri: { file: (file) => file },
      workspace: { getConfiguration: () => ({ get: () => [] }) },
      window: { createOutputChannel: () => ({ appendLine() {} }) },
    } : require(name),
  });
}

function view() {
  const { getHtml, StatsViewProvider } = load();
  const root = { innerHTML: '' };
  const events = {};
  let receive, saved;
  vm.runInNewContext(getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1], {
    acquireVsCodeApi: () => ({
      getState: () => undefined,
      setState: (state) => { saved = JSON.parse(JSON.stringify(state)); },
      postMessage() {},
    }),
    document: { getElementById: () => root, addEventListener: (name, fn) => { events[name] = fn; } },
    window: { addEventListener: (name, handler) => { receive = handler; } },
  });
  const provider = new StatsViewProvider();
  provider.view = { webview: { postMessage: (data) => receive({ data }) } };
  const click = (act) => events.click({ target: { closest: (s) => s === '.row' ? { dataset: { act } } : null } });
  return { root, provider, click, send: (data) => receive({ data }), saved: () => saved };
}

const names = (html) => [...html.matchAll(/<span class="name">([^<]*)<\/span>/g)].map((m) => m[1]);

test('files group by kind', () => {
  const { fileGroup } = load();
  for (const [file, group] of [
    ['invoice/views.py', 'code'], ['invoice/templates/invoice/list.html', 'code'],
    ['invoice/static/invoice/style.css', 'code'], ['extension/extension.js', 'code'],
    ['invoice/tests.py', 'checks'], ['scripts/ci', 'checks'], ['scripts/tests/test_ci.py', 'checks'],
    ['kylie/management/commands/visual_baselines.py', 'checks'],
    ['scripts/kylie_cases.py', 'scripts'], ['deploy.sh', 'scripts'],
    ['.agents/skills/kylie-ci/scripts/check.py', 'scripts'], ['bin/tool', 'scripts'],
    ['docs/rules/spec_ci.md', 'rules'], ['docs/PR_1/shot.png', 'docs'], ['AGENTS.md', 'rules'],
    ['CLAUDE.md', 'rules'], ['HARD_RULES.md', 'rules'], ['extension/AGENTS.md', 'rules'],
    ['docs/PR_226/spec_rules.md', 'docs'], ['docs/rules/diagram.png', 'docs'],
    ['nachorder/templates/nachorder/stall_rules.html', 'code'], ['nachorder/CONTRACT.md', 'rules'],
    ['.agents/skills/kylie-ci/SKILL.md', 'rules'], ['.agents/skills/kylie-ci/references/implementation.md', 'rules'],
    ['wawiData/REVENUE.md', 'docs'], ['nachorder/contracts/diagram.png', 'other'],
    ['nachorder/contracts/flow.md', 'rules'], ['"docs/quoted\\tname.md"', 'docs'],
    ['requirements_prd.txt', 'other'], ['deployment/kylie.service', 'other'], ['logo.png', 'other'],
    ['contest.py', 'code'], ['scripted/view.py', 'code'],
    ['invoice/migrations/0042_payee.py', 'migrations'], ['invoice/migrations/__init__.py', 'migrations'],
    ['app\\migrations\\0001_initial.py', 'migrations'], ['tests/migrations/0001_initial.py', 'checks'],
    ['scripts/land_migrations.py', 'checks'], ['patient/reshipment_status_migration.py', 'code'],
    ['invoice/migrations.py', 'code'],
  ]) {
    assert.equal(fileGroup({ path: file }), group, file);
  }
  assert.equal(fileGroup({ path: 'staticfiles/lib/main.js', vendorHead: true }), 'vendor');
  assert.equal(fileGroup({ path: 'staticfiles/lib/README.md', vendor: 'Library' }), 'vendor');
});

test('file lists show groups in order with sorted files and full group totals', () => {
  const v = view();
  const files = [
    { path: 'docs/PR_1/prompts.md', add: 40, del: 0 },
    { path: 'scripts/tool.py', add: 5, del: 1 },
    { path: 'order/views.py', add: 3, del: 2 },
    { path: 'invoice/views10.py', add: 1, del: 0 },
    { path: 'invoice/views2.py', add: 1, del: 0 },
    { path: 'invoice/tests.py', add: 9, del: 9 },
    { path: 'invoice/migrations/0042_payee.py', add: 30, del: 0 },
    { path: 'docs/rules/WORKFLOW.md', add: 2, del: 1 },
  ];
  v.send({ type: 'data', repos: [{
    repoPath: '/a', name: 'pr-1', branch: 'pr-1', totals: { add: 0, del: 0 },
    staged: [], unstaged: files.slice(0, 2), untracked: [{ path: 'AGENTS.md', add: 2, del: 0, letter: 'U' }],
    vsMaster: { files, totals: { add: 10, del: 3 }, mergeBase: 'base' },
    commitsLabel: 'Commits (0)', commits: [],
  }] });
  const html = v.root.innerHTML;
  assert.deepEqual(names(html), [
    'pr-1', 'Vs master (8)', 'Rules (1)', 'WORKFLOW.md', 'Code (3)', 'views2.py', 'views10.py', 'views.py', 'Migrations (1)', '0042_payee.py',
    'CI and tests (1)', 'tests.py', 'Scripts (1)', 'tool.py', 'Docs (1)', 'prompts.md',
  ]);
  const groupRows = html.match(/<div class="row grp"[^]*?<\/div>/g);
  const docs = groupRows.find((row) => row.includes('Docs (1)'));
  assert.match(docs, /class="add">\+40<\/span><span class="del">−0/);
  const migrations = groupRows.find((row) => row.includes('Migrations (1)'));
  assert.match(migrations, /class="add">\+30<\/span><span class="del">−0/);
  assert.match(html, /data-act="m\|\/a\|base\|invoice\/views2\.py"/);
});

test('Vs master holds uncommitted files without a marker and replaces Staged and Changes', () => {
  const v = view();
  v.send({ type: 'data', repos: [{
    repoPath: '/a', name: 'pr-1', branch: 'pr-1', totals: { add: 3, del: 0 },
    staged: [{ path: 'app.py', add: 1, del: 0 }], unstaged: [{ path: 'nachorder/models.py', add: 2, del: 0 }],
    untracked: [{ path: 'docs/PR_1/spec.md', add: 4, del: 0, letter: 'U' }],
    vsMaster: { files: [
      { path: 'app.py', add: 5, del: 0, letter: 'M', uncommitted: true },
      { path: 'nachorder/models.py', add: 2, del: 0, letter: 'M', uncommitted: true },
      { path: 'docs/PR_1/spec.md', add: 4, del: 0, letter: 'A', uncommitted: true },
      { path: 'views.py', add: 1, del: 0, letter: 'M' },
    ], totals: { add: 8, del: 0 }, mergeBase: 'base', behind: 0, ahead: 1 },
    commitsLabel: 'Commits (0)', commits: [],
  }] });
  const html = v.root.innerHTML;
  assert.deepEqual(names(html), [
    'pr-1', 'Vs master (4)', 'Code (3)', 'app.py', 'models.py', 'views.py', 'Docs (1)', 'spec.md',
  ]);
  const rows = html.match(/<div class="row [^]*?<\/div>/g);
  assert.doesNotMatch(rows[0], /class="add"/, 'the open branch row leaves its totals to Vs master');
  assert.doesNotMatch(html, /uncommitted/);
  assert.match(html, /data-act="m\|\/a\|base\|nachorder\/models\.py"/);
});

test('groups collapse on their own and both bulk actions reopen them', () => {
  const v = view();
  v.send({ type: 'data', repos: [{
    repoPath: '/a', name: 'pr-1', branch: 'pr-1', totals: { add: 0, del: 0 },
    staged: [], unstaged: [], untracked: [],
    vsMaster: { files: [{ path: 'app.py', add: 1, del: 0 }, { path: 'README.md', add: 1, del: 0 }], totals: { add: 1, del: 0 } },
    commitsLabel: 'Commits (1)', commits: [{ hash: 'abc', short: 'abc', subject: 'A commit', when: 'today' }],
  }] });
  v.click('t|g|/a|vsmaster|docs|0');
  assert.equal(v.saved().collapsed['g|/a|vsmaster|docs'], true);
  assert.match(v.root.innerHTML, /app\.py/);
  assert.doesNotMatch(v.root.innerHTML, /README\.md/);

  v.provider.setExpansion('collapse');
  assert.equal(v.saved().collapsed['g|/a|vsmaster|docs'], undefined);
  v.provider.setExpansion('expand');
  v.send({ type: 'commitFiles', repoPath: '/a', hash: 'abc', files: [
    { path: 'z.py', add: 1, del: 0 }, { path: 'docs/a.md', add: 1, del: 0 }, { path: 'a.py', add: 1, del: 0 },
  ] });
  assert.deepEqual(names(v.root.innerHTML), [
    'pr-1', 'Vs master (2)', 'Code (1)', 'app.py', 'Docs (1)', 'README.md',
    'Commits (1)', 'A commit', 'Code (2)', 'a.py', 'z.py', 'Docs (1)', 'a.md',
  ]);
  assert.match(v.root.innerHTML, /data-act="t\|g\|\/a\|c:abc\|docs\|0"/);
});

test('expanded commit files carry vendor marks for their group', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-hq-groups-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(path.join(repo, 'vendor/library'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'vendor/library/package.json'), '{"name":"library","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(repo, 'vendor/library/main.js'), 'library\n');
  fs.writeFileSync(path.join(repo, 'app.js'), 'app\n');
  git('init', '-b', 'master');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Add');
  const { StatsViewProvider, fileGroup } = load();
  const provider = new StatsViewProvider();
  let expanded;
  provider.view = { webview: { postMessage: (message) => { expanded = message; } } };
  await provider.onMessage({ type: 'expandCommit', repoPath: repo, hash: git('rev-parse', 'HEAD').trim() });
  assert.deepEqual(JSON.parse(JSON.stringify(expanded.files.map((f) => [f.path, fileGroup(f)]))), [
    ['app.js', 'code'], ['vendor/library/main.js', 'vendor'], ['vendor/library/package.json', 'vendor'],
  ]);
});
