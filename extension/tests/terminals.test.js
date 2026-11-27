const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

// The terminal list with a stub window and commands. `modules` replaces Node
// modules of the extension, such as fs and child_process.
function fixture(modules = {}) {
  const shown = [], commands = new Map();
  const vscode = {
    window: { terminals: [], activeTerminal: undefined },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; } },
  };
  const terminal = (name, extra = {}) => ({
    name, ...extra,
    show() { shown.push(this.name); vscode.window.activeTerminal = this; },
  });
  const api = vm.runInNewContext(source + '\n({ TerminalList, tmuxTerminals, tmuxAttachOf });', {
    module: { exports: {} }, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name) => name === 'vscode' ? vscode : modules[name] || require(name),
  });
  return { list: new api.TerminalList(), vscode, terminal, shown, commands,
    tmuxTerminals: api.tmuxTerminals, tmuxAttachOf: api.tmuxAttachOf };
}

const look = (f, t) => JSON.parse(JSON.stringify(f.list.look(t)));

test('a terminal has a stable key, and its process name as label when its name is empty, with the folder its process runs in', async (t) => {
  const f = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-terminal-'));
  const child = spawn('sleep', ['30'], { cwd: dir });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const blank = f.terminal('', { processId: Promise.resolve(child.pid) });
  const named = f.terminal('◐ pr-7 working');
  f.vscode.window.terminals.push(blank, named);
  const key = f.list.track(blank);
  assert.notEqual(f.list.track(named), key);
  assert.equal(f.list.track(blank), key, 'a terminal keeps its key');
  assert.deepEqual(look(f, blank), { label: 'terminal', cwd: '' }, 'before the pid is known');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(look(f, blank), { label: 'sleep', cwd: fs.realpathSync(dir) });
  assert.deepEqual(look(f, named), { label: '◐ pr-7 working', cwd: '' });
});

test('a tmux client command line names its socket and target', () => {
  const f = fixture();
  const attach = (argv) => JSON.parse(JSON.stringify(f.tmuxAttachOf(argv)));
  assert.deepEqual(attach(['/usr/bin/tmux', '-L', 'claude', 'attach-session', '-t', '=claude-kylie-3']),
    { socket: ['-L', 'claude'], target: '=claude-kylie-3' });
  assert.deepEqual(attach(['tmux', '-S', '/tmp/tmux-1000/default', 'attach', '-t', '%0']),
    { socket: ['-S', '/tmp/tmux-1000/default'], target: '%0' });
  assert.equal(f.tmuxAttachOf(['/bin/bash', '--init-file', 'x']), null);
  assert.equal(f.tmuxAttachOf(['/usr/bin/tmux', '-L', 'claude', 'new-session']), null);
});

test('a terminal that shows a tmux pane has its title and folder, read with one tmux call per socket', async (t) => {
  // Terminals: VS Code restored kylie-3 with an empty name and pid 4040; the
  // agent scan found kylie-9 below its shell; pid 4041 attaches a pane of the
  // default socket; pid 4042 is a plain shell without a name.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-tmux-'));
  fs.writeFileSync(path.join(bin, 'tmux'), '', { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = PATH; fs.rmSync(bin, { recursive: true, force: true }); });
  const proc = {
    4040: { cmdline: ['/usr/bin/tmux', '-L', 'claude', 'attach-session', '-t', '=claude-kylie-3'], cwd: '/home/u/kylie', comm: 'tmux' },
    4041: { cmdline: ['/usr/bin/tmux', '-S', '/tmp/tmux-1000/default', 'attach-session', '-t', '%0'], cwd: '/home/u/kylie', comm: 'tmux' },
    4042: { cmdline: ['/bin/bash', '--init-file', 'x'], cwd: '/home/u/kylie', comm: 'bash' },
    4043: { cmdline: ['/bin/bash', '--init-file', 'x'], cwd: '/home/u/.local/state/claude-tmux/claude-kylie-9', comm: 'bash' },
  };
  const entry = (file, field) => { const m = /^\/proc\/(\d+)\/(\w+)$/.exec(file); return m && m[2] === field ? proc[m[1]] : null; };
  const stubFs = { ...fs,
    readFileSync: (file, ...rest) => entry(file, 'cmdline') ? entry(file, 'cmdline').cmdline.join('\0') + '\0'
      : entry(file, 'comm') ? entry(file, 'comm').comm + '\n' : fs.readFileSync(file, ...rest),
    readlinkSync: (file, ...rest) => entry(file, 'cwd') ? entry(file, 'cwd').cwd : fs.readlinkSync(file, ...rest) };
  const calls = [], pending = [];
  const output = {
    '-L claude': 'claude-kylie-3\t%3\t11\t/home/u/kylie-worktrees/pr-1316\t✳ pr-1316 leaveMgmt\n'
      + 'claude-kylie-9\t%9\t11\t/home/u/kylie\t◐ Image attachment\n',
    '-S /tmp/tmux-1000/default': 'claude\t%0\t11\t/home/u/ops\t✳ pr-1311 ci [landed]\ntest\t%1\t11\t/home/u\tminion-factory\n',
  };
  const execFile = (file, args, options, done) => {
    calls.push([path.basename(file), ...args.slice(2)].join(' ').replace(/ -F .*/, '') + ' ' + args.slice(0, 2).join(' '));
    pending.push(() => done(null, output[args.slice(0, 2).join(' ')]));
  };
  const f = fixture({ fs: stubFs, child_process: { ...require('node:child_process'), execFile } });
  const kylie3 = f.terminal('', { processId: Promise.resolve(4040) });
  const kylie9 = f.terminal('✳ Claude Code', { processId: Promise.resolve(4043) });
  const remote = f.terminal('tmux', { processId: Promise.resolve(4041) });
  const plain = f.terminal('', { processId: Promise.resolve(4042) });
  f.vscode.window.terminals.push(kylie3, kylie9, remote, plain);
  f.tmuxTerminals.set(kylie9, 'claude-kylie-9');
  f.vscode.window.terminals.forEach((terminal) => f.list.track(terminal));
  await new Promise((resolve) => setImmediate(resolve));
  let read = 0;
  f.list.readPanes(() => read++);
  assert.deepEqual(calls, ['tmux list-panes -a -L claude', 'tmux list-panes -a -S /tmp/tmux-1000/default']);
  f.list.readPanes(() => read++);
  assert.equal(calls.length, 2, 'a read that still runs skips the next one');
  pending.splice(0).forEach((reply) => reply());
  assert.equal(read, 1, 'the end of a read calls back once');
  assert.deepEqual(f.vscode.window.terminals.map((terminal) => look(f, terminal)), [
    { label: '✳ pr-1316 leaveMgmt', cwd: '/home/u/kylie-worktrees/pr-1316' },
    { label: '◐ Image attachment', cwd: '/home/u/kylie' },
    { label: '✳ pr-1311 ci [landed]', cwd: '/home/u/ops' },
    { label: 'bash', cwd: '/home/u/kylie' },
  ]);
});

test('Ctrl+PageDown and Ctrl+PageUp in a terminal follow the order of the Minion HQ rows, then opening order, skip a hidden terminal and wrap around', () => {
  const f = fixture();
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => f.terminal(n));
  const install = f.terminal('install', { creationOptions: { hideFromUser: true } });
  f.vscode.window.terminals.push(a, install, b, c, d);
  f.list.order = [c, a, b].map((t) => f.list.track(t)).concat('terminal-gone');
  f.list.commands();
  const next = f.commands.get('scmDiffStats.terminal.focusNext'), previous = f.commands.get('scmDiffStats.terminal.focusPrevious');
  next();
  assert.equal(f.vscode.window.activeTerminal, c, 'without an active terminal, the first row');
  next(); next(); next(); next();
  assert.deepEqual(f.shown, ['c', 'a', 'b', 'd', 'c']);
  previous();
  assert.equal(f.vscode.window.activeTerminal, d);
});

test('when the active terminal closes, the terminal of the next row below shows, or of the nearest row above after the last row', () => {
  const f = fixture();
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((n) => f.terminal(n));
  f.vscode.window.terminals.push(a, b, c, d, e);
  f.list.order = [c, a, b, d].map((t) => f.list.track(t));
  const close = (t) => { f.vscode.window.terminals.splice(f.vscode.window.terminals.indexOf(t), 1); f.list.closed(t); };
  f.vscode.window.activeTerminal = a;
  close(a);
  assert.deepEqual(f.shown, ['b'], 'the row below, not the next tab in opening order');
  f.vscode.window.activeTerminal = d;
  close(d);
  assert.deepEqual(f.shown, ['b', 'b'], 'after the last row, the nearest row above');
  // VS Code reports its own choice e just before the close of the active b.
  f.list.activeChanged(b);
  f.vscode.window.activeTerminal = e;
  f.list.activeChanged(e);
  close(b);
  assert.deepEqual(f.shown, ['b', 'b', 'c']);
  close(e);
  assert.deepEqual(f.shown, ['b', 'b', 'c'], 'a terminal that closes while another is active changes nothing');
});

test('the manifest has no Terminals view, keeps the cycling keys and hides the terminal tab list', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).contributes;
  assert.deepEqual(manifest.views.diffStats.map((v) => v.id), ['scmDiffStats']);
  assert.deepEqual(manifest.keybindings.map((k) => [k.key, k.command, k.when]), [
    ['ctrl+pagedown', 'scmDiffStats.terminal.focusNext', 'terminalFocus && !terminalEditorFocus'],
    ['ctrl+pageup', 'scmDiffStats.terminal.focusPrevious', 'terminalFocus && !terminalEditorFocus'],
  ]);
  assert.equal(manifest.configurationDefaults['terminal.integrated.tabs.enabled'], false);
});
