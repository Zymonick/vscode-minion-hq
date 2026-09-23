const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// objects built inside the vm belong to another realm; strict deep equality checks prototypes
const plain = (o) => JSON.parse(JSON.stringify(o));

function load() {
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => '' }) },
    window: { createOutputChannel: () => ({ appendLine() {} }) },
  };
  return vm.runInNewContext(source + '\n({ parseQltyTable, qltyExt, isTestPath, complexityTotals, getHtml });', {
    module: { exports: {} },
    process,
    Buffer,
    require: (name) => {
      if (name === 'vscode') return vscode;
      if (name === 'child_process') return {};
      return require(name);
    },
  });
}

// `qlty metrics --quiet` output, verbatim: colour codes even when piped, a
// header, one row per file (name relative to the cwd), a TOTAL row
const TABLE = [
  '',
  '\x1b[0m \x1b[0m\x1b[0m\x1b[0mname                        \x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mclasses\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mfuncs\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mfields\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mcyclo\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mcomplex\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mLCOM\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mlines\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m LOC\x1b[0m \x1b[0m',
  '\x1b[0m\x1b[0m------------------------------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m---------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m-------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m--------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m-------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m---------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m-------\x1b[0m\x1b[0m+\x1b[0m\x1b[0m------\x1b[0m\x1b[0m\x1b[0m',
  '\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mblobs/run/0123abcd.py       \x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m      2\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m    7\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m     3\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m   19\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m     14\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m   1\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m  120\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m 101\x1b[0m \x1b[0m',
  '\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mblobs/run/4567ef01.js       \x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m      0\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m    3\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m     0\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m    8\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m      5\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m   0\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m   40\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m  35\x1b[0m \x1b[0m',
  '\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0mTOTAL                       \x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m      2\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m   10\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m     3\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m   27\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m     19\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m   1\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m  160\x1b[0m \x1b[0m\x1b[0m|\x1b[0m\x1b[0m \x1b[0m\x1b[0m\x1b[0m 136\x1b[0m \x1b[0m',
  '\x1b[0m',
].join('\n');

test('the metrics table parses per file, colour and TOTAL row dropped', () => {
  const rows = load().parseQltyTable(TABLE);
  assert.deepEqual([...rows.keys()], ['0123abcd.py', '4567ef01.js']);
  assert.deepEqual(plain(rows.get('0123abcd.py')),
    { classes: 2, funcs: 7, fields: 3, cyclo: 19, complex: 14, LCOM: 1, lines: 120, LOC: 101 });
  assert.equal(rows.get('4567ef01.js').complex, 5);
});

test('an empty run (only a TOTAL row, or no table) yields no rows', () => {
  const { parseQltyTable } = load();
  assert.equal(parseQltyTable('').size, 0);
  assert.equal(parseQltyTable(' name | cyclo | complex \n------+-------+---------\n TOTAL |  0 |  0 \n').size, 0);
});

test('only source files qlty scores are sent to it', () => {
  const { qltyExt } = load();
  assert.equal(qltyExt('invoice/models.py'), 'py');
  assert.equal(qltyExt('extension/extension.JS'), 'js');
  assert.equal(qltyExt('invoice/templates/invoice/list.html'), null);
  assert.equal(qltyExt('docs/PR_276/spec_short.md'), null);
  assert.equal(qltyExt('Makefile'), null);
});

test('deltas count merge base vs HEAD, added and deleted files from or to zero', () => {
  const { complexityTotals } = load();
  const modified = { path: 'a.py' }, added = { path: 'b.py' }, deleted = { path: 'c.py' }, template = { path: 'd.html' };
  const total = complexityTotals([
    { f: modified, head: { complex: 14, cyclo: 19 }, base: { complex: 9, cyclo: 12 } },
    { f: added, head: { complex: 5, cyclo: 8 }, base: null },
    { f: deleted, head: null, base: { complex: 3, cyclo: 4 } },
    { f: template, head: null, base: null },
  ]);
  assert.deepEqual(plain(modified.cx), { cognitive: 5, cyclo: 7, head: 14, base: 9, test: false });
  assert.deepEqual(plain(added.cx), { cognitive: 5, cyclo: 8, head: 5, base: 0, test: false });
  assert.deepEqual(plain(deleted.cx), { cognitive: -3, cyclo: -4, head: 0, base: 3, test: false });
  assert.equal(template.cx, undefined);
  assert.deepEqual(plain(total), {
    cognitive: 7, cyclo: 11, head: 19, base: 12, files: 3,
    tests: { cognitive: 0, cyclo: 0, head: 0, base: 0, files: 0 },
  });
});

test('conventional test files and helpers are classified without matching similar source names', () => {
  const { isTestPath } = load();
  for (const name of [
    'invoice/tests.py', 'test.py', 'scripts/tests/helpers.py', 'test/support.js',
    'src/__tests__/widget.tsx', '__mocks__/client.js', 'spec/factories/user.rb',
    'specs/widget.js', 'test_orders.py', 'orders_test.py', 'conftest.py',
    'widget.test.tsx', 'widget.spec.js', 'orders_test.go', 'order_spec.rb',
    'src/test/java/Order.java', 'OrderTest.java', 'OrderTests.cs', 'OrderTestCase.java',
    'OrderSpec.scala', 'app\\tests\\helpers.py',
  ]) {
    assert.equal(isTestPath(name), true, name);
  }
  for (const name of ['invoice/models.py', 'contest.py', 'latest.js', 'testimonials.ts', 'specification.rb', 'testing/client.py']) {
    assert.equal(isTestPath(name), false, name);
  }
});

test('added and removed tests do not offset application complexity', () => {
  const { complexityTotals } = load();
  const added = { path: 'invoice/tests.py' }, removed = { path: 'scripts/tests/test_old.py' };
  const total = complexityTotals([
    { f: { path: 'invoice/views.py' }, head: { complex: 3, cyclo: 5 }, base: { complex: 8, cyclo: 9 } },
    { f: added, head: { complex: 12, cyclo: 16 }, base: null },
    { f: removed, head: null, base: { complex: 2, cyclo: 3 } },
    { f: { path: 'tests/README.md' }, head: null, base: null },
  ]);
  assert.deepEqual(plain(total), {
    cognitive: -5, cyclo: -4, head: 3, base: 8, files: 1,
    tests: { cognitive: 10, cyclo: 13, head: 12, base: 2, files: 2 },
  });
  assert.equal(added.cx.cognitive, 12);
  assert.equal(removed.cx.cognitive, -2);
  assert.equal(added.cx.test, true);
});

test('renames classify the merge-base and HEAD paths independently', () => {
  const { complexityTotals } = load();
  for (const [oldPath, newPath, appDelta] of [
    ['helper.py', 'tests/helper.py', -4],
    ['tests/helper.py', 'helper.py', 4],
  ]) {
    const total = complexityTotals([
      { f: { path: newPath }, head: { complex: 4, cyclo: 6 }, base: { complex: 4, cyclo: 6 } },
    ], { [newPath]: oldPath });
    assert.equal(total.cognitive, appDelta);
    assert.equal(total.tests.cognitive, -appDelta);
    assert.equal(total.files, 1);
    assert.equal(total.tests.files, 1);
  }
});

function renderComplexity(scored, collapsed) {
  const { complexityTotals, getHtml } = load();
  const cx = complexityTotals(scored);
  const root = { innerHTML: '' };
  let receive;
  const script = getHtml('N').match(/<script nonce="N">([^]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({
      getState: () => ({ collapsed: { 'r|/repo': collapsed } }),
      postMessage() {},
    }),
    document: { getElementById: () => root, addEventListener() {} },
    window: { addEventListener: (_, handler) => { receive = handler; } },
  });
  receive({ data: { type: 'data', repos: [{
    repoPath: '/repo', name: 'repo', branch: 'feature', totals: { add: 1, del: 0 },
    staged: [], unstaged: [], untracked: [], commits: [],
    vsMaster: { cx, files: scored.map((s) => s.f), totals: { add: 1, del: 0 }, behind: 0, ahead: 1 },
  }] } });
  return root.innerHTML;
}

test('test-only changes show neutral application complexity and a separate test tooltip', () => {
  for (const collapsed of [false, true]) {
    const html = renderComplexity([
      { f: { path: 'tests.py' }, head: { complex: 9, cyclo: 12 }, base: { complex: 2, cyclo: 4 } },
    ], collapsed);
    assert.match(html, /class="cx cx-zero" title="Application cognitive complexity 0 → 0 \(0\)/);
    assert.match(html, /Tests: 2 → 9 \(\+7\), cyclomatic \+8 \(excluded from application total\)/);
    if (!collapsed) {
      assert.match(html, /Test cognitive complexity 2 → 9 \(\+7\)/);
    }
  }
});

test('mixed changes keep the application color and unscored changes hide the total', () => {
  const html = renderComplexity([
    { f: { path: 'views.py' }, head: { complex: 2, cyclo: 3 }, base: { complex: 6, cyclo: 8 } },
    { f: { path: 'tests.py' }, head: { complex: 10, cyclo: 14 }, base: null },
  ], true);
  assert.match(html, /class="cx cx-down" title="Application cognitive complexity 6 → 2 \(−4\)/);
  assert.match(html, /Tests: 0 → 10 \(\+10\)/);
  assert.doesNotMatch(renderComplexity([
    { f: { path: 'README.md' }, head: null, base: null },
  ], true), /class="cx/);
});

test('the webview script still compiles after rendering the template literal', () => {
  const html = load().getHtml('N');
  const script = html.match(/<script nonce="N">([^]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /function cxCell/);
});
