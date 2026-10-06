const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function harness() {
  const calls = [];
  const record = (...args) => calls.push(args);
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => '/configured/command' }) },
    window: {
      createOutputChannel: () => ({}),
      showInputBox: record,
      createTerminal: record,
    },
    tasks: { executeTask: record },
  };
  const { StatsViewProvider, getHtml } = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml });', {
    module: { exports: {} },
    require: (name) => {
      if (name === 'vscode') return vscode;
      if (name === 'child_process') return { execFile: record, spawn: record };
      return require(name);
    },
  });
  return { provider: new StatsViewProvider(), getHtml, calls };
}

test('legacy steering messages cannot launch commands, terminals, or Git writes', async () => {
  const { provider, calls } = harness();
  const target = { repoPath: '/repos/pr-7', serial: '7' };
  for (const cmd of ['new', 'preview', 'test', 'land']) {
    await provider.onMessage({ type: 'ci', cmd, ...target });
  }
  for (const type of ['synctest', 'preview', 'commit']) {
    await provider.onMessage({ type, message: 'Old draft', push: true, ...target });
  }
  assert.deepEqual(calls, []);
});

test('master, PR, and generic worktrees show status and files without steering controls', () => {
  const { getHtml } = harness();
  const root = { innerHTML: '' };
  let receive;
  vm.runInNewContext(getHtml('test').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ getState: () => ({}), postMessage() {} }),
    document: { getElementById: () => root, addEventListener() {} },
    window: { addEventListener: (_, handler) => { receive = handler; } },
  });
  const file = { path: 'app.js', letter: 'M', add: 1, del: 0 };
  const repos = ['master', 'pr-7', 'feature'].map((branch) => ({
    branch, repoPath: '/repos/' + branch, name: branch, upstream: true,
    totals: { add: 1, del: 0 }, staged: [file], unstaged: [file], untracked: [], commits: [],
    vsMaster: branch === 'master' ? null : { files: [file], totals: { add: 1, del: 0 } },
  }));
  repos[1].pr = { status: 'ready', label: 'Requested change', reason: 'Verified' };
  repos[1].ci = { state: 'ready', reason: 'Verified', checkLabel: 'Smoke passed' };
  receive({ data: { type: 'data', repos, ciEnabled: true, syncEnabled: true, previewEnabled: true } });
  assert.doesNotMatch(root.innerHTML, /<button\b|<input\b/);
  assert.match(root.innerHTML, /\[ready\]/);
  assert.match(root.innerHTML, /Smoke passed/);
  assert.match(root.innerHTML, /data-act="s\|\/repos\/pr-7\|app.js"/);
  assert.match(root.innerHTML, /data-act="w\|\/repos\/feature\|app.js"/);
  assert.match(root.innerHTML, /Vs master/);
});
