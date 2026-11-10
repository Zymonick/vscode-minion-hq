const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// A request directory as the kylie-pr mod writes it, a window whose workspace
// folders are `folders`, and a dialog that answers `answer`.
function fixture(t, { folders, answer } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-userrun-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kylie = path.join(root, 'kylie');
  const requests = path.join(root, 'requests');
  fs.mkdirSync(requests);
  const created = [], asked = [], logged = [];
  const vscode = {
    window: {
      terminals: [],
      createTerminal: (options) => {
        created.push(options);
        return { show() { throw new Error('a user-run terminal must not take the focus'); } };
      },
      createOutputChannel: () => ({ appendLine: (line) => logged.push(line) }),
      showWarningMessage: async (message, options, ...buttons) => {
        asked.push({ message, modal: options.modal, buttons });
        return answer;
      },
    },
    workspace: { workspaceFolders: (folders || [kylie]).map((fsPath) => ({ uri: { fsPath } })),
      getConfiguration: () => ({ get: () => '' }) },
  };
  const api = vm.runInNewContext(source + '\n({ StatsViewProvider, takeUserRunRequests, userRunRequest });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, process,
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  new api.StatsViewProvider(); // opens the output channel
  const request = (name, value, ageMs = 0) => {
    const file = path.join(requests, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  };
  const take = async () => {
    api.takeUserRunRequests(root, kylie);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...api, root, kylie, requests, created, asked, logged, request, take };
}

test('a land request runs at once in an unfocused terminal of the Kylie checkout', async (t) => {
  const f = fixture(t);
  f.request('land-1700.json', { words: ['1260', '--notest'] });
  await f.take();
  assert.deepEqual(f.asked, [], 'land asks nothing');
  const base = path.join(f.root, 'land-1700');
  assert.deepEqual(JSON.parse(JSON.stringify(f.created)), [{
    name: 'ci land 1260 --notest', cwd: f.kylie, shellPath: '/bin/bash',
    shellArgs: ['-o', 'pipefail', '-lc', `${f.kylie}/scripts/ci land 1260 --notest 2>&1 | tee ${base}.log` +
      ` && echo 0 > ${base}.rc || echo $? > ${base}.rc`],
  }]);
  assert.deepEqual(fs.readdirSync(f.requests), [], 'the window takes the request by deleting it');
  await f.take();
  assert.equal(f.created.length, 1, 'a taken request never runs twice');
  assert.deepEqual(f.logged, ['user run: started ci land 1260 --notest']);
});

test('a remove request runs after approval in a modal dialog', async (t) => {
  const f = fixture(t, { answer: 'Remove' });
  f.request('remove-1750.json', { words: ['791'] });
  await f.take();
  assert.deepEqual(f.asked, [{ message: 'Run ci remove 791?', modal: true, buttons: ['Remove'] }]);
  assert.deepEqual(f.created.map((c) => c.name), ['ci remove 791']);
});

test('a refused remove dialog runs nothing and ends the request with exit 130', async (t) => {
  const f = fixture(t, { answer: undefined });
  f.request('remove-1800.json', { words: ['791', '--force'] });
  await f.take();
  assert.deepEqual(f.asked.map((a) => a.buttons), [['Remove']]);
  assert.deepEqual(f.created, []);
  assert.equal(fs.readFileSync(path.join(f.root, 'remove-1800.log'), 'utf8'), 'ci remove 791 --force: not approved in VS Code\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'remove-1800.rc'), 'utf8'), '130\n');
});

test('invalid, old and foreign-window requests run nothing', async (t) => {
  const f = fixture(t, { answer: 'Land' });
  f.request('land-1.json', { words: ['1260 && rm'] });
  f.request('land-2.json', { words: [] });
  f.request('remove-3.json', { words: ['all'] });
  f.request('migrate-4.json', { words: ['1260'] });
  f.request('land-5.json', 'not json');
  f.request('land-6.json', { words: ['1260'] }, 61000);
  await f.take();
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.created, []);
  assert.deepEqual(fs.readdirSync(f.requests), []);
  assert.equal(f.logged.length, 6);
  assert.match(f.logged.find((line) => line.includes('land-6')), /older than 60 s/);

  const other = fixture(t, { answer: 'Land', folders: ['/home/azrael/kylie-worktrees/pr-1260'] });
  other.request('land-7.json', { words: ['1260'] });
  await other.take();
  assert.deepEqual(other.asked, []);
  assert.deepEqual(fs.readdirSync(other.requests), ['land-7.json'], 'a window without the Kylie checkout leaves it');
});

test('a request accepts the target and flag forms of its verb only', (t) => {
  const f = fixture(t);
  // a JSON round trip: strict deepEqual fails across the vm realm
  const words = (name, list) => {
    const request = f.userRunRequest(name, JSON.stringify({ words: list }), '/r');
    return request ? JSON.parse(JSON.stringify(request.words)) : undefined;
  };
  assert.deepEqual(words('land-1.json', ['all']), ['all']);
  assert.deepEqual(words('land-1.json', ['pr-654', 'supplier-context-status', '--force']), ['pr-654', 'supplier-context-status', '--force']);
  assert.equal(words('land-1.json', ["791'"]), undefined);
  assert.equal(words('remove-1.json', ['--notest']), undefined);
  assert.equal(words('land-x.json', ['791']), undefined);
  assert.equal(f.userRunRequest('land-9.json', '{"words":["791"]}', '/r').base, '/r/land-9');
});
