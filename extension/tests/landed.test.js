const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

// The Kylie checkout with the squash commit of PR 9, whose worktree `ci land`
// deleted; .ci and kylie-shots keep its facts beside the worktrees folder.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-landed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kylie = path.join(root, 'kylie');
  const ci = path.join(root, 'kylie-worktrees', '.ci');
  fs.mkdirSync(path.join(kylie, 'docs', 'PR_9'), { recursive: true });
  fs.mkdirSync(path.join(kylie, 'app'));
  fs.mkdirSync(ci, { recursive: true });
  fs.mkdirSync(path.join(root, 'kylie-shots', 'PR_9'), { recursive: true });
  const git = (...args) => cp.execFileSync('git', args, { cwd: kylie, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(kylie, 'README'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'Base');
  fs.writeFileSync(path.join(kylie, 'app', 'views.py'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(kylie, 'docs', 'PR_9', 'cx_estimate.json'), '{"cx": 2, "prompt": "1", "reason": "one view"}\n');
  git('add', '.');
  git('commit', '-qm', 'PR 9 — landed row kept');
  fs.writeFileSync(path.join(ci, 'pr-9.slug'), 'landed-row-kept\n');
  fs.writeFileSync(path.join(ci, 'pr-9.case'), '8358\n');
  fs.writeFileSync(path.join(ci, 'pr-9.group'), 'nachorder\n');
  fs.writeFileSync(path.join(ci, 'pr-9.from'), '5\n');
  fs.writeFileSync(path.join(root, 'kylie-shots', 'PR_9', 'a.png'), '');
  const opened = [];
  const terminal = (name) => ({ name, creationOptions: {}, show() {} });
  const vscode = {
    Uri: { parse: (value) => ({ value }), file: (value) => value },
    env: { openExternal: async (uri) => { opened.push(uri.value); return true; } },
    window: { terminals: [], createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: async () => {} },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => '' }) },
    commands: { executeCommand: async () => {} },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, TerminalList, getHtml });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, process,
    require: (name) => (name === 'vscode' ? vscode : require(name)),
  });
  const provider = new api.StatsViewProvider();
  provider.terminalList = new api.TerminalList();
  provider.repos = [kylie];
  const gone = path.join(root, 'kylie-worktrees', 'pr-9');
  return { ...api, root, kylie, gone, git, provider, vscode, terminal, opened };
}

test('a landed PR without a worktree keeps its CI facts and squash commit while a terminal of the window names it', async (t) => {
  const f = fixture(t);
  const w = f.vscode.window;
  assert.equal(await f.provider.collectLanded(f.provider.repos), false, 'no terminal names a landed PR');
  assert.equal(f.provider.landed.size, 0);

  w.terminals.push(f.terminal('bash local'), f.terminal('✳ pr-9 nachorder [landed] landed row kept'),
    f.terminal('✳ pr-6 removed without landing'));
  assert.equal(await f.provider.collectLanded(f.provider.repos), true);
  assert.deepEqual([...f.provider.landed.keys()], [f.gone]);
  const row = plain(f.provider.landed.get(f.gone));
  assert.equal(row.name, 'pr-9');
  assert.deepEqual(row.pr, { serial: 9, label: '#8358 - landed row kept', caseNumber: 8358, origin: 5,
    group: 'nachorder', postponed: false, shots: { images: 1, taken: null }, status: 'landed', conflicts: [],
    estimate: { cx: 2, prompt: '1', reason: 'one view' } });
  assert.equal(row.landed.kylie, f.kylie);
  assert.equal(row.landed.hash, f.git('rev-parse', 'HEAD'));
  assert.deepEqual(row.landed.files.map((x) => [x.path, x.letter, x.add, x.del]),
    [['app/views.py', 'A', 3, 0], ['docs/PR_9/cx_estimate.json', 'A', 1, 0]]);
  assert.deepEqual(row.landed.totals, { add: 3, del: 0 }, 'line totals exclude docs');
  assert.deepEqual(plain(f.provider.terminals()).map((x) => [x.name, x.repoPath]), [
    ['bash local', null], ['✳ pr-9 nachorder [landed] landed row kept', f.gone], ['✳ pr-6 removed without landing', null]]);

  const posted = [];
  f.provider.view = { webview: { postMessage: (m) => posted.push(plain(m)) } };
  f.provider.push();
  assert.deepEqual(posted.at(-1).repos.map((r) => r.repoPath), [f.gone], 'the landed row follows the repository rows');
  await f.provider.onMessage({ type: 'case', repoPath: f.gone });
  assert.deepEqual(f.opened, ['https://kylie.duett-boutiques.ch/case/8358']);

  // A worktree that still exists is its own row; a closed terminal drops the landed row.
  assert.equal(await f.provider.collectLanded([f.kylie, f.gone]), false, 'an obsolete scan publishes nothing');
  f.provider.repos = [f.kylie, f.gone];
  assert.equal(await f.provider.collectLanded(f.provider.repos), true);
  assert.equal(f.provider.landed.size, 0);
  f.provider.repos = [f.kylie];
  w.terminals.splice(1, 1);
  assert.equal(await f.provider.collectLanded(f.provider.repos), false);
  assert.equal(f.provider.landed.size, 0);
});

test('landed PRs follow last under an open landed header; a row without a worktree shows its squash commit files and disappears with its last terminal', (t) => {
  const f = fixture(t);
  const root = { innerHTML: '' }, posted = [];
  let receive, click;
  vm.runInNewContext(f.getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ getState: () => ({ collapsed: {} }), setState() {}, postMessage: (m) => posted.push(m) }),
    document: { getElementById: () => root, addEventListener: (type, handler) => { if (type === 'click') click = handler; } },
    window: { addEventListener: (type, handler) => { if (type === 'message') receive = handler; } },
  });
  const row = (repoPath, pr, extra) => ({ repoPath, name: path.basename(repoPath), branch: path.basename(repoPath),
    totals: { add: 0, del: 0 }, staged: [], unstaged: [], untracked: [], commits: [], pr, group: pr && pr.group || '', ...extra });
  const landed = (serial, files) => row('/w/pr-' + serial, { serial, status: 'landed', label: 'landed row kept',
    caseNumber: 8358, estimate: { cx: 2 } }, { branch: '', landed: { kylie: '/w/kylie', hash: 'abc123', short: 'abc1',
    when: '5 minutes ago', files, totals: { add: 3, del: 0 } } });
  const files = [{ path: 'app/views.py', letter: 'A', add: 3, del: 0 }];
  const terminals = [
    { key: '1', name: '✳ pr-9 nachorder [landed] landed row kept', repoPath: '/w/pr-9', active: false, claude: true },
    { key: '2', name: 'bash', repoPath: '/w/pr-9', active: false, claude: false },
  ];
  receive({ data: { type: 'data', repos: [row('/w/kylie', null), row('/w/pr-3', { serial: 3, status: 'wip', group: 'invoice' }),
    row('/w/pr-4', { serial: 4, status: 'landed', group: 'invoice' }), row('/w/pr-5', { serial: 5, status: 'wip' }),
    landed(9, files), landed(10, files)], terminals } });
  const names = (html) => [...html.matchAll(/<span class="name">([^<]*)/g)].map((m) => m[1]);
  assert.deepEqual(names(root.innerHTML), ['kylie', 'invoice (1)', '', 'no group (1)', '', 'landed (2)', '', '']);
  assert.match(root.innerHTML, /data-act="t\|p\|~landed\|0">.*landed \(2\)/, 'the landed header starts open');
  assert.ok(!root.innerHTML.includes('/w/pr-10'), 'a landed row without a terminal is hidden');
  assert.ok(root.innerHTML.indexOf('/w/pr-4') < root.innerHTML.indexOf('/w/pr-9'), 'rows keep their order under the header');
  const pr9 = root.innerHTML.slice(root.innerHTML.indexOf('data-act="t|r|/w/pr-9|1"') - 200);
  assert.match(pr9, /<span class="dim">landed row kept<\/span><span class="term" data-term="1"[^>]*>✳<\/span><span class="term" data-term="2"[^>]*>›_<\/span><span class="case" data-case="\/w\/pr-9"/,
    'no Claude or Codex control, as the worktree is gone');
  assert.match(pr9, /<span class="cxl">est<\/span>\+2<\/span><span class="cx"><\/span><span class="st"><\/span><span class="add">\+3<\/span>/);
  assert.equal([...root.innerHTML.matchAll(/data-claude="\/w\/pr-4"/g)].length, 1, 'a landed worktree keeps its controls');

  click({ target: { closest: (s) => s === '.row' ? { dataset: { act: 't|r|/w/pr-9|1' } } : null } });
  assert.match(root.innerHTML, /data-act="t\|s\|\/w\/pr-9\|landed\|0"><span class="twist">▾<\/span><span class="name">Landed \(1\)<\/span><span class="dim">abc1 · 5 minutes ago<\/span>/);
  assert.match(root.innerHTML, /data-act="k\|\/w\/pr-9\|abc123\|app\/views.py"/);
  click({ target: { closest: (s) => s === '.row' ? { dataset: { act: 'k|/w/pr-9|abc123|app/views.py' } } : null } });
  assert.deepEqual(plain(posted.filter((m) => m.type === 'open')),
    [{ type: 'open', mode: 'commit', repoPath: '/w/pr-9', hash: 'abc123', path: 'app/views.py' }]);

  receive({ data: { type: 'terminals', terminals: terminals.slice(1) } });
  assert.ok(root.innerHTML.includes('/w/pr-9'), 'one terminal keeps the row');
  receive({ data: { type: 'terminals', terminals: [] } });
  assert.ok(!root.innerHTML.includes('/w/pr-9'), 'closing the last terminal removes the row');
  assert.match(root.innerHTML, /landed \(1\)/);
});
