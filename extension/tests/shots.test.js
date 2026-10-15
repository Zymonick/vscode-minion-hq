const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// A Kylie layout: pr-7 in the worktrees folder and its CI screenshot set in
// kylie-shots/PR_7 beside it, with a clicked-state image the index omits.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-shots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'kylie-worktrees', 'pr-7');
  const dir = path.join(root, 'kylie-shots', 'PR_7');
  for (const sub of ['before', 'after', 'clicked']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  for (const file of ['before/01-a-desktop.webp', 'after/01-a-desktop.webp', 'clicked/2-menu.png', 'clicked/10-menu.png']) {
    fs.writeFileSync(path.join(dir, file), 'image');
  }
  fs.writeFileSync(path.join(dir, 'shots.json'), JSON.stringify({ paths: ['/a'], taken: '2026-10-15T13:17:04+02:00' }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n<html lang="de">\n<head>\n<title>PR 7</title>\n</head>\n<body>\n'
    + '<figure><a href="before/01-a-desktop.webp"><img src="before/01-a-desktop.webp" alt="Vorher"></a></figure>\n'
    + '<figure><a href="after/01-a-desktop.webp"><img src="after/01-a-desktop.webp" alt="Nachher"></a></figure>\n'
    + '<a href="../../kylie-worktrees/pr-7/secret.png">x</a><script>alert(1)</script>\n</body>\n</html>\n');

  const panels = [], opened = [], errors = [];
  const uri = (fsPath) => ({ fsPath, toString: () => 'https://webview/' + fsPath });
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
    ViewColumn: { Active: -1 },
    commands: { executeCommand: async (command, target) => { opened.push([command, target.fsPath]); } },
    window: {
      createWebviewPanel: (viewType, title, column, options) => {
        const panel = { viewType, title, column, options, revealed: 0, disposed: null, receive: null,
          webview: { html: '', cspSource: 'https://webview', asWebviewUri: (u) => uri(u.fsPath),
            onDidReceiveMessage: (handler) => { panel.receive = handler; } },
          onDidDispose: (handler) => { panel.disposed = handler; },
          reveal() { this.revealed++; } };
        panels.push(panel);
        return panel;
      },
      createOutputChannel: () => ({ appendLine() {} }),
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => '' }) },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml, shotsSummary });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, process,
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  const provider = new api.StatsViewProvider();
  provider.data.set(repo, { repoPath: repo, name: 'pr-7', pr: { serial: 7, status: 'wip' } });
  return { ...api, provider, repo, dir, panels, opened, errors,
    click: () => provider.onMessage({ type: 'shots', repoPath: repo }) };
}

test('a PR row names its screenshot count and time; a PR without images has none', (t) => {
  const f = fixture(t);
  assert.deepEqual(JSON.parse(JSON.stringify(f.shotsSummary(f.repo, 7))), { images: 4, taken: '2026-10-15T13:17:04+02:00' });
  assert.equal(f.shotsSummary(f.repo, 8), null);
  fs.rmSync(path.join(f.dir, 'shots.json'));
  assert.deepEqual(JSON.parse(JSON.stringify(f.shotsSummary(f.repo, 7))), { images: 4, taken: null });
});

test('only PR rows with screenshots carry the control, and clicking it asks the host without toggling the row', (t) => {
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
    row(f.repo, { serial: 7, status: 'wip', shots: { images: 4, taken: '2026-10-15T13:17:04+02:00' } }),
    row('/w/pr-8', { serial: 8, status: 'wip', shots: null }),
  ] } });
  const controls = [...root.innerHTML.matchAll(/<span class="shots" data-shots="([^"]*)" title="([^"]*)">/g)];
  assert.deepEqual(controls.map((m) => [m[1], m[2]]), [[f.repo, 'Screenshots of pr-7: 4 images, taken 2026-10-15T13:17:04+02:00']]);

  posted.length = 0;
  click({ target: { closest: (selector) => selector === '.shots' ? { dataset: { shots: f.repo } } : null } });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'shots', repoPath: f.repo }]);
  assert.equal(saved, 0, 'the screenshot control must not collapse or expand its row');
});

test('the set opens in one editor tab that loads only its own images and re-reads a replaced set', async (t) => {
  const f = fixture(t);
  await f.click();
  assert.equal(f.panels.length, 1);
  const [panel] = f.panels;
  assert.equal(panel.title, 'pr-7 · Screenshots');
  assert.deepEqual(Array.from(panel.options.localResourceRoots, (u) => u.fsPath), [f.dir]);
  const html = panel.webview.html;
  assert.match(html, /<head>\s*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:\/\/webview; style-src 'unsafe-inline'; script-src 'nonce-[a-z0-9]+';">/);
  assert.ok(html.includes('<img src="https://webview/' + path.join(f.dir, 'before/01-a-desktop.webp') + '" alt="Vorher">'));
  assert.ok(html.includes('href="https://webview/' + path.join(f.dir, 'after/01-a-desktop.webp') + '" data-file="after/01-a-desktop.webp"'));
  assert.ok(html.includes('<a href="#">x</a><script>alert(1)</script>'), 'outside links go nowhere; the policy blocks CI scripts');
  const other = html.slice(html.indexOf('Other screenshots'));
  assert.ok(other.indexOf('clicked/2-menu.png') < other.indexOf('clicked/10-menu.png'), 'unshown images follow in natural order');
  assert.doesNotMatch(other, /01-a-desktop/);
  assert.equal(panel.revealed, 1);

  await panel.receive({ type: 'open', file: 'clicked/2-menu.png' });
  await panel.receive({ type: 'open', file: '../../kylie-worktrees/pr-7/secret.png' });
  await panel.receive({ type: 'open', file: 'shots.json' });
  assert.deepEqual(f.opened, [['vscode.open', path.join(f.dir, 'clicked/2-menu.png')]]);

  fs.rmSync(path.join(f.dir, 'clicked'), { recursive: true });
  await f.click();
  assert.equal(f.panels.length, 1, 'a second click reuses the tab');
  assert.equal(panel.revealed, 2);
  assert.doesNotMatch(panel.webview.html, /Other screenshots/);

  panel.disposed();
  await f.click();
  assert.equal(f.panels.length, 2, 'a closed tab opens again');
  assert.deepEqual(f.errors, []);
});

test('a set without index.html still shows its images, and a missing set reports an error', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.dir, 'index.html'));
  await f.click();
  const html = f.panels[0].webview.html;
  assert.match(html, /<h1>pr-7 · Screenshots<\/h1>/);
  assert.equal((html.match(/<figure>/g) || []).length, 4);

  fs.rmSync(f.dir, { recursive: true });
  await f.click();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /^Could not open the screenshots of pr-7: no screenshots in /);
});
