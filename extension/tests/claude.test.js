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
    fs.writeFileSync(transcript, `{"type":"mode"}\n${JSON.stringify({ cwd })}\n`);
    const when = new Date(Date.UTC(2026, 9, 1) + 60000 * ++age);
    fs.utimesSync(transcript, when, when);
  };
  // Claude's record of a live session, as ~/.claude/sessions/<pid>.json holds it.
  const live = (sessionId, pid, start = procStart(pid)) => fs.writeFileSync(path.join(sessions, pid + '.json'),
    JSON.stringify({ pid, sessionId, cwd: workspace, procStart: start, entrypoint: 'cli' }));

  const created = [], shown = [], infos = [], errors = [], logged = [], openListeners = [];
  const sent = [], disposed = [], made = [];
  const terminal = (name, pid, exitStatus) => ({ name, exitStatus, creationOptions: { name },
    processId: Promise.resolve(pid), show(preserveFocus) { shown.push(this.name + (pid ? ' @' + pid : '') + (preserveFocus ? ' (no focus)' : '')); },
    sendText(text) { sent.push(`${this.name}: ${text}`); }, dispose() { disposed.push(this); } });
  const vscode = {
    window: {
      terminals: [],
      createTerminal: (options) => {
        created.push(options);
        const value = terminal(options.name || 'claude');
        value.creationOptions = options;
        made.push(value);
        return value;
      },
      createOutputChannel: () => ({ appendLine: (line) => logged.push(line) }),
      onDidOpenTerminal: (listener) => {
        openListeners.push(listener);
        return { dispose: () => openListeners.splice(openListeners.indexOf(listener), 1) };
      },
      showInformationMessage: async (message) => { infos.push(message); },
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }], getConfiguration: () => ({ get: () => '' }) },
    TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  };
  const env = { ...process.env, HOME: home, PATH: bin };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml, claudeTerminalSessions, claudeSessions, nextRestoreRecord, restoreClaudeSessions, markedTmuxSessions, terminalsSettled, openShellTerminals, claudeSessionWatch, attachBackgroundSessions, closeLeftAttachTerminals, claudeTmux, claimRestore, readRestoreRecord, writeRestoreRecord, mapTmuxTerminals, closeClaudeTmux });', {
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
  const child = (env = { PATH: process.env.PATH }) => {
    const proc = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore', env });
    t.after(() => proc.kill());
    return proc.pid;
  };
  // The options of a terminal that attaches the claude tmux session name and waits in its folder.
  const attach = (name) => ({ cwd: path.join(home, '.local', 'state', 'claude-tmux', name), shellPath: tmux,
    shellArgs: ['-L', 'claude', 'attach-session', '-t', '=' + name] });
  return { ...api, provider, repo, workspace, claude, tmux, env, sessions, session, live, terminal, attach,
    tmuxState, tmuxCalls, child, openListeners, terminals: vscode.window.terminals, created, made, shown, sent, disposed, infos, errors, logged,
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
  assert.deepEqual(controls.map((m) => m[1]), ['/tmp/a &quot;quoted&quot; &amp; &lt;odd&gt;/pr-8', f.repo], 'a landed row follows under landed');
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
  f.session('44444444-4444-4444-8444-444444444444', 'pr-7: elsewhere', '/home/someone/other-repo');
  f.session('22222222-2222-4222-8222-222222222222', 'PR-7: clear review status', f.repo);
  f.session('33333333-3333-4333-8333-333333333333', 'pr-70: another pull request');
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

  // A session that started in another folder, such as a Remote Control service's, belongs to the PR as well.
  f.created.length = 0;
  f.session('88888888-8888-4888-8888-888888888888', 'pr-7: rename without pr', '/home/someone/other-repo');
  await f.click();
  assert.equal(f.created[0].cwd, '/home/someone/other-repo');
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['-ic', 'claude --resume 88888888-8888-4888-8888-888888888888 continue']);
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
  const outside = f.child(); // a claude outside every terminal and tmux pane
  fs.rmSync(path.join(f.sessions, process.pid + '.json'));
  f.live(id, outside);
  await f.click();
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.infos, [`The Claude session for pr-7 is already running outside this window's terminals (pid ${outside}).`]);

  // A record whose pid now belongs to another process is stale.
  fs.rmSync(path.join(f.sessions, outside + '.json'));
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
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [f.attach('claude-pr-7')]);
  assert.deepEqual(f.infos, []);
});

test('a PR session on another tmux server is attached in a terminal of the PR', async (t) => {
  const f = fixture(t);
  const id = '11111111-1111-4111-8111-111111111111';
  f.session(id, 'pr-7: rename without pr', '/home/someone/business-operations');
  const service = f.child({ PATH: process.env.PATH, TMUX: '/tmp/tmux-1000/default,2025,0', TMUX_PANE: '%0' });
  f.live(id, service);
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ cwd: f.repo, env: { MINION_HQ_CLAUDE_PR: f.repo },
    shellPath: f.tmux, shellArgs: ['-S', '/tmp/tmux-1000/default', 'attach-session', '-t', '%0'] }]);
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

test("a terminal that attaches a tmux session shows that session's Claude, in terminal order", async (t) => {
  const f = fixture(t);
  const [inTmux, own] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const [pane, client, alone] = [f.child(), f.child(), f.child()];
  f.live(inTmux, pane);
  f.live(own, alone);
  f.terminals.push(f.terminal('tmux', client), f.terminal('claude', alone));
  f.tmuxState([['claude-kylie', 100, 1, pane]], [['claude-kylie', client]]);
  const tmux = await f.claudeTmux();
  await f.mapTmuxTerminals(tmux);
  const ids = async () => JSON.parse(JSON.stringify(await f.claudeTerminalSessions(tmux))).map((s) => s.id);
  assert.deepEqual(await ids(), [inTmux, own]);
  f.terminals.reverse();
  assert.deepEqual(await ids(), [own, inTmux]);
  assert.deepEqual(f.created, [], 'a client that started after the extension host keeps its terminal');
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

test("the sessions that this window's terminals show take their record places in terminal order", (t) => {
  const f = fixture(t);
  const ids = (record) => Array.from(record, (s) => s.id);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => ({ id, cwd: '/w' }));
  assert.deepEqual(ids(f.nextRestoreRecord([a, b, c], [a, b, c], new Map(), 0, [c, a])), ['c', 'b', 'a'],
    'a session that another window shows keeps its place');
  assert.deepEqual(ids(f.nextRestoreRecord([a, b, c], [a, c], new Map(), 0, [c, a])), ['c', 'b', 'a'],
    'a session without its process keeps its place');
  assert.deepEqual(ids(f.nextRestoreRecord([a, b], [a, b, d], new Map(), 0, [d, a, b])), ['d', 'a', 'b'],
    'a new session in an earlier terminal comes before the sessions of later terminals');
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
  assert.deepEqual(JSON.parse(JSON.stringify(f.claudeSessions(tmux, await f.claudeTerminalSessions(tmux)))).map((s) => s.id),
    [early, late, own]);
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
  const attach = f.attach;
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

test('a restored session whose last turn did not finish resumes with continue', (t) => {
  const f = fixture(t);
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  const assistant = (stop_reason, content, extra = {}) => ({ type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason, content }, ...extra });
  const text = (value) => ({ type: 'text', text: value });
  const tool = (name) => ({ type: 'tool_use', id: 'toolu_1', name, input: {} });
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' };
  const title = { type: 'custom-title', customTitle: 'pr-7 [wip] title' };
  const transcripts = {
    'a tool result waits for the reply': [user('go'), assistant('tool_use', [tool('Bash')]), user([result]), title],
    'a resume without a prompt added its note': [user('go'), assistant('tool_use', [tool('Bash')]), user([result]),
      { type: 'assistant', message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [text('No response requested.')] } },
      { type: 'system', content: 'hook' }],
    'a tool runs': [user('go'), assistant('tool_use', [text('Running.'), tool('Bash')])],
    'a prompt waits for the reply': [assistant('end_turn', [text('Done.')]), user('next step')],
    'a long entry follows the prompt': [user('go'), { type: 'file-history-snapshot', snapshot: 'x'.repeat(300000) }],
    'the reply ended the turn': [user('go'), assistant('end_turn', [text('Done.')]), title],
    'a question waits for the user': [user('go'), assistant('tool_use', [tool('AskUserQuestion')])],
    'the user interrupted': [user('go'), assistant('tool_use', [tool('Bash')]),
      user([result, text('[Request interrupted by user for tool use]')])],
    'an idle compaction': [user('summary', { isCompactSummary: true })],
    'a local command': [user('<local-command-caveat>caveat</local-command-caveat>', { isMeta: true }),
      user('<command-name>/screenshot</command-name>')],
    'a subagent wrote last': [assistant('end_turn', [text('Done.')]), user('task', { isSidechain: true })],
  };
  const project = path.join(f.env.HOME, '.claude', 'projects', f.workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  const recorded = Object.entries(transcripts).map(([name, lines], i) => {
    const id = `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
    f.session(id, null);
    fs.writeFileSync(path.join(project, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return { id, cwd: f.workspace, name };
  });
  f.restoreClaudeSessions(recorded, { sessions: [], clients: [] });
  const resumed = f.created.map((c) => c.shellArgs[1]);
  assert.deepEqual(resumed, recorded.map(({ id }, i) => `claude --resume ${id}${i < 5 ? ' continue' : ''}`),
    recorded.map(({ name }) => name).join('; '));
  assert.equal(f.logged[0], `claude restore: resumed ${recorded[0].id} in ${f.workspace} with continue, its last turn did not finish`);
  assert.equal(f.logged[5], `claude restore: resumed ${recorded[5].id} in ${f.workspace}`);
});

test('the restore waits until no terminal has opened for a while, or until its limit', async (t) => {
  const f = fixture(t);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let start = Date.now();
  const quiet = f.terminalsSettled(150, 2000);
  await sleep(100);
  f.openListeners.forEach((l) => l());
  await quiet;
  assert.ok(Date.now() - start >= 240, 'a terminal that opens starts the quiet time again');
  assert.equal(f.openListeners.length, 0, 'the wait stops to listen');
  start = Date.now();
  const busy = f.terminalsSettled(150, 400);
  const opening = setInterval(() => f.openListeners.forEach((l) => l()), 50);
  await busy;
  clearInterval(opening);
  assert.ok(Date.now() - start < 550, 'the limit ends the wait while terminals keep opening');
});

test('a session whose folder a restored terminal waits in is neither attached nor resumed', async (t) => {
  const f = fixture(t);
  const [held, free] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const [pane1, pane2] = [f.child(), f.child()];
  f.live(held, pane1);
  f.live(free, pane2);
  f.tmuxState([['claude-kylie', 100, 0, pane1], ['claude-kylie-2', 200, 0, pane2], ['claude-kylie-3', 300, 0, 999999999]]);
  // A process that waits in the session's folder stands in for the shell of a terminal that VS Code restored.
  const mark = path.join(f.env.HOME, '.local', 'state', 'claude-tmux', 'claude-kylie');
  fs.mkdirSync(mark, { recursive: true });
  const shell = require('node:child_process').spawn('sleep', ['30'], { cwd: mark, stdio: 'ignore' });
  t.after(() => shell.kill());
  f.terminals.push(f.terminal('bash', shell.pid), f.terminal('bash', 0));
  const marked = await f.markedTmuxSessions();
  assert.deepEqual([...marked], ['claude-kylie']);
  f.restoreClaudeSessions([{ id: held, cwd: f.workspace }, { id: free, cwd: f.workspace }], await f.claudeTmux(), marked);
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [f.attach('claude-kylie-2'), f.attach('claude-kylie-3')]);
  assert.deepEqual(fs.readdirSync(path.dirname(mark)).sort(), ['claude-kylie', 'claude-kylie-2', 'claude-kylie-3'],
    'each attached terminal waits in the folder of its session');
});

test('the restoring window opens bash local and bash prd first, once each', (t) => {
  const f = fixture(t);
  f.openShellTerminals(10, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ name: 'bash local' },
    { name: 'bash prd', shellPath: '/bin/bash', shellArgs: ['-ic', 'ssh prd; exec bash'] }]);
  assert.deepEqual(f.sent, [], 'the prd shell starts ssh itself, also when VS Code restores it');
  assert.deepEqual(f.shown, ['bash local (no focus)'], 'the local shell shows the panel without focus');
  assert.deepEqual(f.logged, ['shell restore: opened bash local', 'shell restore: opened bash prd']);
  f.created.length = 0;
  f.terminals.push(f.terminal('bash prd'));
  f.openShellTerminals(10, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ name: 'bash local' }], 'a reconnected shell is kept');
});

test('a shell that VS Code reconnects after the restore closes the new shell of its name', async (t) => {
  const f = fixture(t);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  f.openShellTerminals(1000, 5);
  f.terminals.push(...f.made, f.terminal('claude'));
  await tick();
  assert.deepEqual(f.disposed, [], 'the new shells and another terminal close nothing');
  const earlier = f.terminal('');
  f.terminals.push(earlier);
  await tick();
  assert.deepEqual(f.disposed, [], 'VS Code opens a reconnected shell without its name');
  earlier.name = 'bash prd';
  await tick();
  assert.equal(f.disposed.length, 1);
  assert.notEqual(f.disposed[0], earlier, 'the reconnected shell stays');
  assert.equal(f.disposed[0].creationOptions.shellPath, '/bin/bash', 'the new prd shell closes');
  assert.equal(f.logged.at(-1), 'shell restore: closed the new bash prd, VS Code reconnected the earlier one');
  f.terminals.splice(f.terminals.indexOf(f.disposed[0]), 1);
  f.terminals.push(f.terminal('bash prd'));
  await tick();
  assert.equal(f.disposed.length, 1, 'a later shell of the same name closes nothing more');
  f.terminals.push(f.terminal('bash local'));
  await tick();
  assert.equal(f.disposed.length, 2);
  assert.equal(f.disposed[1].creationOptions.name, 'bash local', 'the new local shell closes');

  const g = fixture(t);
  g.openShellTerminals(20, 5);
  await new Promise((resolve) => setTimeout(resolve, 60));
  g.terminals.push(g.terminal('bash local'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(g.disposed, [], 'the watch ends after its time');
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
  // This process stands in for the extension host. Its oldest ancestor below init started long
  // before it; the test runner a moment before it, as a terminal that VS Code restores at the window start.
  const field = (pid, i) => { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[i]; };
  let old = process.ppid;
  while (field(old, 1) > 1) old = field(old, 1);
  if (field(process.pid, 19) - field(old, 19) < 3100) return t.skip('no process started 31 seconds before this one');
  const restored = process.ppid, young = f.child();
  f.terminals.push(f.terminal('tmux', old), f.terminal('tmux', restored), f.terminal('tmux', young));
  f.tmuxState([['claude-kylie', 100, 1, 999999999], ['claude-kylie-2', 101, 1, 999999998], ['claude-kylie-3', 102, 1, 999999997]],
    [['claude-kylie', old, '/dev/pts/9'], ['claude-kylie-2', restored, '/dev/pts/10'], ['claude-kylie-3', young, '/dev/pts/11']]);
  await f.mapTmuxTerminals(await f.claudeTmux());
  await f.mapTmuxTerminals(await f.claudeTmux());
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [f.attach('claude-kylie')]);
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

test('a new /fork-pr background session of the workspace opens once in a focused attach terminal', (t) => {
  const f = fixture(t);
  const record = (pid, fields) => fs.writeFileSync(path.join(f.sessions, pid + '.json'), JSON.stringify({
    pid, procStart: procStart(process.pid), entrypoint: 'cli', cwd: f.workspace, startedAt: 2000, ...fields }));
  record(process.pid, { kind: 'bg', sessionId: '3fc61690-94a5-4734-aecc-85db7e5b042d', jobId: '3fc61690',
    name: 'fix the till (Branch)' });
  record(1, { kind: 'bg', sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'x (Branch)' }); // another process start
  record(process.ppid, { kind: 'interactive', sessionId: 'bbbbbbbb-0000-4000-8000-000000000000' });
  // Simon moved this session to the background, or started it in `claude agents`.
  const own = spawnChild(t, 'attach');
  record(own.pid, { kind: 'bg', sessionId: 'cccccccc-0000-4000-8000-000000000000', procStart: procStart(own.pid),
    name: 'pr-1357 invoice [landed] bank proposal details' });
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

// A process whose command line is `<node> <word>`, as `claude attach <id>` turns
// into `claude agents` when Simon types /exit or ←.
function spawnChild(t, word) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-child-'));
  fs.writeFileSync(path.join(dir, word), 'setTimeout(() => {}, 60000);\n');
  const child = require('node:child_process').spawn(process.execPath, [word], { cwd: dir, stdio: 'ignore' });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  return child;
}

test('an attach terminal closes when its view leaves the session for the agent view', async (t) => {
  const f = fixture(t);
  const record = (pid, id) => fs.writeFileSync(path.join(f.sessions, pid + '.json'), JSON.stringify({
    pid, procStart: procStart(pid), entrypoint: 'cli', cwd: f.workspace, startedAt: 2000, kind: 'bg',
    sessionId: id + '-0000-4000-8000-000000000000', jobId: id, name: id + ' (Branch)' }));
  const viewing = spawnChild(t, 'attach'), left = spawnChild(t, 'agents');
  await Promise.all([viewing, left].map((c) => new Promise((resolve) => c.once('spawn', resolve))));
  record(viewing.pid, '11111111');
  record(left.pid, '22222222');
  f.attachBackgroundSessions(new Set(), 1000);
  assert.equal(f.made.length, 2);
  const byJob = (job) => f.made.find((m) => m.creationOptions.shellArgs[1] === job);
  byJob('11111111').processId = Promise.resolve(viewing.pid);
  byJob('22222222').processId = Promise.resolve(left.pid);
  await f.closeLeftAttachTerminals();
  await f.closeLeftAttachTerminals();
  assert.deepEqual(f.disposed, [byJob('22222222')], 'only the terminal that shows the agent view closes');
  assert.ok(f.logged.includes('claude attach: closed 22222222, its terminal left the session'));
});
