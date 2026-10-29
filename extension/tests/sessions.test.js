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

// Kylie with two PR worktrees beside their .ci state, and a Claude home whose
// session records name live processes.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kylie = path.join(root, 'kylie');
  const pr7 = path.join(root, 'kylie-worktrees', 'pr-7');
  const pr8 = path.join(root, 'kylie-worktrees', 'pr-8');
  const titles = path.join(root, 'kylie-worktrees', '.ci', 'session-titles');
  const home = path.join(root, 'home');
  const sessions = path.join(home, '.claude', 'sessions');
  for (const dir of [kylie, pr7, pr8, titles, sessions]) fs.mkdirSync(dir, { recursive: true });
  const title = (id, text) => fs.writeFileSync(path.join(titles, id), text);
  const live = (sessionId, pid) => fs.writeFileSync(path.join(sessions, pid + '.json'),
    JSON.stringify({ pid, sessionId, cwd: kylie, procStart: procStart(pid), entrypoint: 'cli' }));

  const shown = [], updates = [];
  const settings = { 'terminal.integrated': {}, scmDiffStats: {} };
  const terminal = (name, { pid = 0, env, exitStatus } = {}) => ({ name, exitStatus,
    creationOptions: env ? { env } : {}, processId: Promise.resolve(pid), show() { shown.push(this.name); } });
  const vscode = {
    window: { terminals: [], createOutputChannel: () => ({ appendLine() {} }) },
    workspace: {
      getConfiguration: (section) => ({
        get: (key) => settings[section][key],
        inspect: (key) => ({ globalValue: settings[section][key] }),
        update: async (key, value, target) => {
          updates.push([section + '.' + key, value, target]);
          if (value === undefined) delete settings[section][key];
          else settings[section][key] = value;
        },
      }),
    },
    ConfigurationTarget: { Global: 1 },
  };
  const api = vm.runInNewContext(source
    + '\n({ StatsViewProvider, getHtml, claudeTitleRepo, titleMark, setSessions, syncTerminalTabs, sessionsEnabled });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    process: Object.assign(Object.create(process), { env: { ...process.env, HOME: home } }),
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  const provider = new api.StatsViewProvider();
  const pushed = [];
  provider.view = { webview: { postMessage: (m) => pushed.push(JSON.parse(JSON.stringify(m))) } };
  provider.data.set(kylie, { repoPath: kylie, name: 'kylie', pr: null });
  provider.data.set(pr7, { repoPath: pr7, name: 'pr-7', pr: { serial: 7, status: 'wip' } });
  provider.data.set(pr8, { repoPath: pr8, name: 'pr-8', pr: { serial: 8, status: 'wip' } });
  return { ...api, provider, kylie, pr7, pr8, title, live, terminal, terminals: vscode.window.terminals,
    shown, updates, settings, pushed };
}

function webview(getHtml) {
  const root = { innerHTML: '' }, posted = [];
  let receive, click;
  const script = getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (m) => posted.push(m) }),
    document: { getElementById: () => root, addEventListener: (type, handler) => { if (type === 'click') click = handler; } },
    window: { addEventListener: (type, handler) => { if (type === 'message') receive = handler; } },
  });
  return { root, posted, receive: (data) => receive({ data }), click: (target) => click({ target }) };
}

function row(repoPath, pr) {
  return { repoPath, name: path.basename(repoPath), branch: 'master', totals: { add: 0, del: 0 },
    staged: [], unstaged: [], untracked: [], commits: [], pr };
}

test('live title marks read spinner frames as one working mark', (t) => {
  const f = fixture(t);
  const marks = ['◑ pr-7: wip', '✳ pr-7: wip', '⠙ codex', '⏰ waits', 'azrael@host: ~/kylie', '[LOCAL] shell']
    .map((name) => JSON.parse(JSON.stringify(f.titleMark(name))));
  assert.deepEqual(marks, [
    { mark: '◐', title: 'pr-7: wip' }, { mark: '✳', title: 'pr-7: wip' }, { mark: '◐', title: 'codex' },
    { mark: '⏰', title: 'waits' }, { mark: '', title: 'azrael@host: ~/kylie' }, { mark: '', title: '[LOCAL] shell' },
  ]);
});

test("a Claude session belongs to the PR row its session title names", (t) => {
  const f = fixture(t);
  const repos = [f.kylie, f.pr7, f.pr8];
  f.title('a1', 'pr-7: clear review status');
  f.title('a2', 'pr-70: another pull request');
  f.title('a3', 'Invoice 12382 manual processing');
  assert.deepEqual(JSON.parse(JSON.stringify(f.claudeTitleRepo('a1', repos))), { repo: f.pr7, name: 'pr-7: clear review status' });
  assert.equal(f.claudeTitleRepo('a2', repos), null);
  assert.equal(f.claudeTitleRepo('a3', repos), null);
  assert.equal(f.claudeTitleRepo('../a1', repos), null);
  assert.equal(f.claudeTitleRepo('missing', repos), null);
});

test('with sessions on, PR Claude terminals attach to their rows and every other terminal lists apart', async (t) => {
  const f = fixture(t);
  f.title('s8', 'pr-8: ebill no finding');
  f.live('s8', process.pid);
  f.terminals.push(
    f.terminal('[LOCAL] shell'),
    f.terminal('✳ pr-7 wip clear review status', { env: { MINION_HQ_CLAUDE_PR: f.pr7 } }),
    f.terminal('◑ pr-8 wip ebill no finding', { pid: process.pid }),
    f.terminal('◐ pr-7 second terminal', { env: { MINION_HQ_CLAUDE_PR: f.pr7 } }),
    f.terminal('✳ closed', { exitStatus: { code: 0 } }),
    f.terminal('✳ Invoice 12382 manual processing'),
  );

  await f.provider.scanSessions();
  assert.equal(f.provider.sessions, null, 'off scans nothing');
  assert.deepEqual(f.pushed, []);

  f.provider.sessionsOn = true;
  await f.provider.scanSessions();
  const { sessions } = f.pushed.at(-1);
  assert.deepEqual(sessions.byRepo, {
    [f.pr7]: { id: 2, mark: '✳', title: 'pr-7 wip clear review status' },
    [f.pr8]: { id: 3, mark: '◐', title: 'pr-8 wip ebill no finding' },
  });
  assert.deepEqual(sessions.other, [
    { id: 1, mark: '', title: '[LOCAL] shell' },
    { id: 4, mark: '◐', title: 'pr-7 second terminal' },
    { id: 5, mark: '✳', title: 'Invoice 12382 manual processing' },
  ]);

  f.terminals[2].name = '◐ pr-8 wip ebill no finding';
  await f.provider.scanSessions();
  assert.equal(f.pushed.length, 1, 'a new spinner frame changes nothing');

  await f.provider.onMessage({ type: 'terminal', id: 5 });
  await f.provider.onMessage({ type: 'terminal', id: 99 });
  assert.deepEqual(f.shown, ['✳ Invoice 12382 manual processing']);
});

test('the view shows live marks on PR rows and other terminals below Kylie; clicks focus terminals', (t) => {
  const f = fixture(t);
  const v = webview(f.getHtml);
  const repos = [row(f.kylie, null), row(f.pr7, { serial: 7, status: 'wip' }), row(f.pr8, { serial: 8, status: 'wip' })];
  v.receive({ type: 'data', repos, sessions: {
    byRepo: { [f.pr7]: { id: 2, mark: '✳', title: 'pr-7 wip clear review status' } },
    other: [{ id: 6, mark: '◐', title: 'Invoice <12382>' }],
  } });
  const html = v.root.innerHTML;
  assert.match(html, /<span class="claude claude-live claude-idle" data-claude="[^"]*pr-7" data-terminal="2" title="Claude: focus the terminal pr-7 wip clear review status">✳<\/span>/);
  assert.match(html, /<span class="claude" data-claude="[^"]*pr-8" title="[^"]*">✻<\/span>/);
  const order = ['>kylie<', 'Invoice &lt;12382&gt;', '>pr-7<'].map((text) => html.indexOf(text));
  assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], 'other terminals follow the Kylie row');
  assert.match(html, /data-act="x\|6" title="Invoice &lt;12382&gt;"><span class="twist"><\/span><span class="name"><span class="term-mark term-working">◐<\/span>/);

  v.click({ closest: (selector) => selector === '.claude' ? { dataset: { claude: f.pr7, terminal: '2' } } : null });
  v.click({ closest: (selector) => selector === '.row' ? { dataset: { act: 'x|6' } } : null });
  assert.deepEqual(JSON.parse(JSON.stringify(v.posted.slice(1))), [{ type: 'terminal', id: 2 }, { type: 'terminal', id: 6 }]);

  v.receive({ type: 'data', repos });
  assert.doesNotMatch(v.root.innerHTML, /Invoice|claude-live/, 'off shows no terminal rows or live marks');
});

test('the toggle writes the user setting and hides the terminal tab list only while on', async (t) => {
  const f = fixture(t);
  assert.equal(f.sessionsEnabled(), false);
  await f.setSessions(true);
  assert.equal(f.sessionsEnabled(), true);
  await f.syncTerminalTabs(true);
  await f.syncTerminalTabs(true);
  await f.setSessions(false);
  await f.syncTerminalTabs(false);
  await f.syncTerminalTabs(false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.updates)), [
    ['scmDiffStats.sessions', true, 1],
    ['terminal.integrated.tabs.enabled', false, 1],
    ['scmDiffStats.sessions', false, 1],
    ['terminal.integrated.tabs.enabled', null, 1],
  ]);

  f.settings['terminal.integrated']['tabs.enabled'] = true;
  f.updates.length = 0;
  await f.syncTerminalTabs(false);
  assert.deepEqual(f.updates, [], 'off keeps a tab list the user enabled');
});
