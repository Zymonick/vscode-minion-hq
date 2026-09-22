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
  return vm.runInNewContext(source + '\n({ parseQltyTable, qltyExt, complexityTotals, getHtml });', {
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
  assert.deepEqual(plain(modified.cx), { cognitive: 5, cyclo: 7, head: 14, base: 9 });
  assert.deepEqual(plain(added.cx), { cognitive: 5, cyclo: 8, head: 5, base: 0 });
  assert.deepEqual(plain(deleted.cx), { cognitive: -3, cyclo: -4, head: 0, base: 3 });
  assert.equal(template.cx, undefined);
  assert.deepEqual(plain(total), { cognitive: 7, cyclo: 11, head: 19, base: 12, files: 3 });
});

test('the webview script still compiles after rendering the template literal', () => {
  const html = load().getHtml('N');
  const script = html.match(/<script nonce="N">([^]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /function cxCell/);
});
