const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// A Kylie layout: worktrees beside their .ci state, and a Claude home whose
// project directories hold session transcripts.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'kylie');
  const repo = path.join(root, 'kylie-worktrees', 'pr-7');
  const titles = path.join(root, 'kylie-worktrees', '.ci', 'session-titles');
  const home = path.join(root, 'home');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(titles, { recursive: true });
  let age = 0;
  // Each session is newer than the one recorded before it.
  const session = (id, title, project = workspace) => {
    if (title !== null) fs.writeFileSync(path.join(titles, id), title);
    if (project === null) return;
    const dir = path.join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, id + '.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const when = new Date(Date.UTC(2026, 9, 1) + 60000 * ++age);
    fs.utimesSync(transcript, when, when);
  };

  const commands = [], errors = [];
  let fail = null;
  const vscode = {
    commands: { executeCommand: async (...args) => {
      commands.push(args);
      if (fail) throw fail;
    } },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }], getConfiguration: () => ({ get: () => '' }) },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout,
    process: Object.assign(Object.create(process), { env: { ...process.env, HOME: home } }),
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  const provider = new api.StatsViewProvider();
  const pr = { serial: 7, label: '#123 - clear review status', status: 'agent-review-outdated',
    statusLabel: 'agent review outdated',
    reason: 'agent review outdated: changed since review\nAgent: update docs/PR_7/completion.json' };
  provider.data.set(repo, { repoPath: repo, name: 'pr-7', pr });
  return { ...api, provider, repo, pr, session, commands, errors, workspace,
    failWith: (error) => { fail = error; },
    click: () => provider.onMessage({ type: 'claude', repoPath: repo }) };
}

test('every PR row carries one Claude control, and clicking it asks the host without toggling the row', async (t) => {
  const f = fixture(t);
  const root = { innerHTML: '' }, posted = [];
  let receive, click, saved = 0;
  const script = f.getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => { saved++; }, postMessage: (m) => posted.push(m) }),
    document: { getElementById: () => root, addEventListener: (type, handler) => { if (type === 'click') click = handler; } },
    window: { addEventListener: (type, handler) => { if (type === 'message') receive = handler; } },
  });
  const row = (repoPath, pr) => ({ repoPath, name: path.basename(repoPath), branch: path.basename(repoPath),
    totals: { add: 0, del: 0 }, staged: [], unstaged: [], untracked: [], commits: [], pr });
  const quoted = '/tmp/a "quoted" & <odd>/pr-8';
  receive({ data: { type: 'data', repos: [
    row(f.workspace, null),
    row(f.repo, { ...f.pr, status: 'landed' }),
    row(quoted, { serial: 8, status: 'wip' }),
  ] } });
  const controls = [...root.innerHTML.matchAll(/<span class="claude" data-claude="([^"]*)" title="[^"]*">✻<\/span>/g)];
  assert.deepEqual(controls.map((m) => m[1]), [f.repo, '/tmp/a &quot;quoted&quot; &amp; &lt;odd&gt;/pr-8']);
  assert.doesNotMatch(root.innerHTML, /<button\b|<input\b/);

  posted.length = 0;
  const target = { closest: (selector) => selector === '.claude' ? { dataset: { claude: quoted } } : { dataset: { act: 't|r|' + quoted + '|0' } } };
  click({ target });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'claude', repoPath: quoted }]);
  assert.equal(saved, 0, 'the Claude control must not collapse or expand its row');
});

test("a PR's newest Claude session in this workspace is reopened without a prompt", async (t) => {
  const f = fixture(t);
  f.session('11111111-1111-4111-8111-111111111111', 'pr-7: clear review status');
  f.session('22222222-2222-4222-8222-222222222222', 'PR-7 [wip]: clear review status');
  f.session('33333333-3333-4333-8333-333333333333', 'pr-70: another pull request');
  f.session('44444444-4444-4444-8444-444444444444', 'pr-7: elsewhere', '/home/someone/other-repo');
  f.session('55555555-5555-7555-8555-555555555555', 'pr-7: codex thread without a Claude transcript', null);
  f.session('66666666-6666-4666-8666-666666666666', null); // a transcript the registry never titled
  await f.click();
  assert.deepEqual(f.commands, [['claude-vscode.editor.open', '22222222-2222-4222-8222-222222222222', undefined]]);
  assert.deepEqual(f.errors, []);
});

test("without a Claude session, a new one opens with the PR's unsent prompt", async (t) => {
  const f = fixture(t);
  f.session('55555555-5555-7555-8555-555555555555', 'pr-7: codex thread without a Claude transcript', null);
  await f.click();
  assert.deepEqual(f.commands, [['claude-vscode.editor.open', undefined, [
    'Continue PR 7 (#123 - clear review status) in ' + f.repo + '.',
    'CI status: agent review outdated',
    'agent review outdated: changed since review',
    'Agent: update docs/PR_7/completion.json',
  ].join('\n')]]);

  // Landed and running CI states supersede readiness details; a custom label's
  // repeated status line is dropped while the label itself stays.
  f.commands.length = 0;
  Object.assign(f.pr, { status: 'landed', label: null });
  await f.click();
  Object.assign(f.pr, { status: 'blocked', reason: 'Custom label: Waiting for Simon\nCI status: blocked: awaiting input\nUser: resolve the recorded blocker' });
  await f.click();
  assert.deepEqual(f.commands.map((c) => c[2]), [
    'Continue PR 7 in ' + f.repo + '.\nCI status: landed',
    'Continue PR 7 in ' + f.repo + '.\nCI status: blocked\nCustom label: Waiting for Simon\nUser: resolve the recorded blocker',
  ]);
});

test('unknown and non-PR rows open nothing, and a failed open is reported', async (t) => {
  const f = fixture(t);
  await f.provider.onMessage({ type: 'claude', repoPath: '/nowhere/pr-9' });
  f.provider.data.set(f.workspace, { repoPath: f.workspace, name: 'kylie', pr: null });
  await f.provider.onMessage({ type: 'claude', repoPath: f.workspace });
  assert.deepEqual(f.commands, []);

  f.failWith(new Error("command 'claude-vscode.editor.open' not found"));
  await f.click();
  assert.deepEqual(f.errors, ["Could not open Claude for pr-7: command 'claude-vscode.editor.open' not found"]);
});
