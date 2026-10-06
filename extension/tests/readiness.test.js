const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  const state = path.join(root, '.ci');
  const docs = path.join(repo, 'docs/PR_7');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(state);
  const head = 'a'.repeat(40), master = 'b'.repeat(40);
  const proof = { branch_sha: head, master_sha: master, suite: 'smoke', targets: ['kylie.tests.ServerErrorHandlerTests', 'kylie.tests.PermissionDeniedHandlerTests'],
    gate_policy: 6, fingerprint_version: 2, fingerprint: 'c'.repeat(64), time: '2026-09-30 14:00:00' };
  const record = JSON.stringify({ version: 1, summary: 'Completed requested scope' });
  const seal = { version: 1, branch_sha: head, master_sha: master, gate_policy: 6, fingerprint_version: 2,
    proof_fingerprint: proof.fingerprint, record_sha256: crypto.createHash('sha256').update(record).digest('hex') };
  const save = (name, value) => fs.writeFileSync(path.join(state, 'pr-7.' + name + '.json'), JSON.stringify(value));
  const marker = (name) => {
    for (const file of fs.readdirSync(repo).filter((file) => file.startsWith('status_'))) fs.unlinkSync(path.join(repo, file));
    fs.writeFileSync(path.join(repo, 'status_' + name), '');
  };
  fs.writeFileSync(path.join(docs, 'completion.json'), record);
  save('tested', proof);
  save('ready', seal);
  marker('ready');
  let currentHead = head;
  const context = {
    module: { exports: {} }, process, Buffer,
    fakeGit: async (_repo, args) => args[0] === 'rev-parse' ? currentHead : '',
    require: (name) => {
      if (name === 'vscode') return {
        workspace: { getConfiguration: () => ({ get: () => '/home/azrael/kylie/scripts/ci' }) },
        window: { createOutputChannel: () => ({}) },
      };
      return require(name);
    },
  };
  const api = vm.runInNewContext(source + `
    git = fakeGit;
    landedSerials = async () => new Set();
    ({ collectCi, collectPr, getHtml });
  `, context);
  return { ...api, repo, docs, state, proof, seal, save, marker, head, master,
    setHead: (value) => { currentHead = value; },
    collect: (dirty = 0, currentMaster = master) => api.collectCi(repo, 'pr-7', null, dirty, currentMaster) };
}

test('a green test record alone never means ready', async (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.state, 'pr-7.ready.json'));
  const result = await f.collect();
  assert.equal(result.state, 'verification-needed');
  assert.equal(result.checkLabel, 'Smoke passed');
});

test('a sealed current completion is ready and retains technical check details', async (t) => {
  const f = fixture(t);
  const result = await f.collect();
  assert.equal(result.state, 'ready');
  assert.equal(result.checkLabel, 'Smoke passed');
  const identity = await f.collectPr(f.repo, f.master, new Set(), result);
  assert.equal(identity.status, 'ready');
});

test('WIP and blocked markers prevail over green tests and an old completion', async (t) => {
  const f = fixture(t);
  for (const [marker, expected] of [['wip', 'wip'], ['blocked-visual-choice', 'blocked']]) {
    f.marker(marker);
    const result = await f.collect();
    assert.equal(result.state, expected);
    assert.equal(result.checkLabel, 'Smoke passed');
    assert.equal((await f.collectPr(f.repo, f.master, new Set(), result)).status, expected);
  }
});

test('later commits, dirty files, changed records and master movement invalidate readiness', async (t) => {
  const f = fixture(t);
  assert.equal((await f.collect(1)).state, 'verification-needed');
  assert.match((await f.collect(0, 'd'.repeat(40))).reason, /master moved/);
  f.setHead('e'.repeat(40));
  f.proof.branch_sha = 'e'.repeat(40);
  f.save('tested', f.proof);
  assert.equal((await f.collect()).state, 'verification-needed');
  f.setHead(f.head); f.proof.branch_sha = f.head; f.save('tested', f.proof);
  fs.writeFileSync(path.join(f.docs, 'completion.json'), '{}');
  assert.match((await f.collect()).reason, /record changed/);
});

test('missing markers, conflicting markers and corrupt evidence fail closed', async (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.repo, 'status_ready'));
  assert.equal((await f.collect()).state, 'wip');
  f.marker('ready');
  fs.writeFileSync(path.join(f.repo, 'status_wip'), '');
  assert.equal((await f.collect()).state, 'verification-needed');
  f.marker('ready');
  for (const value of [null, [], {}, { ...f.proof, gate_policy: 1 }, { ...f.proof, suite: 'land' }]) {
    f.save('tested', value);
    assert.equal((await f.collect()).state, 'verification-needed');
  }
});

test('unknown HEAD cannot become ready even with fabricated empty evidence', async (t) => {
  const f = fixture(t);
  f.setHead(''); f.proof.branch_sha = ''; f.seal.branch_sha = '';
  f.save('tested', f.proof); f.save('ready', f.seal);
  assert.equal((await f.collect()).state, 'verification-needed');
});


test('rendered rows show one task marker and keep check details in its tooltip', (t) => {
  const f = fixture(t);
  const root = { innerHTML: '' };
  let receive;
  const script = f.getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({}), postMessage() {} }),
    document: { getElementById: () => root, addEventListener() {} },
    window: { addEventListener: (_, handler) => { receive = handler; } },
  });
  const cases = [
    ['ready', 'Smoke passed'], ['ready', 'Configuration passed'],
    ['ready', 'CI checks passed'], ['ready', 'Full suite passed'],
    ['wip', 'Smoke passed'], ['blocked', 'Smoke passed'],
    ['verification-needed', 'Checks stale'], ['verification-needed', 'Checks missing'],
    ['verification-needed', 'Smoke passed'],
    ['testing', 'Checks running'], ['landed', 'Checks stale'],
  ];
  for (const [state, checkLabel] of cases) {
    receive({ data: { type: 'data', ciEnabled: true, repos: [{
      repoPath: f.repo, name: 'pr-7', branch: 'pr-7', totals: { add: 0, del: 0 },
      staged: [], unstaged: [], untracked: [], commits: [],
      pr: { serial: 7, status: state, label: 'Requested change', reason: 'Review state' },
      ci: { serial: 7, state, reason: 'Review state', checkLabel },
    }] } });
    assert.ok(root.innerHTML.includes('[' + state.replaceAll('-', ' ') + ']'));
    const visible = root.innerHTML.replace(/<[^>]*>/g, '');
    assert.ok(!visible.includes(checkLabel), 'check details must not form a second visible status');
    const markers = [...root.innerHTML.matchAll(/<span class="prst [^"]+" title="([^"]*)">/g)];
    assert.equal(markers.length, 1);
    const tooltip = markers[0][1];
    if (state === 'landed') {
      assert.match(tooltip, /master carries the squash commit/);
      assert.doesNotMatch(tooltip, /Review state|Checks stale/);
    } else if (state === 'testing') {
      assert.match(tooltip, /live ci test/);
      assert.doesNotMatch(tooltip, /Review state/);
    } else {
      assert.match(tooltip, /Review state/);
      assert.ok(tooltip.includes(checkLabel));
    }
    assert.doesNotMatch(root.innerHTML, /<button\b|<input\b/);
  }
});
