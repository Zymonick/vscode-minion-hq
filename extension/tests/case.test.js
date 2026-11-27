const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// pr-7 with the Case that `ci case` recorded in .ci/pr-7.case; the host opens
// links through a stand-in for vscode.env.openExternal.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'kylie-worktrees', 'pr-7');
  const ci = path.join(root, 'kylie-worktrees', '.ci');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(ci);
  fs.writeFileSync(path.join(ci, 'pr-7.slug'), 'case-icon-link\n');
  fs.writeFileSync(path.join(ci, 'pr-7.case'), '8358\n');
  const opened = [], errors = [];
  const state = { open: true };
  const vscode = {
    Uri: { parse: (value) => ({ value, scheme: value.split(':')[0] }) },
    env: { openExternal: async (uri) => { opened.push(uri.value); return state.open; } },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => '' }) },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml, collectPr });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, process,
    require: (name) => (name === 'vscode' ? vscode : require(name)),
  });
  const provider = new api.StatsViewProvider();
  return { ...api, provider, repo, ci, opened, errors, state };
}

test('a PR reads its Case number from ci case; a missing or malformed one gives none', async (t) => {
  const f = fixture(t);
  const pr = await f.collectPr(f.repo, null, null, null);
  assert.equal(pr.caseNumber, 8358);
  assert.equal(pr.label, '#8358 - case icon link');
  fs.writeFileSync(path.join(f.ci, 'pr-7.case'), '08358\n');
  assert.equal((await f.collectPr(f.repo, null, null, null)).caseNumber, null);
  fs.rmSync(path.join(f.ci, 'pr-7.case'));
  assert.equal((await f.collectPr(f.repo, null, null, null)).caseNumber, null);
});

test('only PR rows with a Case carry the control, and clicking it asks the host without toggling the row', (t) => {
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
  receive({ data: { type: 'data', repos: [
    row('/w/kylie', null),
    row(f.repo, { serial: 7, status: 'wip', caseNumber: 8358 }),
    row('/w/pr-8', { serial: 8, status: 'wip', caseNumber: null }),
  ] } });
  const controls = [...root.innerHTML.matchAll(/<span class="case" data-case="([^"]*)" title="([^"]*)">/g)];
  assert.deepEqual(controls.map((m) => [m[1], m[2]]), [[f.repo, 'Case #8358: open it in the browser']]);

  posted.length = 0;
  click({ target: { closest: (selector) => selector === '.case' ? { dataset: { case: f.repo } } : null } });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'case', repoPath: f.repo }]);
  assert.equal(saved, 0, 'the Case control must not collapse or expand its row');
});

test('a click opens the production Case page; a refused open reports an error', async (t) => {
  const f = fixture(t);
  f.provider.data.set(f.repo, { repoPath: f.repo, name: 'pr-7', pr: { serial: 7, status: 'wip', caseNumber: 8358 } });
  f.provider.data.set('/w/pr-8', { repoPath: '/w/pr-8', name: 'pr-8', pr: { serial: 8, status: 'wip', caseNumber: null } });
  await f.provider.onMessage({ type: 'case', repoPath: f.repo });
  await f.provider.onMessage({ type: 'case', repoPath: '/w/pr-8' });
  assert.deepEqual(f.opened, ['https://kylie.duett-boutiques.ch/case/8358']);
  assert.deepEqual(f.errors, []);
  f.state.open = false;
  await f.provider.onMessage({ type: 'case', repoPath: f.repo });
  assert.deepEqual(f.errors, ['Could not open Case #8358 of pr-7.']);
});
