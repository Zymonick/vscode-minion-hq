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
