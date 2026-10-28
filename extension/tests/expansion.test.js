const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function view() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const { getHtml, StatsViewProvider } = vm.runInNewContext(source + '\n({ getHtml, StatsViewProvider });', {
    module: { exports: {} }, process, Buffer,
    require: (name) => name === 'vscode' ? {
      window: { createOutputChannel: () => ({}) },
    } : require(name),
  });
  const root = { innerHTML: '' };
  const messages = [];
  const events = {};
  let receive, saved;
  const script = getHtml('test').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({
      getState: () => ({ collapsed: {}, drafts: { '/a': 'unfinished message' } }),
      setState: (state) => { saved = JSON.parse(JSON.stringify(state)); },
      postMessage: (message) => messages.push(message),
    }),
    document: { getElementById: () => root, addEventListener: (name, fn) => { events[name] = fn; } },
    window: { addEventListener: (event, handler) => { receive = handler; } },
    setTimeout,
  });
  const send = (data) => receive({ data });
  const provider = new StatsViewProvider();
  provider.view = { webview: { postMessage: send } };
  return { root, messages, events, send, provider, saved: () => saved };
}

function repo(repoPath) {
  const file = { path: 'working.txt', add: 1, del: 0 };
  return {
    repoPath, name: repoPath, branch: 'pr-1', totals: { add: 1, del: 0 },
    staged: [file], unstaged: [file], untracked: [],
    vsMaster: { files: [file], totals: { add: 1, del: 0 } },
    commitsLabel: 'Commits',
    commits: [{ hash: 'abc', short: 'abc', subject: 'A commit', when: 'today' }],
  };
}

test('pending repositories add no loading message above shown rows', () => {
  const v = view();
  v.send({ type: 'data', repos: [], loading: true });
  assert.match(v.root.innerHTML, /Loading repositories/);
  v.send({ type: 'data', repos: [repo('/a')], loading: true });
  assert.doesNotMatch(v.root.innerHTML, /Loading/);
});

test('title actions collapse and expand every level while preserving drafts and loaded files', () => {
  const v = view();
  v.send({ type: 'data', repos: [repo('/a'), repo('/b')] });
  v.provider.setExpansion('collapse');
  assert.doesNotMatch(v.root.innerHTML, /working.txt|A commit/);
  assert.ok(Object.values(v.saved().collapsed).every((value) => value === true));
  assert.equal(v.saved().drafts['/a'], 'unfinished message');

  v.provider.setExpansion('expand');
  assert.match(v.root.innerHTML, /working.txt/);
  assert.match(v.root.innerHTML, /A commit/);
  assert.ok(Object.values(v.saved().collapsed).every((value) => value === false));
  assert.equal(v.messages.filter((m) => m.type === 'expandCommit').length, 2);
  v.provider.setExpansion('expand');
  assert.equal(v.messages.filter((m) => m.type === 'expandCommit').length, 2);

  for (const repoPath of ['/a', '/b']) {
    v.send({ type: 'commitFiles', repoPath, hash: 'abc', files: [{ path: 'committed.txt', add: 1, del: 0 }] });
  }
  assert.match(v.root.innerHTML, /committed.txt/);
  v.provider.setExpansion('collapse');
  v.send({ type: 'data', repos: [repo('/a'), repo('/b')] });
  assert.doesNotMatch(v.root.innerHTML, /working.txt|committed.txt/);
  v.provider.setExpansion('expand');
  assert.match(v.root.innerHTML, /committed.txt/);
  assert.equal(v.messages.filter((m) => m.type === 'expandCommit').length, 2);
});

test('bulk actions support an empty view', () => {
  const v = view();
  v.send({ type: 'data', repos: [] });
  v.provider.setExpansion('collapse');
  v.provider.setExpansion('expand');
  assert.match(v.root.innerHTML, /No git repositories/);
  assert.equal(v.messages.filter((m) => m.type === 'expandCommit').length, 0);
});

test('a collapsed worktree shows its behind count beside the name, outside the truncated label', () => {
  const v = view();
  const behind = repo('/a');
  behind.vsMaster.behind = 3;
  behind.pr = { label: '#7768 - a long label that a narrow view truncates' };
  v.send({ type: 'data', repos: [behind, repo('/b')] });
  v.provider.setExpansion('collapse');
  assert.match(v.root.innerHTML, /<span class="name">\/a<\/span><span class="behind behind-n" title="3 commits behind master">↓3<\/span>/);
  assert.doesNotMatch(v.root.innerHTML, /<span class="dim">[^<]*<span class="behind/);
  assert.equal(v.root.innerHTML.match(/behind-n/g).length, 1);

  v.provider.setExpansion('expand');
  assert.doesNotMatch(v.root.innerHTML, /behind-n/);
  assert.match(v.root.innerHTML, /↓3 behind master/);
});

test('opening a worktree also opens its Vs master section', () => {
  const v = view();
  v.send({ type: 'data', repos: [repo('/a')] });
  v.provider.setExpansion('collapse');
  const click = (act) => v.events.click({ target: { closest: (s) => s === '.row' ? { dataset: { act } } : null } });
  click('t|r|/a|0');
  assert.equal(v.saved().collapsed['s|/a|vsmaster'], false);
  assert.equal(v.saved().collapsed['s|/a|staged'], true);
  assert.match(v.root.innerHTML, /data-act="m\|\/a\|/);

  click('t|r|/a|0');
  assert.equal(v.saved().collapsed['r|/a'], true);
  assert.equal(v.saved().collapsed['s|/a|vsmaster'], false);
});

test('PR rows sit under one header per group, Kylie first and rows without a group last', () => {
  const v = view();
  const rows = ['/kylie', '/pr-3', '/pr-5', '/pr-7', '/minion-x'].map((p) => ({ ...repo(p), name: p.slice(1) }));
  rows[1].group = 'wawiData';
  rows[3].group = 'invoice';
  rows[4].group = 'minion';
  v.send({ type: 'data', repos: rows });
  v.provider.setExpansion('collapse');
  const names = [...v.root.innerHTML.matchAll(/<span class="name">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names, ['kylie', 'invoice (1)', 'pr-7', 'minion (1)', 'minion-x',
    'wawiData (1)', 'pr-3', 'no group (1)', 'pr-5']);
  assert.match(v.root.innerHTML, /<div class="row grp"[^>]*data-act="t\|p\|invoice\|0"><span class="twist">▾/);
  const pad = (act) => v.root.innerHTML.match(new RegExp('padding-left:(\\d+)px" data-act="' + act.replace(/\|/g, '\\|') + '"'))[1];
  assert.equal(pad('t|r|/kylie|0'), '4');
  assert.equal(pad('t|p|invoice|0'), '4');
  assert.equal(pad('t|r|/pr-7|0'), '18');
  v.provider.setExpansion('expand');
  assert.equal(pad('t|s|/pr-7|vsmaster|0'), '32');
  assert.equal(pad('t|s|/kylie|vsmaster|0'), '18');
  v.provider.setExpansion('collapse');

  const click = (act) => v.events.click({ target: { closest: (s) => s === '.row' ? { dataset: { act } } : null } });
  click('t|p|invoice|0');
  assert.equal(v.saved().collapsed['p|invoice'], true);
  assert.doesNotMatch(v.root.innerHTML, /<span class="name">pr-7</);
  v.provider.setExpansion('expand');
  assert.equal(v.saved().collapsed['p|invoice'], true);

  v.send({ type: 'data', repos: rows.map((r) => ({ ...r, group: '' })) });
  assert.doesNotMatch(v.root.innerHTML, /data-act="t\|p\|/);
});
