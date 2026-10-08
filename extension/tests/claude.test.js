const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function procStart(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

// A Kylie layout: worktrees beside their .ci state, a Claude home whose project
// directories hold session transcripts, and a claude executable on PATH.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'kylie');
  const repo = path.join(root, 'kylie-worktrees', 'pr-7');
  const titles = path.join(root, 'kylie-worktrees', '.ci', 'session-titles');
  const home = path.join(root, 'home');
  const sessions = path.join(home, '.claude', 'sessions');
  const bin = path.join(root, 'bin');
  for (const dir of [repo, titles, sessions, bin]) fs.mkdirSync(dir, { recursive: true });
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, '#!/bin/sh\n', { mode: 0o755 });
  let age = 0;
  // Each session is newer than the one recorded before it.
  const session = (id, title, cwd = workspace) => {
    if (title !== null) fs.writeFileSync(path.join(titles, id), title);
    if (cwd === null) return;
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, id + '.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const when = new Date(Date.UTC(2026, 9, 1) + 60000 * ++age);
    fs.utimesSync(transcript, when, when);
  };
  // Claude's record of a live session, as ~/.claude/sessions/<pid>.json holds it.
  const live = (sessionId, pid, start = procStart(pid)) => fs.writeFileSync(path.join(sessions, pid + '.json'),
    JSON.stringify({ pid, sessionId, cwd: workspace, procStart: start, entrypoint: 'cli' }));

  const created = [], shown = [], infos = [], errors = [];
  const terminal = (name, pid, exitStatus) => ({ name, exitStatus, creationOptions: { name },
    processId: Promise.resolve(pid), show() { shown.push(name + (pid ? ' @' + pid : '')); } });
  const vscode = {
    window: {
      terminals: [],
      createTerminal: (options) => {
        created.push(options);
        return terminal(options.name);
      },
      createOutputChannel: () => ({ appendLine() {} }),
      showInformationMessage: async (message) => { infos.push(message); },
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }], getConfiguration: () => ({ get: () => '' }) },
  };
  const env = { ...process.env, HOME: home, PATH: bin };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout,
    process: Object.assign(Object.create(process), { env }),
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  const provider = new api.StatsViewProvider();
  provider.data.set(repo, { repoPath: repo, name: 'pr-7', pr: { serial: 7, status: 'wip' } });
  return { ...api, provider, repo, workspace, claude, env, session, live, terminal,
    terminals: vscode.window.terminals, created, shown, infos, errors,
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
    row(f.repo, { serial: 7, status: 'landed' }),
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

test("a PR's newest Claude session resumes in a terminal, in the folder it started in", async (t) => {
  const f = fixture(t);
  f.session('11111111-1111-4111-8111-111111111111', 'pr-7: clear review status');
  f.session('22222222-2222-4222-8222-222222222222', 'PR-7: clear review status', f.repo);
  f.session('33333333-3333-4333-8333-333333333333', 'pr-70: another pull request');
  f.session('44444444-4444-4444-8444-444444444444', 'pr-7: elsewhere', '/home/someone/other-repo');
  f.session('55555555-5555-7555-8555-555555555555', 'pr-7: codex thread without a Claude transcript', null);
  f.session('66666666-6666-4666-8666-666666666666', null); // a transcript the registry never titled
  f.terminals.push(f.terminal('Claude pr-70', 0), f.terminal('Claude pr-7', 0, { code: 0 }));
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ name: 'Claude pr-7', cwd: f.repo, shellPath: f.claude,
    shellArgs: ['--resume', '22222222-2222-4222-8222-222222222222'] }]);
  assert.deepEqual(f.shown, ['Claude pr-7']);

  f.created.length = 0;
  f.session('77777777-7777-4777-8777-777777777777', 'pr-7: clear review status');
  await f.click();
  assert.equal(f.created[0].cwd, f.workspace);
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['--resume', '77777777-7777-4777-8777-777777777777']);
  assert.deepEqual(f.errors, []);
});

test('without a Claude session, a new one starts in the worktree with nothing sent', async (t) => {
  const f = fixture(t);
  f.session('55555555-5555-7555-8555-555555555555', 'pr-7: codex thread without a Claude transcript', null);
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ name: 'Claude pr-7', cwd: f.repo, shellPath: f.claude, shellArgs: [] }]);
});

test("the PR's open Claude terminal is focused instead of starting another", async (t) => {
  const f = fixture(t);
  f.session('11111111-1111-4111-8111-111111111111', 'pr-7: clear review status');
  f.terminals.push(f.terminal('Claude pr-7', 0));
  await f.click();
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.shown, ['Claude pr-7']);
});

test('a running session is focused in the terminal holding it and never resumed twice', async (t) => {
  const f = fixture(t);
  const id = '11111111-1111-4111-8111-111111111111';
  f.session(id, 'pr-7: clear review status');
  f.live(id, process.pid);
  // This test process stands in for claude; its parent is the terminal's shell.
  f.terminals.push(f.terminal('bash', 1), f.terminal('zsh', process.ppid));
  await f.click();
  assert.deepEqual(f.shown, ['zsh @' + process.ppid]);

  f.terminals.length = 0;
  await f.click();
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.infos, [`The Claude session for pr-7 is already running outside this window's terminals (pid ${process.pid}).`]);

  // A record whose pid now belongs to another process is stale.
  f.live(id, process.pid, '1');
  await f.click();
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['--resume', id]);
});

test('unknown and non-PR rows open nothing, and a missing claude CLI is reported', async (t) => {
  const f = fixture(t);
  await f.provider.onMessage({ type: 'claude', repoPath: '/nowhere/pr-9' });
  f.provider.data.set(f.workspace, { repoPath: f.workspace, name: 'kylie', pr: null });
  await f.provider.onMessage({ type: 'claude', repoPath: f.workspace });
  assert.deepEqual(f.created, []);

  fs.rmSync(f.claude);
  f.env.HOME = path.join(f.workspace, 'no-home');
  await f.click();
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.errors, ['Could not open Claude for pr-7: the claude CLI is not on PATH or in ~/.local/bin']);
});
