const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const hq = require('../hq.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('agent glyphs follow the title prefix of Claude and Codex', () => {
  assert.equal(hq.agentGlyph('✳ pr-7 [wip] clear review status'), '✳');
  assert.equal(hq.agentGlyph('◐ pr-7 [wip] clear review status'), '◐');
  assert.equal(hq.agentGlyph('⠋ codex'), '◐');
  assert.equal(hq.agentGlyph('bash'), '');
  assert.equal(hq.agentGlyph(''), '');
});

test('lines fill the width and cut with an ellipsis', () => {
  assert.equal(plain(hq.line([['abc']], 6)), 'abc   ');
  assert.equal(plain(hq.line([['abcdefgh']], 6)), 'abcde…');
  assert.equal(plain(hq.spread([['pr-7 blocked: awaiting schema']], [['↓12']], 20)), 'pr-7 blocked: aw…↓12');
  assert.equal(hq.tail('invoice/templates/invoice/x.html', 12), '…oice/x.html');
});

test('status colours separate ready, blocked and outdated work', () => {
  assert.notEqual(hq.statusColor('ready-to-land'), hq.statusColor('blocked'));
  assert.equal(hq.statusColor('blocked'), hq.statusColor('checks-failed'));
  assert.notEqual(hq.statusColor('checks-outdated'), hq.statusColor('blocked'));
});

test('agent windows run the CLI directly with quoted arguments', () => {
  assert.equal(hq.shellCommand(['/bin/claude', '--resume', "it's", 'continue'], { A: '/x y', B: null }),
    "exec env -u B A='/x y' '/bin/claude' '--resume' 'it'\\''s' 'continue'");
});

test('diffs run from the merge base, with rename sources and untracked files', () => {
  const repo = { vsMaster: { mergeBase: 'abc', renames: { 'new.py': 'old.py' } } };
  assert.equal(hq.diffCommand(repo, null), 'git -c color.ui=always diff --find-renames abc');
  assert.equal(hq.diffCommand(repo, { path: 'new.py' }), "git -c color.ui=always diff --find-renames abc -- 'old.py' 'new.py'");
  assert.equal(hq.diffCommand(repo, { path: 'n.txt', untracked: true }), "git -c color.ui=always diff --no-index -- /dev/null 'n.txt'");
  assert.equal(hq.diffCommand({ vsMaster: null }, { path: 'a.py' }), "git -c color.ui=always diff HEAD -- 'a.py'");
});

test('file groups keep the panel order', () => {
  const core = hq.loadCore({});
  const groups = hq.fileGroups(core, [{ path: 'docs/PR_7/spec.md' }, { path: 'app/views.py' }, { path: 'AGENTS.md' },
    { path: 'app/tests/test_views.py' }]);
  assert.deepEqual(groups.map((g) => g.key), ['rules', 'code', 'checks', 'docs']);
});

const hasTmux = cp.spawnSync('tmux', ['-V']).status === 0;

test('the sidebar follows the window that shows', { skip: !hasTmux && 'tmux is not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-tmux-'));
  const env = { ...process.env, TMUX_TMPDIR: dir, NODE_BIN: path.join(dir, 'stub') };
  delete env.TMUX;
  fs.writeFileSync(env.NODE_BIN, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  const tmux = (...args) => cp.execFileSync('tmux', args, { env, encoding: 'utf8' }).trim();
  t.after(() => {
    cp.spawnSync('tmux', ['kill-server'], { env });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  tmux('new-session', '-d', '-s', 'kylie', '-x', '120', '-y', '30');
  // The launcher ends by attaching, which needs a terminal; the session is set up before that.
  cp.spawnSync(path.join(__dirname, '..', 'minion-hq'), [], { env, stdio: 'ignore' });
  const sidebar = () => tmux('list-panes', '-s', '-t', 'kylie', '-F', '#{@minion_hq} #{window_index} #{pane_left} #{pane_width}')
    .split('\n').filter((row) => row.startsWith('1 '));
  assert.deepEqual(sidebar(), ['1 0 0 46']);
  tmux('new-window', '-t', 'kylie');
  for (let i = 0; i < 30 && sidebar()[0] !== '1 1 0 46'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sidebar(), ['1 1 0 46']);
  assert.match(tmux('show-options', '-w', '-t', 'kylie:1', 'window-status-format'), /@minion_glyph/);
});
