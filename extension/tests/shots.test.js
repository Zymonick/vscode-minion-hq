const assert = require('node:assert/strict');
const cp = require('node:child_process');
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

  // wslpath maps the WSL root to the distro's share; PowerShell starts Chrome
  // unless chromeError holds its error output.
  const panels = [], launched = [], errors = [];
  const state = { chromeError: null };
  const childProcess = { ...cp,
    execFile: (file, args, ...rest) => {
      const done = rest[rest.length - 1];
      if (file === 'wslpath') return done(null, '\\\\wsl.localhost\\Ubuntu' + args[1].replace(/\//g, '\\') + '\n');
      if (!file.endsWith('powershell.exe')) return cp.execFile(file, args, ...rest);
      const launch = { file, args, options: rest[0], input: null };
      launched.push(launch);
      return { stdin: { end: (input) => {
        launch.input = JSON.parse(input);
        process.nextTick(() => state.chromeError ? done(new Error('exit 1'), '', state.chromeError + '\r\n') : done(null, '', ''));
      } } };
    } };
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
    ViewColumn: { Active: -1 },
    window: {
      tabGroups: { all: [{ viewColumn: 1 }, { viewColumn: 2 }] },
      createWebviewPanel: (viewType, title, column, options) => {
        panels.push({ viewType, title, column, options });
        return null;
      },
      createOutputChannel: () => ({ appendLine() {} }),
      showErrorMessage: async (message) => { errors.push(message); },
    },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => '' }) },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, getHtml, shotsSummary, windowsFileUrl });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, process,
    require: (name) => ({ vscode, child_process: childProcess, os: { ...os, tmpdir: () => root } })[name] || require(name),
  });
  const provider = new api.StatsViewProvider();
  provider.data.set(repo, { repoPath: repo, name: 'pr-7', pr: { serial: 7, status: 'wip' } });
  return { ...api, provider, repo, dir, panels, launched, errors, state,
    page: path.join(root, 'minion-hq-shots', 'PR_7.html'),
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

test('Windows paths become file URLs with each name encoded', (t) => {
  const f = fixture(t);
  assert.equal(f.windowsFileUrl('\\\\wsl.localhost\\Ubuntu\\home\\a b#1'), 'file://wsl.localhost/Ubuntu/home/a%20b%231');
  assert.equal(f.windowsFileUrl('C:\\Users\\simon'), 'file:///C:/Users/simon');
});

test('the set opens in Chrome as a page that loads only its own images and re-reads a replaced set', async (t) => {
  const f = fixture(t);
  await f.click();
  assert.deepEqual(f.panels, [], 'no editor tab opens');
  assert.equal(f.launched.length, 1);
  const [launch] = f.launched;
  assert.equal(launch.file, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.deepEqual(Array.from(launch.args.slice(0, 3)), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(launch.args[3], /Start-Process -FilePath \$r\.chrome -ArgumentList \$r\.arguments .* -WindowStyle Normal$/);
  assert.deepEqual(launch.input, { chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    arguments: ['--profile-directory=KyliePreview', '--new-window', '\\\\wsl.localhost\\Ubuntu' + f.page.replace(/\//g, '\\')] },
    'a new normal window of the preview profile shows the page; the path travels as data');
  const url = (rel) => 'file://wsl.localhost/Ubuntu' + f.dir + '/' + rel;
  const html = fs.readFileSync(f.page, 'utf8');
  assert.match(html, /<head>\s*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline';">/);
  assert.ok(html.includes('<a href="' + url('before/01-a-desktop.webp') + '"><img src="' + url('before/01-a-desktop.webp') + '" alt="Vorher"></a>'));
  assert.ok(html.includes('<a href="#">x</a><script>alert(1)</script>'), 'outside links go nowhere; the policy blocks CI scripts');
  assert.doesNotMatch(html, /acquireVsCodeApi|data-file/);
  const other = html.slice(html.indexOf('Other screenshots'));
  assert.ok(other.indexOf('clicked/2-menu.png') < other.indexOf('clicked/10-menu.png'), 'unshown images follow in natural order');
  assert.ok(other.includes('<a href="' + url('clicked/2-menu.png') + '">'), 'a click opens the image full size');
  assert.doesNotMatch(other, /01-a-desktop/);

  fs.rmSync(path.join(f.dir, 'clicked'), { recursive: true });
  await f.click();
  assert.equal(f.launched.length, 2, 'a second click opens the set again');
  assert.doesNotMatch(fs.readFileSync(f.page, 'utf8'), /Other screenshots/);
  assert.deepEqual(f.errors, []);
});

test('a set without index.html still shows its images; a missing set or Chrome reports an error', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.dir, 'index.html'));
  await f.click();
  const html = fs.readFileSync(f.page, 'utf8');
  assert.match(html, /<h1>pr-7 · Screenshots<\/h1>/);
  assert.equal((html.match(/<figure>/g) || []).length, 4);

  f.state.chromeError = 'This command cannot be run due to the error: The system cannot find the file specified.';
  await f.click();
  fs.rmSync(f.dir, { recursive: true });
  await f.click();
  assert.deepEqual(f.errors.map((e) => e.replace(/ in .*$/, '')), [
    'Could not open the screenshots of pr-7: This command cannot be run due to the error: The system cannot find the file specified.',
    'Could not open the screenshots of pr-7: no screenshots',
  ]);
});
