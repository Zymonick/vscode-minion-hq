const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(contents) {
  const blobs = new Map();
  const entries = Object.entries(contents).map(([file, content]) => {
    const buffer = Buffer.from(typeof content === 'string' ? content : content.content);
    const oid = crypto.createHash('sha1').update(buffer).digest('hex');
    blobs.set(oid, buffer);
    return '100644 blob ' + oid + ' ' + (content.bytes ?? buffer.length) + '\t' + file + '\0';
  });
  return { tree: entries.join(''), blobs };
}

function load(trees = {}, declarations = []) {
  const reads = [];
  const blobs = new Map(Object.values(trees).flatMap((tree) => [...tree.blobs]));
  const context = {
    module: { exports: {} }, process, Buffer,
    readTree: async (_repo, args) => {
      reads.push(args);
      return { code: 0, out: trees[args[4]]?.tree || '' };
    },
    readBlobs: async () => blobs,
    require: (name) => {
      if (name === 'vscode') return {
        Uri: { file: (file) => file },
        workspace: { getConfiguration: () => ({ get: (key) => key === 'vendorLibraries' ? declarations : '' }) },
      };
      if (name === 'child_process') return {};
      return require(name);
    },
  };
  vm.createContext(context);
  const api = vm.runInContext(source + `
    gitFull = readTree;
    catBlobs = readBlobs;
    ({ vendorLocation, vendorIdentity, vendorDeclarations, vendorAt, collectDependencies, collectComplexity, getHtml });
  `, context);
  return { ...api, context, reads };
}

function pdfFiles(version, bytes = 7000000) {
  const root = 'staticfiles/pdfjs-' + version;
  return {
    [root + '/README.md']: 'PDF.js ' + version + ', Apache 2.0.\nBundled from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-' + version + '.tgz\n',
    [root + '/build/pdf.js']: { content: 'upstream ' + version, bytes },
    [root + '/wasm/decoder.wasm']: { content: 'binary asset', bytes: 100000 },
  };
}

test('metadata identifies actual vendor roots without excluding arbitrary static or application code', () => {
  const { vendorLocation, vendorIdentity, vendorAt, vendorDeclarations } = load({}, [
    { name: 'Explicit', path: 'assets/library' }, { name: 'Unsafe', path: '../app' },
    { name: 'Broad', path: '*' }, { name: 'Absolute', path: '/app' },
  ]);
  assert.deepEqual(plain(vendorLocation('app/vendor/@scope/library/index.js')),
    { container: 'app/vendor', root: 'app/vendor/@scope/library' });
  assert.equal(vendorLocation('invoice/static/invoice/pdf_viewer.js'), null);
  assert.equal(vendorLocation('staticfiles/custom.js'), null);
  assert.equal(vendorIdentity('', 'Our application README'), null);
  assert.equal(vendorIdentity('{"name":"incomplete"}', ''), null);
  assert.deepEqual(plain(vendorIdentity('{"name":"@scope/library","version":"1.2.3"}', '')),
    { id: '@scope/library', name: '@scope/library', version: '1.2.3' });
  assert.equal(vendorAt('assets/library-extra/app.js', [{ path: 'assets/library' }]), undefined);
  assert.deepEqual(plain(vendorDeclarations('/repo')), [{ name: 'Explicit', path: 'assets/library', id: 'explicit' }]);
});

test('an added PDF.js bundle reports its full footprint, preserves integration code, and caches revision reads', async () => {
  const contents = pdfFiles('5.6.205');
  const { collectDependencies, reads } = load({ base: fixture({}), head: fixture(contents) });
  const files = [
    { path: 'staticfiles/pdfjs-5.6.205/build/pdf.js' },
    { path: 'invoice/static/invoice/pdf_viewer.js' },
  ];
  const result = await collectDependencies('/repo', 'base', 'head', files, {});
  assert.equal(result.changes.length, 1);
  const change = result.changes[0];
  assert.equal(change.name, 'PDF.js');
  assert.equal(change.kind, 'added');
  assert.equal(change.baseBytes, 0);
  assert.equal(change.headBytes, 7100000 + Buffer.byteLength(contents['staticfiles/pdfjs-5.6.205/README.md']));
  assert.deepEqual(plain(change.headVersions), ['5.6.205']);
  assert.equal(files[0].vendor, 'PDF.js');
  assert.equal(files[1].vendor, undefined);
  await collectDependencies('/repo', 'base', 'head', files, {});
  assert.equal(reads.length, 2, 'unchanged revisions must reuse both snapshots');
  assert.deepEqual(Array.from(reads[0].slice(0, 4)), ['ls-tree', '-r', '-l', '-z']);
});

test('a version replacement is one update and an additional installed version is not a new library', async () => {
  for (const keepOld of [false, true]) {
    const previous = pdfFiles('5.6.205');
    const next = { ...(keepOld ? previous : {}), ...pdfFiles('6.3.289', 8000000) };
    const { collectDependencies } = load({ base: fixture(previous), head: fixture(next) });
    const result = await collectDependencies('/repo', 'base', 'head', [
      { path: 'staticfiles/pdfjs-6.3.289/build/pdf.js' },
    ], {});
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].kind, 'updated');
    assert.deepEqual(plain(result.changes[0].headVersions), keepOld ? ['5.6.205', '6.3.289'] : ['6.3.289']);
  }
});

test('removals, binary-only edits, and explicit library directories remain visible', async () => {
  const previous = fixture({ 'assets/library/image.png': 'old bytes' });
  for (const next of [{}, { 'assets/library/image.png': 'new bytes' }]) {
    const { collectDependencies } = load({ base: previous, head: fixture(next) }, [{ name: 'Images', path: 'assets/library' }]);
    const result = await collectDependencies('/repo', 'base', 'head', [{ path: 'assets/library/image.png', binary: true }], {});
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].kind, Object.keys(next).length ? 'updated' : 'removed');
    assert.equal(result.changes[0].baseBytes, 9);
  }
});

test('unidentified static subdirectories remain application code', async () => {
  const { collectDependencies } = load({
    base: fixture({}), head: fixture({ 'staticfiles/custom/app.js': 'our code' }),
  });
  const file = { path: 'staticfiles/custom/app.js' };
  const result = await collectDependencies('/repo', 'base', 'head', [file], {});
  assert.equal(result.changes.length, 0);
  assert.equal(result.headRoots.length, 0);
  assert.equal(file.vendor, undefined);
});

test('complexity scoring skips vendor sides and still scores the application adapter and tests', async () => {
  const { context, collectComplexity } = load();
  vm.runInContext(`
    qltyRoot = async () => '/scratch';
    var scoredPaths = [];
    treeBlobs = async (_repo, ref, paths) => {
      scoredPaths.push([ref, [...paths]]);
      return new Map(paths.map((p) => [p, ref + p]));
    };
    qltyCacheLoad = () => ({ has: () => true, get: () => ({ complex: 3, cyclo: 4 }) });
  `, context);
  const vendor = { path: 'staticfiles/pdfjs-5.6.205/build/pdf.js', cx: { cognitive: 999 } };
  const adapter = { path: 'invoice/static/invoice/pdf_viewer.js' };
  const regression = { path: 'invoice/test_annotations.py' };
  const total = await collectComplexity('/repo', 'base', [vendor, adapter, regression], {}, 'head', {
    baseRoots: [{ path: 'staticfiles/pdfjs-5.6.205' }], headRoots: [{ path: 'staticfiles/pdfjs-5.6.205' }],
  });
  assert.equal(vendor.cx, undefined);
  assert.equal(adapter.cx.head, 3);
  assert.equal(total.files, 1);
  assert.equal(total.tests.files, 1);
  assert.ok(context.scoredPaths.every(([, paths]) => paths.length === 2 && !paths.includes(vendor.path)));

  const moved = { path: 'vendor/lib/adapter.js' };
  const movedTotal = await collectComplexity('/repo', 'base', [moved], { [moved.path]: 'app/adapter.js' }, 'head', {
    baseRoots: [], headRoots: [{ path: 'vendor/lib' }],
  });
  assert.equal(movedTotal.cognitive, -3, 'only the formerly owned application side should count');
});

function renderDependencies(dependencies, collapsed) {
  const script = load().getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  const root = { innerHTML: '' };
  let receive;
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => ({ collapsed: { 'r|/repo': collapsed } }), postMessage() {} }),
    document: { getElementById: () => root, addEventListener() {} },
    window: { addEventListener: (_, handler) => { receive = handler; } },
  });
  receive({ data: { type: 'data', repos: [{
    repoPath: '/repo', name: 'repo', branch: 'feature', totals: { add: 1, del: 0 },
    staged: [], unstaged: [], untracked: [], commits: [],
    vsMaster: { dependencies, cx: null, totals: { add: 1, del: 0 }, behind: 0, ahead: 1,
      files: [{ path: 'vendor/lib/pdf.js', vendor: 'PDF.js' }] },
  }] } });
  return root.innerHTML;
}

test('expanded and collapsed rows display dependency cost without qlty and escape library names', () => {
  const change = { name: 'PDF.js', kind: 'added', baseBytes: 0, headBytes: 7100000, baseVersions: [], headVersions: ['5.6.205'] };
  for (const collapsed of [false, true]) {
    const html = renderDependencies([change], collapsed);
    assert.match(html, /\+1 dependency · PDF.js · 7.1 MB/);
    assert.match(html, /Uncompressed tracked vendor files, not browser transfer size/);
    if (!collapsed) assert.match(html, />vendor<\/span>/);
  }
  assert.match(renderDependencies([{ ...change, name: '<img src=x>' }], true), /&lt;img src=x&gt;/);
  assert.match(renderDependencies([{ ...change, kind: 'updated' }], true), /1 dependency updated/);
  assert.match(renderDependencies([{ ...change, kind: 'removed', baseBytes: 7100000, headBytes: 0 }], true), /−1 dependency · PDF.js · 7.1 MB/);
  assert.match(renderDependencies(null, true), /Dependencies unavailable/);
  assert.doesNotMatch(renderDependencies([], true), /class="dependencies"/);
});

test('repository collection reads committed dependency bytes without counting dirty files', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-dependencies-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', [
    '-c', 'user.name=Minion Test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '--initial-branch=master');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Application\n');
  git('add', '.');
  git('commit', '-qm', 'Baseline');
  git('checkout', '-qb', 'feature');
  const root = path.join(repo, 'staticfiles', 'library');
  fs.mkdirSync(root, { recursive: true });
  const metadata = JSON.stringify({ name: 'library', version: '1.0.0' });
  fs.writeFileSync(path.join(root, 'package.json'), metadata);
  fs.writeFileSync(path.join(root, 'library.js'), 'upstream code\n');
  git('add', '.');
  git('commit', '-qm', 'Add library');
  fs.appendFileSync(path.join(root, 'library.js'), 'uncommitted code\n');
  const collectRepo = vm.runInNewContext(source + '\nqltyCommandPath = () => ""; collectRepo;', {
    module: { exports: {} }, process, Buffer,
    require: (name) => name === 'vscode' ? {
      Uri: { file: (file) => file },
      workspace: { getConfiguration: () => ({ get: (key) => key === 'vendorLibraries' ? [] : '' }) },
    } : require(name),
  });
  const result = await collectRepo(repo, new Set());
  assert.equal(result.vsMaster.cx, null, 'dependency reporting must not need qlty');
  assert.equal(result.vsMaster.dependencies[0].name, 'library');
  assert.equal(result.vsMaster.dependencies[0].kind, 'added');
  assert.equal(result.vsMaster.dependencies[0].headBytes, Buffer.byteLength(metadata + 'upstream code\n'));
  assert.ok(result.vsMaster.files.every((file) => file.vendor === 'library'));
  assert.equal(fs.readFileSync(path.join(root, 'library.js'), 'utf8'), 'upstream code\nuncommitted code\n');
});
