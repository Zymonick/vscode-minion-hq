const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// The Terminals view with a stub window, tree view and interval timer.
function fixture() {
  const fired = [], revealed = [], shown = [], intervals = new Map();
  let nextTimer = 0;
  class EventEmitter {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire(value) { fired.push(value); }
  }
  class TreeItem { constructor(label) { this.label = label; } }
  class ThemeIcon { constructor(id) { this.id = id; } }
  const terminal = (name) => ({ name, show(preserveFocus) { shown.push(this.name + (preserveFocus ? ' (no focus)' : '')); } });
  const vscode = { EventEmitter, TreeItem, ThemeIcon, window: { terminals: [], activeTerminal: undefined } };
  const api = vm.runInNewContext(source + '\n({ TerminalList });', {
    module: { exports: {} }, Buffer, setTimeout, clearTimeout, process,
    setInterval: (fn, ms) => { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval: (id) => intervals.delete(id),
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  let visibility;
  const view = { visible: false, reveal: async (element, options) => { revealed.push([element.name, options]); },
    onDidChangeVisibility: (listener) => { visibility = listener; return { dispose() {} }; } };
  const show = (visible) => { view.visible = visible; visibility(); };
  return { list: new api.TerminalList(), vscode, terminal, view, show, fired, revealed, shown, intervals };
}

test('the Terminals view lists every terminal of the window in opening order, and a click shows it', () => {
  const f = fixture();
  const local = f.terminal('bash local'), claude = f.terminal('✳ pr-7 ci [wip] three words');
  f.vscode.window.terminals.push(local, claude);
  assert.deepEqual([...f.list.getChildren()], [local, claude]);
  assert.equal(f.list.getChildren(local).length, 0);
  assert.equal(f.list.getParent(claude), undefined);
  const items = [...f.list.getChildren()].map((t) => f.list.getTreeItem(t));
  assert.deepEqual(items.map((i) => i.label), ['bash local', '✳ pr-7 ci [wip] three words']);
  assert.deepEqual(items.map((i) => i.iconPath.id), ['terminal', 'terminal']);
  assert.equal(new Set(items.map((i) => i.id)).size, 2);
  assert.equal(f.list.getTreeItem(local).id, items[0].id, 'a terminal keeps its row id, so its selection survives a redraw');
  assert.equal(items[1].command.command, 'scmDiffStats.showTerminal');
  assert.deepEqual([...items[1].command.arguments], [claude]);
});

test('a visible Terminals view compares names each second and redraws only renamed rows; a hidden one runs no timer', () => {
  const f = fixture();
  const a = f.terminal('◐ pr-7 working'), b = f.terminal('bash prd');
  f.vscode.window.terminals.push(a, b);
  f.vscode.window.terminals.forEach((t) => f.list.getTreeItem(t));
  f.list.watch(f.view);
  assert.equal(f.intervals.size, 0, 'a hidden view must not poll');
  f.show(true);
  assert.deepEqual([...f.intervals.values()].map((i) => i.ms), [1000]);
  const tick = () => [...f.intervals.values()][0].fn();
  tick();
  assert.deepEqual(f.fired, [], 'unchanged names redraw nothing');
  a.name = '✳ pr-7 idle';
  tick();
  assert.deepEqual(f.fired.map((v) => [...v]), [[a]]);
  f.list.getTreeItem(a);
  tick();
  assert.equal(f.fired.length, 1, 'a drawn name is not redrawn again');
  f.show(false);
  assert.equal(f.intervals.size, 0, 'hiding the view stops its timer');
});

test('the active terminal is selected without focus, only while the view is visible', async () => {
  const f = fixture();
  const a = f.terminal('bash local'), b = f.terminal('✳ pr-7');
  f.vscode.window.terminals.push(a, b);
  f.vscode.window.activeTerminal = b;
  f.list.watch(f.view);
  f.list.selectActive();
  assert.deepEqual(f.revealed, [], 'a hidden view must not open itself');
  f.show(true);
  f.vscode.window.activeTerminal = a;
  f.list.selectActive();
  assert.deepEqual(JSON.parse(JSON.stringify(f.revealed)), [['✳ pr-7', { select: true, focus: false }], ['bash local', { select: true, focus: false }]]);
});
