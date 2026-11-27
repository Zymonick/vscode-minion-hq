const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

// The provider and its terminal list with a stub window, webview and interval
// timer.
function fixture() {
  const posted = [], shown = [], intervals = new Map();
  let nextTimer = 0;
  const terminal = (name, env) => ({ name, creationOptions: env ? { env } : {}, show() { shown.push(this.name); } });
  const vscode = {
    window: { terminals: [], activeTerminal: undefined, createOutputChannel: () => ({ appendLine() {} }) },
    commands: { executeCommand: async () => {} },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, TerminalList, terminalPr, getHtml });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, process,
    setInterval: (fn, ms) => { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval: (id) => intervals.delete(id),
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  const provider = new api.StatsViewProvider();
  provider.terminalList = new api.TerminalList();
  const pr = (serial) => ({ repoPath: '/w/pr-' + serial, name: 'pr-' + serial, pr: { serial } });
  for (const r of [{ repoPath: '/w/kylie', name: 'kylie', pr: null }, pr(7), pr(70)]) provider.data.set(r.repoPath, r);
  let visibility;
  const view = { visible: false, webview: { postMessage: (m) => posted.push(plain(m)) },
    onDidChangeVisibility: (listener) => { visibility = listener; return { dispose() {} }; } };
  provider.view = view;
  const show = (visible) => { view.visible = visible; visibility(); };
  return { ...api, provider, vscode, terminal, view, show, posted, shown, intervals };
}

test('a terminal belongs to the PR row whose control opened it, whose number its label starts with, or in whose worktree it runs', () => {
  const f = fixture();
  const w = f.vscode.window;
  w.terminals.push(
    f.terminal('bash local'),
    f.terminal('✳ pr-7 ci [wip] three words'),
    f.terminal('◐ PR-70 working'),
    f.terminal('claude', { MINION_HQ_CLAUDE_PR: '/w/pr-70' }),
    f.terminal('Claude pr-7'),
    f.terminal('✳ pr-9 a PR without a row'),
    f.terminal('notes about pr-7'));
  w.activeTerminal = w.terminals[2];
  assert.deepEqual(plain(f.provider.terminals()).map((t) => [t.name, t.repoPath, t.active]), [
    ['bash local', null, false],
    ['✳ pr-7 ci [wip] three words', '/w/pr-7', false],
    ['◐ PR-70 working', '/w/pr-70', true],
    ['claude', '/w/pr-70', false],
    ['Claude pr-7', '/w/pr-7', false],
    ['✳ pr-9 a PR without a row', null, false],
    ['notes about pr-7', null, false],
  ]);
  const keys = f.provider.terminals().map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(plain(f.provider.terminals().map((t) => t.key)), plain(keys), 'a terminal keeps its key');

  const prs = [...f.provider.data.values()].filter((r) => r.pr);
  const bash = f.terminal('bash');
  assert.equal(f.terminalPr(bash, { label: 'bash', cwd: '/w/pr-70/docs' }, prs), '/w/pr-70');
  assert.equal(f.terminalPr(bash, { label: 'bash', cwd: '/w/pr-7' }, prs), '/w/pr-7');
  assert.equal(f.terminalPr(bash, { label: 'bash', cwd: '/w/kylie' }, prs), null, 'a row without a PR gets no terminal');

  f.provider.onMessage({ type: 'terminal', key: keys[1] });
  f.provider.onMessage({ type: 'terminal', key: 'gone' });
  assert.deepEqual(f.shown, ['✳ pr-7 ci [wip] three words']);
  f.provider.onMessage({ type: 'terminalOrder', keys: [keys[2], 7, keys[0]] });
  assert.deepEqual([...f.provider.terminalList.order], [keys[2], keys[0]], 'the rows give the cycling order');
});

test('a visible view compares the terminals each second and posts only a change; a hidden one runs no timer', () => {
  const f = fixture();
  const a = f.terminal('◐ pr-7 working');
  f.vscode.window.terminals.push(a);
  f.provider.watchTerminals(f.view);
  assert.equal(f.intervals.size, 0, 'a hidden view must not poll');
  f.show(true);
  assert.deepEqual([...f.intervals.values()].map((i) => i.ms), [1000]);
  assert.equal(f.posted.length, 1);
  const tick = () => [...f.intervals.values()][0].fn();
  tick();
  assert.equal(f.posted.length, 1, 'unchanged terminals post nothing');
  a.name = '✳ pr-7 idle';
  tick();
  assert.deepEqual(f.posted.at(-1).terminals.map((t) => t.name), ['✳ pr-7 idle']);
  f.vscode.window.activeTerminal = a;
  f.provider.pushTerminals();
  assert.equal(f.posted.at(-1).terminals[0].active, true);
  f.show(false);
  assert.equal(f.intervals.size, 0, 'hiding the view stops its timer');
});

test('PR rows show their terminals, others come first under a terminals header, and clicks show a terminal', () => {
  const f = fixture();
  const root = { innerHTML: '' }, posted = [];
  let receive, click;
  const script = f.getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({ collapsed: {} }), setState() {}, postMessage: (m) => posted.push(m) }),
    document: { getElementById: () => root, addEventListener: (type, handler) => { if (type === 'click') click = handler; } },
    window: { addEventListener: (type, handler) => { if (type === 'message') receive = handler; } },
  });
  const row = (repoPath, pr) => ({ repoPath, name: path.basename(repoPath), branch: path.basename(repoPath),
    totals: { add: 0, del: 0 }, staged: [], unstaged: [], untracked: [], commits: [], pr });
  receive({ data: { type: 'data', repos: [row('/w/kylie', null), row('/w/pr-7', { serial: 7, status: 'wip' })], terminals: [
    { key: '1', name: 'bash local', repoPath: null, active: false },
    { key: '2', name: '✳ pr-7 idle', repoPath: '/w/pr-7', active: true },
    { key: '3', name: 'codex <b>', repoPath: '/w/pr-7', active: false },
    { key: '4', name: '✳ pr-9 gone', repoPath: '/w/pr-9', active: false },
  ] } });
  const html = root.innerHTML;
  assert.match(html, /^<div class="row grp" [^>]*data-act="t\|p\|~terminals\|0">.*terminals \(2\)/);
  assert.ok(html.indexOf('bash local') < html.indexOf('>kylie<'), 'terminals without a PR row come first');
  assert.match(html, /data-act="x\|4"><span class="twist"><\/span><span class="name">✳ pr-9 gone/);
  assert.match(html, /<div class="row hdr term-on" [^>]*data-act="t\|r\|\/w\/pr-7\|1">/);
  assert.match(html, /<span class="term term-on" data-term="2" title="✳ pr-7 idle">✳<\/span><span class="term" data-term="3" title="codex &lt;b&gt;">›_<\/span><span class="claude"/);
  assert.deepEqual(plain(posted.filter((m) => m.type === 'terminalOrder')), [{ type: 'terminalOrder', keys: ['1', '4', '2', '3'] }],
    'the cycling order is the order of the rows');

  click({ target: { closest: (selector) => selector === '.term' ? { dataset: { term: '3' } } : null } });
  click({ target: { closest: (selector) => selector === '.row' ? { dataset: { act: 'x|1' } } : null } });
  assert.deepEqual(plain(posted.filter((m) => m.type === 'terminal')), [{ type: 'terminal', key: '3' }, { type: 'terminal', key: '1' }]);

  receive({ data: { type: 'terminals', terminals: [{ key: '1', name: 'bash local', repoPath: null, active: true }] } });
  assert.match(root.innerHTML, /<div class="row  term-on" [^>]*data-act="x\|1">/);
  assert.doesNotMatch(root.innerHTML, /class="term/);
});
