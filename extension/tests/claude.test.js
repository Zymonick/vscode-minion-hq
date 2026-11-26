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
  // tmux logs its arguments and prints tmux.out, or fails like tmux without a server.
  const tmux = path.join(bin, 'tmux');
  const tmuxOut = path.join(root, 'tmux.out'), tmuxLog = path.join(root, 'tmux.log');
  fs.writeFileSync(tmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\n[ -f '${tmuxOut}' ] || exit 1\nexec /bin/cat '${tmuxOut}'\n`, { mode: 0o755 });
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

  const created = [], shown = [], infos = [], errors = [], logged = [];
  const sent = [];
  const terminal = (name, pid, exitStatus) => ({ name, exitStatus, creationOptions: { name },
    processId: Promise.resolve(pid), show(preserveFocus) { shown.push(this.name + (pid ? ' @' + pid : '') + (preserveFocus ? ' (no focus)' : '')); },
    sendText(text) { sent.push(`${this.name}: ${text}`); } });
  const vscode = {
    window: {
      terminals: [],
      createTerminal: (options) => {
        created.push(options);
        const value = terminal(options.name || 'claude');
        value.creationOptions = options;
        return value;
      },
      createOutputChannel: () => ({ appendLine: (line) => logged.push(line) }),
      showInformationMessage: async (message) => { infos.push(message); },
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }], getConfiguration: () => ({ get: () => '' }) },
    TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  };
  const env = { ...process.env, HOME: home, PATH: bin };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml, claudeTerminalSessions, claudeSessions, nextRestoreRecord, restoreClaudeSessions, openShellTerminals, claudeSessionWatch, attachBackgroundSessions, claudeTmux, claimRestore, readRestoreRecord, writeRestoreRecord, mapTmuxTerminals, closeClaudeTmux });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    process: Object.assign(Object.create(process), { env }),
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  const provider = new api.StatsViewProvider();
  provider.data.set(repo, { repoPath: repo, name: 'pr-7', pr: { serial: 7, status: 'wip' } });
  // tmux list-panes and list-clients output: sessions [name, created, attached, pane pid], clients [name, pid, tty].
  const tmuxState = (sessions, clients = []) => fs.writeFileSync(tmuxOut, [
    ...sessions.map(([name, made, attached, pid]) => `S\t${name}\t${made}\t${attached}\t${pid}`),
    ...clients.map(([name, pid, tty = '/dev/pts/0']) => `C\t${name}\t${pid}\t${tty}`)].join('\n') + '\n');
  const tmuxCalls = () => fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8').trim().split('\n') : [];
  // A sleeping child process stands in for another claude or a tmux client.
  const child = () => {
    const proc = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
    t.after(() => proc.kill());
    return proc.pid;
  };
  return { ...api, provider, repo, workspace, claude, tmux, env, sessions, session, live, terminal,
    tmuxState, tmuxCalls, child, terminals: vscode.window.terminals, created, shown, sent, infos, errors, logged,
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

test("a PR's newest Claude session resumes in a terminal and continues, in the folder it started in", async (t) => {
  const f = fixture(t);
  f.session('11111111-1111-4111-8111-111111111111', 'pr-7: clear review status');
  f.session('22222222-2222-4222-8222-222222222222', 'PR-7: clear review status', f.repo);
  f.session('33333333-3333-4333-8333-333333333333', 'pr-70: another pull request');
  f.session('44444444-4444-4444-8444-444444444444', 'pr-7: elsewhere', '/home/someone/other-repo');
  f.session('55555555-5555-7555-8555-555555555555', 'pr-7: codex thread without a Claude transcript', null);
  f.session('66666666-6666-4666-8666-666666666666', null); // a transcript the registry never titled
  f.terminals.push(f.terminal('Claude pr-70', 0), f.terminal('Claude pr-7', 0, { code: 0 }));
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ cwd: f.repo, env: { MINION_HQ_CLAUDE_PR: f.repo },
    shellPath: '/bin/bash', shellArgs: ['-ic', 'claude --resume 22222222-2222-4222-8222-222222222222 continue'] }]);
  assert.deepEqual(f.shown, ['claude']);

  f.created.length = 0;
  f.session('77777777-7777-4777-8777-777777777777', 'pr-7: clear review status');
  await f.click();
  assert.equal(f.created[0].cwd, f.workspace);
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['-ic', 'claude --resume 77777777-7777-4777-8777-777777777777 continue']);
  assert.deepEqual(f.errors, []);
});

test('without a Claude session, a new one starts in the worktree with nothing sent', async (t) => {
  const f = fixture(t);
  f.session('55555555-5555-7555-8555-555555555555', 'pr-7: codex thread without a Claude transcript', null);
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ cwd: f.repo, env: { MINION_HQ_CLAUDE_PR: f.repo },
    shellPath: '/bin/bash', shellArgs: ['-ic', 'claude'] }]);
});

test("new Claude terminals keep Claude's live title and stay attached to their PR", async (t) => {
  const f = fixture(t);
  await f.click();
  const own = f.created[0];
  assert.equal(Object.hasOwn(own, 'name'), false, 'a fixed name would hide the working/idle title');
  const other = f.terminal('Claude pr-7', 42);
  other.creationOptions = { env: { MINION_HQ_CLAUDE_PR: '/another/pr-8' } };
  const live = f.terminal('\u25D0 pr-7: clear review status', 43);
  live.creationOptions = own;
  f.terminals.push(other, live);
  await f.click();
  live.name = '\u2733 pr-7: clear review status';
  await f.click();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.shown, ['claude', '\u25D0 pr-7: clear review status @43', '\u2733 pr-7: clear review status @43']);
  live.exitStatus = { code: 0 };
  await f.click();
  assert.equal(f.created.length, 2, 'an exited terminal can be reopened');
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
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['-ic', `claude --resume ${id} continue`]);
});

test("a PR session in tmux is focused in the terminal of its client, or attached when no client shows it", async (t) => {
  const f = fixture(t);
  const id = '11111111-1111-4111-8111-111111111111';
  f.session(id, 'pr-7: clear review status');
  f.live(id, process.pid); // this test process stands in for claude in the tmux pane
  const client = f.child();
  f.tmuxState([['claude-pr-7', 100, 1, process.pid]], [['claude-pr-7', client]]);
  f.terminals.push(f.terminal('bash', 1), f.terminal('tmux', client));
  await f.click();
  assert.deepEqual(f.shown, ['tmux @' + client]);

  f.terminals.length = 0;
  f.tmuxState([['claude-pr-7', 100, 0, process.pid]]);
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [
    { shellPath: f.tmux, shellArgs: ['-L', 'claude', 'attach-session', '-t', '=claude-pr-7'] }]);
  assert.deepEqual(f.infos, []);
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

test("the Claude sessions of this window's terminals are found below the terminal's process", async (t) => {
  const f = fixture(t);
  const id = '11111111-1111-4111-8111-111111111111';
  f.live(id, process.pid);
  // This test process stands in for claude: first as the terminal's process, then below the terminal's shell.
  f.terminals.push(f.terminal('starting', 0), f.terminal('claude', process.pid), f.terminal('exited', process.pid, { code: 0 }));
  assert.deepEqual(JSON.parse(JSON.stringify(await f.claudeTerminalSessions())), [{ id, cwd: f.workspace }]);
  f.terminals.splice(1, 2, f.terminal('bash', process.ppid));
  assert.deepEqual(JSON.parse(JSON.stringify(await f.claudeTerminalSessions())), [{ id, cwd: f.workspace }]);

  // A record whose pid now belongs to another process, or of a non-interactive run, is no session.
  f.live(id, process.pid, '1');
  assert.deepEqual(Array.from(await f.claudeTerminalSessions()), []);
  const sessions = path.join(f.env.HOME, '.claude', 'sessions', process.pid + '.json');
  fs.writeFileSync(sessions, JSON.stringify({ pid: process.pid, sessionId: id, cwd: f.workspace,
    procStart: procStart(process.pid), entrypoint: 'sdk-cli' }));
  assert.deepEqual(Array.from(await f.claudeTerminalSessions()), []);
});

test('the record keeps its order, adds new sessions last, and drops one after 30 seconds without its process', (t) => {
  const f = fixture(t);
  const ids = (record) => Array.from(record, (s) => s.id);
  const a = { id: 'a', cwd: '/w' }, b = { id: 'b', cwd: '/w' };
  const absent = new Map();
  let record = f.nextRestoreRecord([], [a, b], absent, 0);
  record = f.nextRestoreRecord(record, [b], absent, 1000);
  assert.deepEqual(ids(record), ['a', 'b'], 'a closing window keeps its sessions');
  assert.deepEqual(ids(f.nextRestoreRecord(record, [b], absent, 30999)), ['a', 'b']);
  record = f.nextRestoreRecord(record, [a, b], absent, 20000);
  record = f.nextRestoreRecord(record, [b], absent, 40000);
  assert.deepEqual(ids(f.nextRestoreRecord(record, [b], absent, 69999)), ['a', 'b'], 'a returning session restarts its grace period');
  assert.deepEqual(ids(f.nextRestoreRecord(record, [b], absent, 70000)), ['b']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.nextRestoreRecord([a, b], [{ id: 'c', cwd: '/w', index: 4 }, b], new Map(), 0))),
    [a, b, { id: 'c', cwd: '/w' }]);
});

test("the host's sessions are the Claude sessions in tmux in start order, then this window's others", async (t) => {
  const f = fixture(t);
  const [early, late, own] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'];
  const [pane1, pane2] = [f.child(), f.child()];
  f.live(late, pane1);
  f.live(early, pane2);
  f.live(own, process.pid);
  f.terminals.push(f.terminal('claude', process.pid));
  f.tmuxState([['claude-kylie', 200, 1, pane1], ['claude-kylie-2', 100, 0, pane2], ['claude-other', 50, 0, 999999999]]);
  const tmux = await f.claudeTmux();
  assert.deepEqual(JSON.parse(JSON.stringify(tmux.sessions.map((s) => s.name))), ['claude-kylie', 'claude-kylie-2', 'claude-other']);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.claudeSessions(tmux))).map((s) => s.id), [early, late, own]);
  assert.match(f.tmuxCalls()[0], /^-L claude list-panes -a -F .* ; list-clients -F /);

  fs.rmSync(f.tmux);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.claudeTmux())), { sessions: [], clients: [] }, 'no tmux');
});

test('the record is a file of the host, and only the first window that activates restores', (t) => {
  const f = fixture(t);
  assert.equal(f.readRestoreRecord(), null);
  f.writeRestoreRecord([{ id: 'a', cwd: '/w' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.readRestoreRecord())), [{ id: 'a', cwd: '/w' }]);
  const file = path.join(f.env.HOME, '.local', 'state', 'minion-hq', 'claude-sessions.json');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['claude-sessions.json']);

  assert.equal(f.claimRestore(), true);
  assert.equal(f.claimRestore(), false, 'another window of the host activates within 10 seconds');
  assert.equal(f.claimRestore(Date.now() + 11000), true, 'a later window restores again');
  fs.writeFileSync(file + '.lock', '999999999');
  assert.equal(f.claimRestore(), true, 'the extension host of the claim has ended');
});

test('recorded sessions are attached in tmux or resume in their folder, in record order, never twice', async (t) => {
  const f = fixture(t);
  const [gone, resumed, detached, shown, running] = ['11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
  f.session(resumed, null, f.repo);
  f.session(running, null);
  f.live(running, process.pid);
  const [pane1, pane2] = [f.child(), f.child()];
  f.live(detached, pane1);
  f.live(shown, pane2);
  f.tmuxState([['claude-kylie', 300, 0, pane1], ['claude-kylie-2', 200, 1, pane2], ['claude-other', 100, 0, 999999999]]);
  f.restoreClaudeSessions([
    { id: gone, cwd: f.workspace },
    { id: resumed, cwd: f.repo },
    { id: detached, cwd: f.workspace },
    { id: shown, cwd: f.workspace },
    { id: running, cwd: f.workspace },
  ], await f.claudeTmux());
  const attach = (name) => ({ shellPath: f.tmux, shellArgs: ['-L', 'claude', 'attach-session', '-t', '=' + name] });
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [
    { cwd: f.repo, shellPath: '/bin/bash', shellArgs: ['-ic', `claude --resume ${resumed}`] },
    attach('claude-kylie'),
    attach('claude-other'),
  ]);
  assert.deepEqual(f.shown, [], 'restored terminals take no focus');
  assert.deepEqual(f.logged, [
    `claude restore: ${gone} not resumed, its transcript is gone`,
    `claude restore: resumed ${resumed} in ${f.repo}`,
    'claude restore: attached claude-kylie',
    `claude restore: ${shown} not resumed, it runs already`,
    `claude restore: ${running} not resumed, it runs already`,
    'claude restore: attached claude-other',
  ]);
  f.logged.length = 0;
  f.restoreClaudeSessions([], { sessions: [], clients: [] });
  assert.deepEqual(f.logged, ['claude restore: nothing recorded']);
});

test('the restoring window opens bash local and bash prd first, once each', (t) => {
  const f = fixture(t);
  f.openShellTerminals();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ name: 'bash local' }, { name: 'bash prd' }]);
  assert.deepEqual(f.sent, ['bash prd: ssh prd']);
  assert.deepEqual(f.shown, ['bash local (no focus)'], 'the local shell shows the panel without focus');
  assert.deepEqual(f.logged, ['shell restore: opened bash local', 'shell restore: opened bash prd']);
  f.created.length = 0;
  f.terminals.push(f.terminal('bash prd'));
  f.openShellTerminals();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ name: 'bash local' }], 'a reconnected shell is kept');
});

test('closing a terminal yourself ends the tmux session it shows; a closing window does not', async (t) => {
  const f = fixture(t);
  const client = f.child();
  const mine = f.terminal('tmux', client), other = f.terminal('bash', 1);
  f.terminals.push(mine, other);
  f.tmuxState([['claude-kylie', 100, 1, 999999999]], [['claude-kylie', client]]);
  await f.mapTmuxTerminals(await f.claudeTmux());
  const calls = f.tmuxCalls().length;
  mine.exitStatus = { code: undefined, reason: 1 };
  f.closeClaudeTmux(mine);
  other.exitStatus = { code: undefined, reason: 3 };
  f.closeClaudeTmux(other);
  mine.exitStatus = { code: undefined, reason: 3 };
  f.closeClaudeTmux(mine);
  for (let i = 0; i < 40 && f.tmuxCalls().length === calls; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(f.tmuxCalls().slice(calls), ['-L claude kill-session -t =claude-kylie']);
  assert.deepEqual(f.logged, ['claude tmux: ended claude-kylie, its terminal was closed']);
});

test('a terminal that came back from an earlier window shows its session in a new terminal, once', async (t) => {
  const f = fixture(t);
  // The test runner started before this process, which stands in for the extension host.
  const old = process.ppid, young = f.child();
  const back = f.terminal('tmux', old), fresh = f.terminal('tmux', young);
  f.terminals.push(back, fresh);
  f.tmuxState([['claude-kylie', 100, 1, 999999999], ['claude-kylie-2', 101, 1, 999999998]],
    [['claude-kylie', old, '/dev/pts/9'], ['claude-kylie-2', young, '/dev/pts/10']]);
  await f.mapTmuxTerminals(await f.claudeTmux());
  await f.mapTmuxTerminals(await f.claudeTmux());
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)),
    [{ shellPath: f.tmux, shellArgs: ['-L', 'claude', 'attach-session', '-t', '=claude-kylie'] }]);
  assert.deepEqual(f.shown, [], 'no terminal takes focus');
  const detached = () => f.tmuxCalls().filter((c) => c.includes('detach-client'));
  for (let i = 0; i < 40 && !detached().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(detached(), ['-L claude detach-client -t /dev/pts/9']);
  assert.deepEqual(f.logged, ['claude tmux: attached claude-kylie again, its terminal came back from an earlier window']);
});

test('a terminal that opens or starts a command is scanned each second for 15 seconds', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  let scans = 0;
  const watch = f.claudeSessionWatch(() => scans++);
  watch.start();
  t.mock.timers.tick(3000);
  assert.equal(scans, 3);
  watch.start();
  t.mock.timers.tick(15000);
  assert.equal(scans, 18, 'a second start extends the watch on the same timer');
  t.mock.timers.tick(10000);
  assert.equal(scans, 18, 'the watch ends');
  watch.start();
  t.mock.timers.tick(1000);
  assert.equal(scans, 19);
  watch.dispose();
  t.mock.timers.tick(5000);
  assert.equal(scans, 19);
});

test('a new background session of the workspace opens once in a focused attach terminal', (t) => {
  const f = fixture(t);
  const record = (pid, fields) => fs.writeFileSync(path.join(f.sessions, pid + '.json'), JSON.stringify({
    pid, procStart: procStart(process.pid), entrypoint: 'cli', cwd: f.workspace, startedAt: 2000, ...fields }));
  record(process.pid, { kind: 'bg', sessionId: '3fc61690-94a5-4734-aecc-85db7e5b042d', jobId: '3fc61690' });
  record(1, { kind: 'bg', sessionId: 'aaaaaaaa-0000-4000-8000-000000000000' }); // another process start
  record(process.ppid, { kind: 'interactive', sessionId: 'bbbbbbbb-0000-4000-8000-000000000000' });
  const attached = new Set();
  f.attachBackgroundSessions(attached, 3000);
  assert.deepEqual(f.created, [], 'a session started before the window activated stays detached');
  f.attachBackgroundSessions(attached, 1000);
  f.attachBackgroundSessions(attached, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [
    { cwd: f.workspace, shellPath: f.claude, shellArgs: ['attach', '3fc61690'] },
  ]);
  assert.deepEqual(f.shown, ['claude']);
  assert.deepEqual(f.logged, [`claude attach: opened 3fc61690 in ${f.workspace}`]);
});
