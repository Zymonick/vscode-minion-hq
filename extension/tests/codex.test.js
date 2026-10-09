const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const id = (n) => '11111111-1111-7111-8111-' + String(n).padStart(12, '0');
const titleArgs = ['-c', 'tui.terminal_title=["app-name","status","thread","project"]'];
const connectionArgs = ['--remote', 'unix://', '--approve-for-me', ...titleArgs];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'kylie');
  const repo = path.join(root, 'kylie-worktrees', 'pr-7');
  const state = path.join(root, 'kylie-worktrees', '.ci');
  const titles = path.join(state, 'session-titles');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  for (const dir of [repo, workspace, titles, home, bin]) fs.mkdirSync(dir, { recursive: true });
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, '#!/bin/sh\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: bin, CODEX_HOME: '', CODEX_SQLITE_HOME: '' };
  let age = 0;
  const session = (n, { title = 'pr-7: resume prompt session', cwd = workspace, source = 'cli', runtime } = {}) => {
    if (title !== null) fs.writeFileSync(path.join(titles, id(n)), title);
    if (runtime) {
      fs.mkdirSync(path.join(state, 'codex-runtimes'), { recursive: true });
      fs.writeFileSync(path.join(state, 'codex-runtimes', id(n)), JSON.stringify(runtime));
    }
    if (cwd === null) return;
    const dir = path.join(runtime?.CODEX_HOME || env.CODEX_HOME || path.join(home, '.codex'), 'sessions', '2026', '10', '08');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-10-08T12-00-00-' + id(n) + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: id(n), cwd, source } }) + '\n');
    const when = new Date(Date.UTC(2026, 9, 8) + 60000 * ++age);
    fs.utimesSync(file, when, when);
    return file;
  };

  // Process fixtures isolate liveness checks from real user sessions.
  const processes = new Map();
  const procFs = { ...fs,
    readdirSync(file, ...args) {
      if (file === '/proc') return [...processes.keys()].map(String);
      const match = file.match(/^\/proc\/(\d+)\/fd$/);
      if (match) return Object.keys(processes.get(+match[1]).fds || {});
      return fs.readdirSync(file, ...args);
    },
    readFileSync(file, ...args) {
      const match = file.match(/^\/proc\/(\d+)\/(cmdline|stat)$/);
      if (!match) return fs.readFileSync(file, ...args);
      const proc = processes.get(+match[1]);
      if (!proc) throw new Error('Process exited');
      if (match[2] === 'cmdline') return Buffer.from(proc.args.join('\0') + '\0');
      return Buffer.from(`${match[1]} (codex) S ${proc.ppid || 1} ` + Array(18).fill('0').join(' '));
    },
    readlinkSync(file, ...args) {
      const match = file.match(/^\/proc\/(\d+)\/fd\/(\d+)$/);
      return match ? processes.get(+match[1]).fds[match[2]] : fs.readlinkSync(file, ...args);
    },
  };
  const created = [], shown = [], infos = [], errors = [], terminals = [], serverStarts = [];
  let serverError = null;
  const childProcess = { ...require('node:child_process'),
    execFile(executable, args, options, callback) {
      assert.deepEqual(Array.from(args), ['app-server', 'daemon', 'start']);
      serverStarts.push({ executable, options });
      callback(serverError, '', serverError ? serverError.message : '');
    },
  };
  const terminal = (name, pid, exitStatus) => ({ name, exitStatus, creationOptions: { name },
    processId: Promise.resolve(pid), show() { shown.push(this.name); } });
  const vscode = {
    window: {
      terminals,
      createTerminal(options) {
        created.push(options);
        const value = terminal(options.name || 'codex');
        value.creationOptions = options;
        terminals.push(value);
        return value;
      },
      createOutputChannel: () => ({ appendLine() {} }),
      showInformationMessage: async (message) => { infos.push(message); },
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }], getConfiguration: () => ({ get: () => '' }) },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout,
    process: Object.assign(Object.create(process), { env }),
    require: (name) => name === 'vscode' ? vscode : name === 'fs' ? procFs : name === 'child_process' ? childProcess : require(name),
  });
  const provider = new api.StatsViewProvider();
  provider.data.set(repo, { repoPath: repo, name: 'pr-7', pr: { serial: 7, status: 'wip' } });
  return { ...api, provider, root, repo, workspace, state, home, codex, env, session, terminal, processes,
    terminals, created, shown, infos, errors, serverStarts, failServer: (error) => { serverError = error; },
    click: () => provider.onMessage({ type: 'codex', repoPath: repo }) };
}

test('PR rows have separate Claude and Codex controls; Codex clicks do not toggle the row', (t) => {
  const f = fixture(t);
  const root = { innerHTML: '' }, posted = [];
  let receive, click, saved = 0;
  vm.runInNewContext(f.getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => { saved++; }, postMessage: (m) => posted.push(m) }),
    document: { getElementById: () => root, addEventListener: (type, handler) => { if (type === 'click') click = handler; } },
    window: { addEventListener: (type, handler) => { if (type === 'message') receive = handler; } },
  });
  const row = (repoPath, pr) => ({ repoPath, name: path.basename(repoPath), branch: path.basename(repoPath),
    totals: { add: 0, del: 0 }, staged: [], unstaged: [], untracked: [], commits: [], pr });
  const quoted = '/tmp/a "quoted" & <odd>/pr-8';
  receive({ data: { type: 'data', repos: [row(f.workspace, null), row(f.repo, { status: 'landed' }), row(quoted, { status: 'wip' })] } });
  const controls = [...root.innerHTML.matchAll(/<span class="codex" data-codex="([^"]*)" title="[^"]*"><svg[^>]*aria-label="Codex">.*?<\/svg><\/span>/g)];
  assert.deepEqual(controls.map((m) => m[1]), [f.repo, '/tmp/a &quot;quoted&quot; &amp; &lt;odd&gt;/pr-8']);
  assert.equal([...root.innerHTML.matchAll(/class="claude"/g)].length, 2);
  posted.length = 0;
  click({ target: { closest: (selector) => selector === '.codex' ? { dataset: { codex: quoted } } : null } });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'codex', repoPath: quoted }]);
  assert.equal(saved, 0);
});

test('the newest PR Codex session resumes in its original folder, excluding other agents and projects', async (t) => {
  const f = fixture(t);
  f.session(1);
  f.session(2, { title: 'PR-7: newest interactive session', cwd: f.repo, source: 'vscode' });
  f.session(3, { title: 'pr-70: another PR' });
  f.session(4, { cwd: '/another/project' });
  f.session(5, { source: 'exec' });
  f.session(6, { source: { subagent: { thread_spawn: {} } } });
  f.session(7, { title: null });
  f.session(8, { cwd: null }); // Claude association without a Codex rollout.
  const malformed = f.session(9);
  fs.writeFileSync(malformed, 'invalid\n');
  const mismatch = f.session(10);
  fs.writeFileSync(mismatch, JSON.stringify({ type: 'session_meta', payload: { id: id(99), cwd: f.repo, source: 'cli' } }) + '\n');
  const archived = f.session(11);
  fs.renameSync(archived, path.join(f.home, '.codex', 'archived-' + path.basename(archived)));
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ cwd: f.repo,
    shellPath: f.codex, shellArgs: ['resume', ...connectionArgs, id(2)],
    env: { MINION_HQ_CODEX_PR: f.repo, CODEX_HOME: path.join(f.home, '.codex'), CODEX_SQLITE_HOME: null } }]);
  assert.deepEqual(f.shown, ['codex']);
  assert.deepEqual(f.errors, []);

  f.terminals.length = 0;
  f.session(12);
  await f.click();
  assert.equal(f.created[1].cwd, f.workspace);
  assert.deepEqual(Array.from(f.created[1].shellArgs), ['resume', ...connectionArgs, id(12)]);
});

test('desktop sessions retain their recorded executable, CODEX_HOME and SQLite store', async (t) => {
  const f = fixture(t);
  const executable = path.join(f.root, 'desktop codex');
  fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  const runtime = { executable, CODEX_HOME: path.join(f.root, 'desktop home'), CODEX_SQLITE_HOME: path.join(f.root, 'sqlite') };
  f.session(1);
  f.session(2, { runtime, source: 'vscode' });
  await f.click();
  assert.equal(f.created[0].shellPath, executable);
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['resume', ...connectionArgs, id(2)]);
  assert.deepEqual({ ...f.created[0].env }, { MINION_HQ_CODEX_PR: f.repo, CODEX_HOME: runtime.CODEX_HOME, CODEX_SQLITE_HOME: runtime.CODEX_SQLITE_HOME });

  f.terminals.length = 0;
  fs.unlinkSync(executable);
  f.session(3, { runtime: { ...runtime, CODEX_SQLITE_HOME: null } });
  await f.click();
  assert.equal(f.created[1].shellPath, f.codex, 'an obsolete recorded binary falls back to the installed CLI');
  assert.equal(f.created[1].env.CODEX_SQLITE_HOME, null, 'do not inherit a different SQLite store');
});

test('CODEX_HOME is honored for sessions without recorded runtimes', async (t) => {
  const f = fixture(t);
  f.env.CODEX_HOME = path.join(f.root, 'custom codex');
  f.env.CODEX_SQLITE_HOME = path.join(f.root, 'custom sqlite');
  f.session(1);
  await f.click();
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['resume', ...connectionArgs, id(1)]);
  assert.deepEqual({ ...f.created[0].env }, { MINION_HQ_CODEX_PR: f.repo, CODEX_HOME: f.env.CODEX_HOME, CODEX_SQLITE_HOME: f.env.CODEX_SQLITE_HOME });
});

test('new Codex terminals accept live titles and remain attached to their PR after title changes', async (t) => {
  const f = fixture(t);
  f.session(1, { cwd: null });
  await Promise.all([f.click(), f.click()]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{ cwd: f.repo, shellPath: f.codex,
    env: { MINION_HQ_CODEX_PR: f.repo }, shellArgs: connectionArgs }]);
  const own = f.terminals[0];
  own.name = 'Codex Working pr-7';
  await f.click();
  own.name = 'Codex Idle pr-7';
  await f.click();
  own.name = 'Renamed terminal';
  await f.click();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.shown, ['codex', 'Codex Working pr-7', 'Codex Idle pr-7', 'Renamed terminal']);
  own.exitStatus = { code: 0 };
  await f.click();
  assert.equal(f.created.length, 2, 'an exited terminal can be reopened');
});

test('terminals from earlier releases are focused even after a manual rename', async (t) => {
  const f = fixture(t);
  const old = f.terminal('Codex pr-7', 42);
  old.name = 'My current work';
  f.terminals.push(old);
  await f.click();
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.shown, ['My current work']);
});

test('restored terminal ownership survives title changes and takes precedence over another PR name', async (t) => {
  const f = fixture(t);
  const other = f.terminal('Codex pr-7', 42);
  other.creationOptions = { env: { MINION_HQ_CODEX_PR: '/another/pr-8' } };
  const own = f.terminal('Any live title', 43);
  own.creationOptions = { env: { MINION_HQ_CODEX_PR: f.repo } };
  f.terminals.push(other, own);
  await f.click();
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.shown, ['Any live title']);
});

test('a Codex CLI in this window is focused; another window does not prevent resuming', async (t) => {
  const f = fixture(t);
  f.session(1);
  f.processes.set(42, { args: ['/bin/codex', 'resume', id(1)], ppid: 41 });
  f.terminals.push(f.terminal('bash', 41));
  await f.click();
  assert.deepEqual(f.shown, ['bash']);
  f.terminals.length = 0;
  await f.click();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.infos, []);
  assert.equal(f.serverStarts.length, 1);
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['resume', ...connectionArgs, id(1)]);
});

test('an open Codex rollout identifies a CLI session, while app servers and unrelated processes do not', async (t) => {
  const f = fixture(t);
  const file = f.session(1);
  f.processes.set(40, { args: ['/bin/codex', 'app-server'], fds: { 5: file } });
  f.processes.set(41, { args: ['/bin/editor', file], fds: { 5: file } });
  f.processes.set(42, { args: ['/bin/codex'], fds: { 5: file } });
  f.terminals.push(f.terminal('Existing CLI', 42));
  await f.click();
  assert.deepEqual(f.shown, ['Existing CLI']);
  assert.equal(f.created.length, 0);
  f.terminals.length = 0;
  f.processes.delete(42);
  await f.click();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.infos, []);
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['resume', ...connectionArgs, id(1)]);
});

test('unknown and non-PR rows do nothing; missing Codex is reported and ~/.local/bin is supported', async (t) => {
  const f = fixture(t);
  await f.provider.onMessage({ type: 'codex', repoPath: '/nowhere/pr-9' });
  f.provider.data.set(f.workspace, { repoPath: f.workspace, name: 'kylie', pr: null });
  await f.provider.onMessage({ type: 'codex', repoPath: f.workspace });
  assert.deepEqual(f.created, []);
  fs.unlinkSync(f.codex);
  await f.click();
  assert.deepEqual(f.errors, ['Could not open Codex for pr-7: the codex CLI is not on PATH or in ~/.local/bin']);
  const fallback = path.join(f.home, '.local', 'bin', 'codex');
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  fs.writeFileSync(fallback, '#!/bin/sh\n', { mode: 0o755 });
  await f.click();
  assert.equal(f.created[0].shellPath, fallback);
});

test('an open desktop session attaches through its shared server and recorded stores', async (t) => {
  const f = fixture(t);
  const runtime = { executable: f.codex, CODEX_HOME: path.join(f.root, 'desktop home'), CODEX_SQLITE_HOME: null };
  f.env.CODEX_SQLITE_HOME = path.join(f.root, 'unrelated store');
  const file = f.session(1, { runtime, source: 'vscode' });
  f.processes.set(40, { args: ['/bin/codex', 'app-server'], fds: { 5: file } });
  await f.click();
  assert.equal(f.created.length, 1);
  assert.deepEqual(Array.from(f.created[0].shellArgs), ['resume', ...connectionArgs, id(1)]);
  assert.equal(f.serverStarts.length, 1);
  assert.equal(f.serverStarts[0].executable, runtime.executable);
  assert.equal(f.serverStarts[0].options.cwd, f.workspace);
  assert.equal(f.serverStarts[0].options.env.CODEX_HOME, runtime.CODEX_HOME);
  assert.equal(Object.hasOwn(f.serverStarts[0].options.env, 'CODEX_SQLITE_HOME'), false);
  assert.deepEqual(f.errors, []);
});

test('server startup failure is reported without opening a terminal and the next click can retry', async (t) => {
  const f = fixture(t);
  f.session(1);
  f.failServer(new Error('Could not connect to the local server'));
  await f.click();
  assert.equal(f.created.length, 0);
  assert.match(f.errors[0], /Could not connect to the local server/);
  f.failServer(null);
  await f.click();
  assert.equal(f.serverStarts.length, 2);
  assert.equal(f.created.length, 1);
});
