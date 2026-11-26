const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// The Terminals view with a stub window, commands, tree view and interval
// timer. A timeout runs at once, after the current microtasks.
function fixture() {
  const fired = [], revealed = [], shown = [], executed = [], disposed = [], intervals = new Map();
  const commands = new Map(), activeListeners = new Set();
  let nextTimer = 0;
  class EventEmitter {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire(value) { fired.push(value); }
  }
  class TreeItem { constructor(label) { this.label = label; } }
  class ThemeIcon { constructor(id) { this.id = id; } }
  const vscode = {
    EventEmitter, TreeItem, ThemeIcon,
    window: {
      terminals: [], activeTerminal: undefined,
      onDidChangeActiveTerminal: (listener) => { activeListeners.add(listener); return { dispose: () => activeListeners.delete(listener) }; },
    },
    commands: {
      registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; },
      executeCommand: async (id) => { executed.push([id, vscode.window.activeTerminal && vscode.window.activeTerminal.name]); },
    },
  };
  const activate = (t) => { vscode.window.activeTerminal = t; activeListeners.forEach((l) => l(t)); };
  // A terminal that becomes active when shown, unless `stuck`.
  const terminal = (name, extra = {}) => ({
    name, ...extra,
    show(preserveFocus) { shown.push(this.name + (preserveFocus ? ' (no focus)' : '')); if (!this.stuck) activate(this); },
    dispose() { disposed.push(this.name); },
  });
  const api = vm.runInNewContext(source + '\n({ TerminalList });', {
    module: { exports: {} }, Buffer, process, clearTimeout,
    setTimeout: (fn) => { Promise.resolve().then(() => Promise.resolve()).then(fn); return 0; },
    setInterval: (fn, ms) => { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval: (id) => intervals.delete(id),
    require: (name) => name === 'vscode' ? vscode : require(name),
  });
  let visibility;
  const view = { visible: false, selection: [], reveal: async (element, options) => { revealed.push([element.name, options]); },
    onDidChangeVisibility: (listener) => { visibility = listener; return { dispose() {} }; } };
  const show = (visible) => { view.visible = visible; visibility(); };
  const list = new api.TerminalList();
  return { list, vscode, terminal, view, show, fired, revealed, shown, executed, disposed, intervals, commands, activate };
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

test('a row shows the folder its process runs in, its process name when the name is empty, and a spinning icon while busy', async (t) => {
  const f = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-terminal-'));
  const child = spawn('sleep', ['30'], { cwd: dir });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const blank = f.terminal('', { processId: Promise.resolve(child.pid) });
  const busy = f.terminal('◐ pr-7 working');
  f.vscode.window.terminals.push(blank, busy);
  assert.equal(f.list.getTreeItem(blank).label, 'terminal', 'before the pid is known');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.fired.map((v) => [...v]), [[blank]], 'a known pid redraws the row');
  const item = f.list.getTreeItem(blank);
  assert.equal(item.label, 'sleep');
  assert.equal(item.description, path.basename(dir));
  assert.equal(item.tooltip, 'sleep\n' + fs.realpathSync(dir));
  assert.equal(item.iconPath.id, 'terminal');
  assert.equal(f.list.getTreeItem(busy).iconPath.id, 'loading~spin');
  busy.name = '✳ pr-7 idle';
  f.list.compareNames();
  assert.deepEqual(f.fired.slice(1).map((v) => [...v]), [[busy]], 'the end of a busy title redraws its row');
  assert.equal(f.list.getTreeItem(busy).iconPath.id, 'terminal');
});

test('a row action applies to the selection that holds the clicked row, else to the clicked row, and from a key to the selection', () => {
  const f = fixture();
  const a = f.terminal('a'), b = f.terminal('b'), c = f.terminal('c');
  f.list.watch(f.view);
  f.list.commands();
  const kill = f.commands.get('scmDiffStats.terminal.kill');
  kill(a, [a, b]);
  assert.deepEqual(f.disposed, ['a', 'b']);
  kill(c, [a, b]);
  assert.deepEqual(f.disposed.slice(2), ['c'], 'a right-click outside the selection acts on the clicked row only');
  f.view.selection = [b];
  kill();
  assert.deepEqual(f.disposed.slice(3), ['b'], 'Delete in the view kills the selection');
});

test('a row action shows its terminal and runs VS Code tab action on it once it is active, and never on another terminal', async () => {
  const f = fixture();
  const local = f.terminal('bash local'), claude = f.terminal('✳ pr-7');
  f.activate(local);
  f.list.commands();
  const expected = ['split', 'changeColor', 'changeIcon', 'rename', 'sizeToContentWidth', 'moveToEditor', 'moveIntoNewWindow', 'unsplit'];
  for (const name of [...expected, 'kill']) assert.ok(f.commands.has('scmDiffStats.terminal.' + name), name);
  await f.commands.get('scmDiffStats.terminal.rename')(claude, [claude]);
  assert.deepEqual(f.shown, ['✳ pr-7']);
  assert.deepEqual(f.executed, [['workbench.action.terminal.rename', '✳ pr-7']]);
  await f.commands.get('scmDiffStats.terminal.split')(claude);
  assert.deepEqual(f.shown, ['✳ pr-7'], 'the active terminal is not shown again');
  assert.deepEqual(f.executed[1], ['workbench.action.terminal.split', '✳ pr-7']);
  local.stuck = true;
  await f.commands.get('scmDiffStats.terminal.moveToEditor')(local);
  assert.equal(f.executed.length, 2, 'a terminal that does not become active gets no action, and neither does the active one');
});

test('the manifest offers the tab list actions on each row, split and kill inline, and F2 and Delete in the view', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).contributes;
  const rows = manifest.menus['view/item/context'].filter((m) => m.when === 'view == scmDiffStatsTerminals');
  assert.deepEqual(rows.filter((m) => m.group.startsWith('inline')).map((m) => m.command),
    ['scmDiffStats.terminal.split', 'scmDiffStats.terminal.kill']);
  assert.equal(rows.filter((m) => !m.group.startsWith('inline')).length, 9);
  const hidden = new Set(manifest.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
  for (const m of rows) assert.ok(hidden.has(m.command), m.command + ' needs a row, so the palette hides it');
  assert.deepEqual(manifest.keybindings.map((k) => [k.key, k.command, k.when]), [
    ['f2', 'scmDiffStats.terminal.rename', 'focusedView == scmDiffStatsTerminals'],
    ['delete', 'scmDiffStats.terminal.kill', 'focusedView == scmDiffStatsTerminals'],
  ]);
});
