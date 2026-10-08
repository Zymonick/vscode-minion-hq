const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const sourcePath = process.env.MINION_TEST_SOURCE || path.join(__dirname, '..', 'extension.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'pr-7');
  fs.mkdirSync(path.join(repo, 'docs/PR_7'), { recursive: true });
  const state = path.join(root, '.ci');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'pr-7.slug'), 'clear-review-status');
  const report = { status: 'ready to land', checks: 'checks passed', review: 'agent sign-off current',
    issues: [], next: 'User: scripts/ci land 7', operator_steps: [] };
  const calls = [];
  let failure = null, raw;
  const api = vm.runInNewContext(source + `
    landedSerials = async () => new Set();
    git = async (_, args) => args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? 'pr-7' : '';
    ({ collectCi, collectPr, collectRepo, getHtml });
  `, {
    module: { exports: {} }, process, Buffer,
    require: (name) => {
      if (name === 'vscode') return { window: { createOutputChannel: () => ({}) },
        workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) }, Uri: { file: (value) => value } };
      if (name === 'child_process') return { execFile(command, args, options, callback) {
        calls.push({ command, args: Array.from(args), options });
        callback(failure, raw === undefined ? JSON.stringify(report) : raw);
      } };
      return require(name);
    },
  });
  return { ...api, repo, report, calls,
    fail: (error) => { failure = error; }, raw: (value) => { raw = value; },
    collect: () => api.collectCi(repo, 'pr-7') };
}

function issue(status, detail, action) {
  return { status, detail, owner: 'Agent', action };
}

test('missing sign-off is named instead of the generic verification warning', async (t) => {
  const f = fixture(t);
  f.report.status = f.report.review = 'agent sign-off missing';
  f.report.issues = [issue('agent sign-off missing', 'missing docs/PR_7/completion.json', 'record focused review evidence')];
  const result = await f.collect();
  assert.equal(result.state, 'agent-sign-off-missing');
  assert.equal(result.statusLabel, 'agent sign-off missing');
  assert.equal(result.checkLabel, 'checks passed');
  assert.match(result.reason, /Agent: record focused review evidence/);
  assert.doesNotMatch(result.reason, /verification needed/);
});

test('current CI readiness is used without a hard-coded proof policy', async (t) => {
  const f = fixture(t);
  const result = await f.collect();
  assert.equal(result.state, 'ready-to-land');
  assert.equal(result.reviewLabel, 'agent sign-off current');
  const identity = await f.collectPr(f.repo, 'master', new Set(), result);
  assert.equal(identity.status, 'ready-to-land');
  assert.equal(identity.statusLabel, 'ready to land');
  const call = f.calls[0];
  assert.equal(call.command, '/home/azrael/kylie/env/bin/python');
  assert.deepEqual(call.args.slice(0, 3), ['-I', '-B', '-c']);
  assert.match(call.args[3], /\/home\/azrael\/kylie\/scripts\/ci/);
  assert.match(call.args[3], /ci\.pr_status\(/);
  assert.equal(call.args[4], f.repo);
  assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(call.options.timeout, 5000);
});

test('outdated checks do not hide missing sign-off or its next action', async (t) => {
  const f = fixture(t);
  f.report.status = f.report.checks = 'checks outdated';
  f.report.review = 'agent sign-off missing';
  f.report.issues = [issue('checks outdated', 'master moved', 'scripts/ci test 7'),
    issue('agent sign-off missing', 'completion record missing', 'record the review')];
  const result = await f.collect();
  assert.equal(result.state, 'checks-outdated');
  assert.match(result.reason, /master moved/);
  assert.match(result.reason, /Agent: scripts\/ci test 7/);
  assert.match(result.reason, /completion record missing/);
  assert.match(result.reason, /Agent: record the review/);
});

test('CI review, failure and work states retain their exact descriptions', async (t) => {
  const f = fixture(t);
  for (const status of ['agent review outdated', 'agent sign-off incomplete', 'agent sign-off outdated',
    'agent documentation incomplete', 'checks failed', 'checks missing', 'wip', 'blocked: awaiting choice']) {
    f.report.status = status;
    f.report.issues = [issue(status, 'Concrete reason', 'Concrete next action')];
    const result = await f.collect();
    assert.equal(result.statusLabel, status);
    assert.equal(result.state, status.split(':')[0].replaceAll(' ', '-'));
  }
});

test('later operator actions remain separate from completed PR work', async (t) => {
  const f = fixture(t);
  f.report.operator_steps = ['Install the reviewed service units after landing'];
  const result = await f.collect();
  assert.equal(result.state, 'ready-to-land');
  assert.match(result.reason, /Operator after landing: Install/);
});

test('unavailable, timed out and malformed reports cannot imply readiness', async (t) => {
  const f = fixture(t);
  for (const error of [new Error('missing runtime'), { killed: true }]) {
    f.fail(error);
    const result = await f.collect();
    assert.equal(result.state, 'status-unavailable');
    assert.match(result.reason, /Agent: inspect CI status/);
  }
  f.fail(null);
  for (const raw of ['{', 'null', '[]', '{}', JSON.stringify({ ...f.report, issues: [null] }),
    JSON.stringify({ ...f.report, display_label: { text: 'Invalid' } })]) {
    f.raw(raw);
    assert.equal((await f.collect()).state, 'status-unavailable');
  }
});

test('testing overrides obsolete readiness labels', async (t) => {
  const f = fixture(t);
  f.report.status = 'agent sign-off missing';
  f.report.display_label = 'Manual label';
  const result = await f.collectRepo(f.repo, new Set([7]));
  assert.equal(result.ci.state, 'testing');
  assert.equal(result.pr.status, 'testing');
  assert.equal(result.pr.statusLabel, undefined);
  assert.equal(result.pr.customLabel, 'Manual label');
});

test('rendered rows show one task marker with check, review and action details', (t) => {
  const f = fixture(t);
  const root = { innerHTML: '' };
  let receive;
  const script = f.getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({}), postMessage() {} }),
    document: { getElementById: () => root, addEventListener() {} },
    window: { addEventListener: (_, handler) => { receive = handler; } },
  });
  for (const state of ['ready-to-land', 'wip', 'blocked', 'checks-outdated', 'checks-failed',
    'agent-sign-off-missing', 'agent-review-outdated', 'status-unavailable', 'testing', 'landed']) {
    const label = state === 'agent-sign-off-missing' ? 'agent sign-off missing' : state.replaceAll('-', ' ');
    receive({ data: { type: 'data', repos: [{
      repoPath: f.repo, name: 'pr-7', branch: 'pr-7', totals: { add: 0, del: 0 },
      staged: [], unstaged: [], untracked: [], commits: [],
      pr: { serial: 7, status: state, statusLabel: label, label: 'Requested change', reason: 'Agent: record <review>' },
      ci: { serial: 7, state, checkLabel: 'Checks passed', reviewLabel: 'Agent review current' },
    }] } });
    assert.ok(root.innerHTML.includes('[' + label + ']'));
    const visible = root.innerHTML.replace(/<[^>]*>/g, '');
    assert.ok(!visible.includes('Checks passed'), 'check details must not form a second visible status');
    const markers = [...root.innerHTML.matchAll(/<span class="prst [^"]+" title="([^"]*)">/g)];
    assert.equal(markers.length, 1);
    const tooltip = markers[0][1];
    if (state === 'landed' || state === 'testing') {
      assert.doesNotMatch(tooltip, /Agent: record|Checks passed/);
    } else {
      assert.match(tooltip, /Agent: record &lt;review&gt;/);
      assert.match(tooltip, /Checks passed/);
      assert.match(tooltip, /Agent review current/);
    }
    assert.doesNotMatch(root.innerHTML, /<button\b|<input\b/);
  }
});


test('manual labels render separately before readiness and retain its actions', async (t) => {
  const f = fixture(t);
  const root = { innerHTML: '' };
  let receive;
  const script = f.getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({}), postMessage() {} }),
    document: { getElementById: () => root, addEventListener() {} },
    window: { addEventListener: (_, handler) => { receive = handler; } },
  });
  f.report.display_label = 'Prüfung <tomorrow> & "later"';
  for (const status of ['ready to land', 'checks failed', 'blocked: awaiting input']) {
    f.report.status = status;
    f.report.issues = status === 'ready to land' ? [] : [issue(status, 'Concrete reason', 'Concrete next action')];
    const ci = await f.collect();
    assert.equal(ci.statusLabel, status);
    assert.equal(ci.customLabel, f.report.display_label);
    assert.equal(ci.state, status.split(':')[0].replaceAll(' ', '-'));
    const pr = await f.collectPr(f.repo, 'master', new Set(), ci);
    receive({ data: { type: 'data', repos: [{
      repoPath: f.repo, name: 'pr-7', branch: 'pr-7', totals: { add: 0, del: 0 },
      staged: [], unstaged: [], untracked: [], commits: [], pr, ci,
    }] } });
    const custom = '[Prüfung &lt;tomorrow&gt; &amp; &quot;later&quot;]';
    assert.ok(root.innerHTML.includes(custom));
    assert.ok(root.innerHTML.includes('[' + status + ']'));
    assert.ok(root.innerHTML.indexOf(custom) < root.innerHTML.indexOf('[' + status + ']'));
    assert.equal([...root.innerHTML.matchAll(/<span class="pr-custom-label"/g)].length, 1);
    assert.equal([...root.innerHTML.matchAll(/<span class="prst /g)].length, 1);
    assert.ok(root.innerHTML.includes(status === 'ready to land' ? f.report.next : 'Concrete next action'));
  }
  for (const status of ['testing', 'landed']) {
    const ci = await f.collect();
    const pr = await f.collectPr(f.repo, 'master', new Set([7]), ci);
    pr.status = status;
    receive({ data: { type: 'data', repos: [{
      repoPath: f.repo, name: 'pr-7', branch: 'pr-7', totals: { add: 0, del: 0 },
      staged: [], unstaged: [], untracked: [], commits: [], pr, ci,
    }] } });
    assert.match(root.innerHTML, /\[Prüfung &lt;tomorrow&gt; &amp; &quot;later&quot;\]<\/span><span class="prst /);
    assert.ok(root.innerHTML.includes('[' + status + ']'));
    const tooltip = root.innerHTML.match(/<span class="prst [^"]+" title="([^"]*)">/)[1];
    assert.doesNotMatch(tooltip, /Concrete next action|checks passed|agent sign-off current/);
  }
  f.report.display_label = '';
  const ci = await f.collect();
  assert.equal(ci.statusLabel, f.report.status);
  const pr = await f.collectPr(f.repo, 'master', new Set(), ci);
  receive({ data: { type: 'data', repos: [{
    repoPath: f.repo, name: 'pr-7', branch: 'pr-7', totals: { add: 0, del: 0 },
    staged: [], unstaged: [], untracked: [], commits: [], pr, ci,
  }] } });
  assert.doesNotMatch(root.innerHTML, /<span class="pr-custom-label"/);
  assert.ok(root.innerHTML.includes('[' + f.report.status + ']'));
});
