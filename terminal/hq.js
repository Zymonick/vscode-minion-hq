#!/usr/bin/env node
'use strict';
// Minion HQ in a terminal: the extension's collectors, drawn as a tmux sidebar.
// Claude, Codex and diffs open as tmux windows and popups beside it.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const INTEGRATION = '/home/azrael/kylie';
const SETTINGS = path.join(os.homedir(), '.vscode-server', 'data', 'Machine', 'settings.json');
const REFRESH_MS = 15000; // the extension's poll
const TITLE_MS = 2000;
const REPO_CONCURRENCY = 2;
const MESSAGE_MS = 8000;

const C = {
  fg: '#c8ccd4', dim: '#8a919c', white: '#eef0f4', green: '#8fe3a0', red: '#ff8f8f', orange: '#f5b36b',
  yellow: '#e6c35c', cyan: '#7fd6d2', blue: '#8cc4ff', purple: '#c5a3ff', sel: '#232b3b', rule: '#3a4150',
};

const GROUPS = [['rules', 'Rules'], ['code', 'Code'], ['migrations', 'Migrations'], ['checks', 'CI and tests'],
  ['scripts', 'Scripts'], ['docs', 'Docs'], ['other', 'Other'], ['vendor', 'Vendor']];

function readSettings(file = SETTINGS) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// The collectors run unchanged in their own context, as the extension tests load them.
function loadCore(settings) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'extension.js'), 'utf8');
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => settings['scmDiffStats.' + key] ?? fallback }),
      // Sessions started in the integration checkout belong to their PR, as from a workspace folder.
      workspaceFolders: [{ uri: { fsPath: INTEGRATION } }],
    },
    window: { createOutputChannel: () => ({ appendLine() {} }) },
    Uri: { file: (fsPath) => ({ fsPath }) },
  };
  return vm.runInNewContext(source + `
    ;({ git, collectRepo, collectComplexity, exportComplexity, COMPLEXITY_EXPORT_DIR, scanAgents,
      scanTestingSerials, claudeSessionForPr, claudeSessionPid, procStat, agentExecutable, codexSessionForPr,
      codexSessionPid, prepareCodexServer, openShots, compareRepoPaths, excludedPath, fileGroup });
  `, {
    module: { exports: {} }, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name) => (name === 'vscode' ? vscode : require(name)),
  });
}

// ── Drawing ─────────────────────────────────────────────────────────────────

function sgr({ fg, bg, bold } = {}) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');
  return '\x1b[0' + (bold ? ';1' : '') + (fg ? ';38;2;' + rgb(fg) : '') + (bg ? ';48;2;' + rgb(bg) : '') + 'm';
}

const chars = (text) => Array.from(String(text));
const textWidth = (segments) => segments.reduce((n, [text]) => n + chars(text).length, 0);

// One screen line from [text, style] segments, cut with an ellipsis or padded to width.
function line(segments, width, bg) {
  let out = '', used = 0;
  for (const [text, style = {}] of segments) {
    if (used >= width) break;
    let part = chars(text);
    if (used + part.length > width) part = part.slice(0, width - used - 1).concat('…');
    out += sgr({ ...style, bg: style.bg || bg }) + part.join('');
    used += part.length;
  }
  return out + sgr({ bg }) + ' '.repeat(Math.max(0, width - used)) + '\x1b[0m';
}

// Left segments, then right segments flush with the edge; the left side gives way.
function spread(left, right, width, bg) {
  const room = width - textWidth(right);
  const fitted = [];
  let used = 0;
  for (const [text, style] of left) {
    const part = chars(text);
    if (used + part.length > room) {
      if (room - used > 0) fitted.push([part.slice(0, room - used - 1).join('') + '…', style]);
      used = room;
      break;
    }
    fitted.push([text, style]);
    used += part.length;
  }
  return line([...fitted, [' '.repeat(Math.max(0, room - used))], ...right], width, bg);
}

// A path that keeps its file name: …/invoice/forms.py
function tail(text, max) {
  const part = chars(text);
  return part.length <= max ? text : '…' + part.slice(part.length - max + 1).join('');
}

function signed(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v); }

function statusColor(status) {
  if (status === 'ready-to-land') return C.green;
  if (status === 'landed') return C.purple;
  if (status === 'testing') return C.yellow;
  if (status === 'wip') return C.blue;
  if (status === 'status-unavailable') return C.dim;
  return /^blocked|failed/.test(status) ? C.red : C.orange;
}

// Claude titles start with ✳ while idle or waiting and with a spinner while working.
function agentGlyph(title) {
  const first = chars(title || '')[0] || '';
  if (first === '✳') return '✳';
  return first && !/[\p{L}\p{N}\s]/u.test(first) ? '◐' : '';
}

function rowGlyph(state, repo) {
  const own = state.glyphs.get(repo.repoPath) || {};
  const glyph = own.claude || own.codex;
  if (glyph) return [glyph, { fg: glyph === '✳' ? C.cyan : C.yellow }];
  return state.agents[repo.repoPath] ? ['●', { fg: C.dim }] : [' '];
}

function fileGroups(core, files) {
  return GROUPS.map(([key, title]) => ({
    key, title,
    files: files.filter((f) => core.fileGroup(f) === key)
      .sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })),
  })).filter((g) => g.files.length);
}

function repoFiles(repo) {
  return repo.vsMaster ? repo.vsMaster.files : [...repo.staged, ...repo.unstaged, ...repo.untracked];
}

function items(state) {
  const out = [];
  for (const repo of state.repos) {
    out.push({ kind: 'repo', repo, key: repo.repoPath });
    if (!state.open.has(repo.repoPath)) continue;
    for (const group of fileGroups(state.core, repoFiles(repo))) {
      out.push({ kind: 'group', repo, group, key: repo.repoPath + '\0' + group.key });
      for (const file of group.files) out.push({ kind: 'file', repo, file, key: repo.repoPath + '\0\0' + file.path });
    }
  }
  return out;
}

function repoLine(state, repo, width, bg) {
  const pr = repo.pr;
  const status = pr ? pr.status : '';
  const label = pr ? pr.statusLabel || status.replace(/-/g, ' ') : repo.branch;
  const right = [];
  if (pr && status !== 'landed' && pr.conflicts.length) right.push(['⚠ ', { fg: C.orange }]);
  if (repo.vsMaster && repo.vsMaster.behind) right.push(['↓' + repo.vsMaster.behind, { fg: C.red }]);
  const name = chars(repo.name).length > 8 ? tail(repo.name, 8) : repo.name.padEnd(8);
  return spread([rowGlyph(state, repo), [' '], [name + ' ', { fg: C.white, bold: bg === C.sel }],
    [label, { fg: pr ? statusColor(status) : C.dim }]], right.length ? [[' '], ...right] : [], width, bg);
}

function lines(add, del) {
  return [[add ? '+' + add : '0', { fg: add ? C.green : C.dim }], [' '], [del ? '−' + del : '0', { fg: del ? C.red : C.dim }]];
}

function itemLine(state, item, width, selected) {
  const bg = selected ? C.sel : undefined;
  if (item.kind === 'repo') return repoLine(state, item.repo, width, bg);
  if (item.kind === 'group') {
    const total = item.group.files.reduce((t, f) => [t[0] + (f.add || 0), t[1] + (f.del || 0)], [0, 0]);
    return spread([['  ' + item.group.title, { fg: C.white }], [' ' + item.group.files.length, { fg: C.dim }]],
      lines(...total), width, bg);
  }
  const f = item.file;
  const right = f.binary ? [['binary', { fg: C.dim }]] : lines(f.add, f.del);
  const room = Math.max(4, width - 7 - textWidth(right));
  return spread([['    '], [f.letter + ' ', { fg: C.orange }], [tail(f.path, room), { fg: selected ? C.white : C.fg }]],
    [[' '], ...right], width, bg);
}

function detailLines(state, repo, width) {
  const out = [];
  const pr = repo.pr;
  out.push(line([[repo.name + ' ', { fg: C.white, bold: true }],
    [pr && pr.label || repo.branch, { fg: C.white }]], width));
  const v = repo.vsMaster;
  const totals = v ? v.totals : repo.totals;
  const facts = [...lines(totals.add, totals.del)];
  if (pr && pr.estimate) facts.push(['  est ' + signed(pr.estimate.cx), { fg: C.dim }]);
  if (v && v.cx) {
    const over = pr && pr.estimate && v.cx.cognitive > pr.estimate.cx;
    facts.push(['  cx ' + signed(v.cx.cognitive), { fg: over ? C.red : v.cx.cognitive > 0 ? C.orange : C.green }]);
  }
  facts.push(['  ' + repoFiles(repo).length + ' files', { fg: C.dim }]);
  if (pr && pr.shots) facts.push(['  ' + pr.shots.images + ' shots', { fg: C.dim }]);
  out.push(line(facts, width));
  const groups = fileGroups(state.core, repoFiles(repo)).filter((g) => g.key !== 'docs' && g.key !== 'vendor');
  if (groups.length) {
    out.push(line(groups.flatMap((g, i) => {
      const add = g.files.reduce((n, f) => n + (f.add || 0), 0);
      const del = g.files.reduce((n, f) => n + (f.del || 0), 0);
      return [[(i ? '  ' : '') + g.title.split(' ')[0] + ' ', { fg: C.dim }], ...lines(add, del)];
    }), width));
  }
  if (pr && pr.customLabel) out.push(line([['[' + pr.customLabel + ']', { fg: C.dim }]], width));
  if (pr && pr.origin) out.push(line([['(->pr-' + pr.origin + ')', { fg: C.dim }]], width));
  if (pr && pr.conflicts.length && pr.status !== 'landed') {
    out.push(line([['conflicts ' + pr.conflicts.join(', '), { fg: C.orange }]], width));
  }
  for (const reason of (pr && pr.reason || '').split('\n').filter(Boolean)) {
    const owner = /^(Agent|User|Operator[^:]*):/.test(reason);
    out.push(line([[reason, { fg: owner ? C.orange : C.fg }]], width));
  }
  return out;
}

// r refreshes at once; the 15 s poll makes it rarely needed, so the 46-column line leaves it out.
const KEYS = [['↵', 'open'], ['c', 'claude'], ['x', 'codex'], ['d', 'diff'], ['s', 'shots'], ['q', 'quit']];

function draw(state) {
  const width = process.stdout.columns || 46;
  const height = process.stdout.rows || 24;
  const list = items(state);
  state.cursor = Math.max(0, Math.min(state.cursor, list.length - 1));
  const current = list[state.cursor];
  const detail = current ? detailLines(state, current.repo, width).slice(0, Math.max(0, height - 8)) : [];
  const listHeight = Math.max(1, height - 3 - (detail.length ? detail.length + 1 : 0));
  state.top = Math.min(Math.max(state.top, state.cursor - listHeight + 1), state.cursor, Math.max(0, list.length - listHeight));
  state.top = Math.max(0, state.top);
  state.listHeight = listHeight;

  const glyphs = [...state.glyphs.values()].flatMap((g) => [g.claude, g.codex]);
  const ready = state.repos.filter((r) => r.pr && r.pr.status === 'ready-to-land').length;
  const counts = [];
  if (glyphs.includes('◐')) counts.push(['◐' + glyphs.filter((g) => g === '◐').length + ' ', { fg: C.yellow }]);
  if (glyphs.includes('✳')) counts.push(['✳' + glyphs.filter((g) => g === '✳').length + ' ', { fg: C.cyan }]);
  if (ready) counts.push(['✓' + ready, { fg: C.green }]);
  const out = [spread([[' MINION HQ ', { fg: '#14161b', bg: C.purple, bold: true }]], counts, width)];
  const message = state.message;
  out.push(line(message ? [[message.text, { fg: message.error ? C.red : C.dim }]]
    : state.repos.length ? [] : [['reading worktrees…', { fg: C.dim }]], width));
  for (let i = 0; i < listHeight; i++) {
    const index = state.top + i;
    out.push(list[index] ? itemLine(state, list[index], width, index === state.cursor) : line([], width));
  }
  if (detail.length) out.push(line([['─'.repeat(width), { fg: C.rule }]], width), ...detail);
  out.push(line(KEYS.flatMap(([key, name], i) => [[(i ? ' ' : '') + key, { fg: C.white, bold: true }], [' ' + name, { fg: C.dim }]]), width));
  process.stdout.write('\x1b[H' + out.join('\r\n'));
}

// ── Scanning ────────────────────────────────────────────────────────────────

async function pool(count, visit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(REPO_CONCURRENCY, count) }, async () => {
    while (next < count) await visit(next++);
  }));
}

// Every worktree of the integration checkout except the checkout itself, in the panel's order.
async function discover(state) {
  const out = await state.core.git(INTEGRATION, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim())
    .filter((p) => p && p !== INTEGRATION && fs.existsSync(p) && !state.core.excludedPath(p, state.patterns))
    .sort(state.core.compareRepoPaths);
}

// The extension's refresh: basic rows first, complexity after; a request during a scan runs one more.
async function refresh(state) {
  state.pending = true;
  if (state.scanning) return;
  state.scanning = true;
  try {
    while (state.pending) {
      state.pending = false;
      const { core } = state;
      const repos = await discover(state);
      state.agents = core.scanAgents(repos);
      const testing = core.scanTestingSerials(repos.filter((r) => /^pr-\d+$/.test(path.basename(r))));
      const previous = new Map(state.repos.map((r) => [r.repoPath, r]));
      const results = new Array(repos.length);
      const publish = () => {
        state.repos = repos.map((r, i) => (results[i] === undefined ? previous.get(r) : results[i])).filter(Boolean);
        draw(state);
      };
      await pool(repos.length, async (i) => {
        results[i] = await core.collectRepo(repos[i], testing).catch(() => null);
        const v = results[i] && results[i].vsMaster;
        const old = previous.get(repos[i])?.vsMaster;
        if (v && old && v.headSha === old.headSha && v.mergeBase === old.mergeBase) {
          v.cx = old.cx;
          const scores = new Map(old.files.map((f) => [f.path, f.cx]));
          for (const f of v.files) f.cx = scores.get(f.path);
        }
        publish();
      });
      if (!repos.length) publish();
      await pool(repos.length, async (i) => {
        const d = results[i];
        if (!d || !d.vsMaster) return;
        const v = d.vsMaster;
        v.cx = await core.collectComplexity(d.repoPath, v.mergeBase, v.files, v.renames, v.vendorRoots).catch(() => null);
        core.exportComplexity(core.COMPLEXITY_EXPORT_DIR, d.repoPath, v);
        publish();
      });
    }
  } catch (error) {
    say(state, 'refresh: ' + error.message, true);
  } finally {
    state.scanning = false;
  }
}

// ── tmux ────────────────────────────────────────────────────────────────────

function tmux(args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    cp.execFile('tmux', args, { timeout }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(stdout));
  });
}

const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// The shell command of an agent window: env -u for null values, then the assignments.
function shellCommand(argv, env) {
  const entries = Object.entries(env);
  const unset = entries.filter(([, v]) => v === null).map(([k]) => '-u ' + k);
  const set = entries.filter(([, v]) => v !== null).map(([k, v]) => k + '=' + quote(v));
  return ['exec env', ...unset, ...set, ...argv.map(quote)].join(' ');
}

async function agentPanes() {
  const out = await tmux(['list-panes', '-a', '-F',
    '#{pane_id}\t#{pane_pid}\t#{@minion_pr}\t#{@minion_agent}\t#{pane_title}']);
  return out.split('\n').filter(Boolean).map((row) => {
    const [id, pid, repo, agent, ...title] = row.split('\t');
    return { id, pid: +pid, repo, agent, title: title.join('\t') };
  });
}

// The pane whose process tree holds pid.
function paneHolding(core, panes, pid) {
  const tree = new Set();
  for (let p = pid; p > 1 && !tree.has(p);) {
    tree.add(p);
    try { p = core.procStat(p).ppid; } catch { break; }
  }
  return panes.find((pane) => tree.has(pane.pid)) || null;
}

async function focus(pane) {
  await tmux(['switch-client', '-t', pane]);
  await tmux(['select-pane', '-t', pane]);
}

// Agents run as the window's process; the pane options tie the window to its PR.
async function launch(repo, agent, cwd, argv, env) {
  const name = agent === 'claude' ? repo.name : repo.name + ' codex';
  const pane = (await tmux(['new-window', '-P', '-F', '#{pane_id}', '-n', name, '-c', cwd, shellCommand(argv, env)])).trim();
  await tmux(['set-option', '-p', '-t', pane, '@minion_pr', repo.repoPath]);
  await tmux(['set-option', '-p', '-t', pane, '@minion_agent', agent]);
}

// The Claude per PR rules of the panel, with tmux windows for terminals.
async function openClaude(state, repo) {
  const { core } = state;
  const panes = await agentPanes();
  const own = panes.find((p) => p.repo === repo.repoPath && p.agent === 'claude');
  if (own) return focus(own.id);
  const session = core.claudeSessionForPr(repo.repoPath, repo.pr.serial);
  const pid = session && core.claudeSessionPid(session.id);
  if (pid) {
    const pane = paneHolding(core, panes, pid);
    if (pane) return focus(pane.id);
    return say(state, `The Claude session of ${repo.name} runs outside tmux (pid ${pid}).`);
  }
  const claude = core.agentExecutable('claude');
  if (!claude) throw new Error('the claude CLI is not on PATH or in ~/.local/bin');
  await launch(repo, 'claude', session ? session.cwd : repo.repoPath,
    [claude, ...(session ? ['--resume', session.id, 'continue'] : [])], { MINION_HQ_CLAUDE_PR: repo.repoPath });
}

// The Codex per PR rules of the panel, with tmux windows for terminals.
async function openCodex(state, repo) {
  const { core } = state;
  const panes = await agentPanes();
  const own = panes.find((p) => p.repo === repo.repoPath && p.agent === 'codex');
  if (own) return focus(own.id);
  const session = await core.codexSessionForPr(repo.repoPath, repo.pr.serial);
  const pid = session && core.codexSessionPid(session);
  const running = pid && paneHolding(core, panes, pid);
  if (running) return focus(running.id);
  const runtime = session && session.runtime;
  const preferred = runtime && typeof runtime.executable === 'string' && path.isAbsolute(runtime.executable) ? runtime.executable : null;
  const executable = core.agentExecutable('codex', preferred);
  if (!executable) throw new Error('the codex CLI is not on PATH or in ~/.local/bin');
  const args = ['--remote', 'unix://', '--approve-for-me',
    '-c', `tui.terminal_title=["activity","${session ? 'thread-title' : 'current-dir'}"]`];
  const cwd = session ? session.cwd : repo.repoPath;
  const env = { MINION_HQ_CODEX_PR: repo.repoPath };
  if (session) {
    const sqliteHome = runtime ? runtime.CODEX_SQLITE_HOME : process.env.CODEX_SQLITE_HOME;
    Object.assign(env, { CODEX_HOME: session.home,
      CODEX_SQLITE_HOME: typeof sqliteHome === 'string' && path.isAbsolute(sqliteHome) ? sqliteHome : null });
  }
  await core.prepareCodexServer(executable, { cwd, env });
  await launch(repo, 'codex', cwd, [executable, ...(session ? ['resume', ...args, session.id] : args)], env);
}

// The diff the panel opens for a file, or the whole branch without one.
function diffCommand(repo, file) {
  const git = 'git -c color.ui=always';
  const v = repo.vsMaster;
  if (file && file.untracked) return `${git} diff --no-index -- /dev/null ${quote(file.path)}`;
  if (!v) return `${git} diff HEAD` + (file ? ' -- ' + quote(file.path) : '');
  if (!file) return `${git} diff --find-renames ${v.mergeBase}`;
  const base = v.renames[file.path];
  return `${git} diff --find-renames ${v.mergeBase} -- ${base ? quote(base) + ' ' : ''}${quote(file.path)}`;
}

// The popup command returns when the popup closes, so the sidebar does not wait for it.
function openDiff(state, repo, file) {
  if (!process.env.TMUX) return say(state, 'Start Minion HQ with minion-hq to open diffs in tmux.', true);
  tmux(['display-popup', '-E', '-w', '90%', '-h', '90%', '-d', repo.repoPath, diffCommand(repo, file) + ' | less -R'], 0)
    .catch((error) => say(state, error.message, true));
}

// Each agent window shows its agent's glyph in the status bar and in its PR row.
async function pollTitles(state) {
  let panes;
  try { panes = await agentPanes(); } catch { return; }
  const glyphs = new Map();
  for (const pane of panes) {
    if (!pane.repo || !pane.agent) continue;
    const glyph = agentGlyph(pane.title);
    glyphs.set(pane.repo, { ...glyphs.get(pane.repo), [pane.agent]: glyph });
    if (state.paneGlyphs.get(pane.id) !== glyph) {
      state.paneGlyphs.set(pane.id, glyph);
      tmux(['set-option', '-w', '-t', pane.id, '@minion_glyph', glyph]).catch(() => {});
    }
  }
  if (JSON.stringify([...glyphs]) !== JSON.stringify([...state.glyphs])) {
    state.glyphs = glyphs;
    draw(state);
  }
}

// ── Input ───────────────────────────────────────────────────────────────────

function say(state, text, error = false) {
  state.message = { text, error };
  clearTimeout(state.messageTimer);
  state.messageTimer = setTimeout(() => { state.message = null; draw(state); }, MESSAGE_MS);
  draw(state);
}

function move(state, step) {
  const list = items(state);
  let i = state.cursor;
  do { i += step; } while (list[i] && list[i].kind === 'group');
  if (list[i]) state.cursor = i;
}

async function act(state, key) {
  const list = items(state);
  const item = list[state.cursor];
  const repo = item && item.repo;
  if (key === 'q' || key === '\x03') return quit();
  if (key === 'r') return refresh(state);
  if (key === 'up' || key === 'k') return move(state, -1);
  if (key === 'down' || key === 'j') return move(state, 1);
  if (key === 'pageup') return move(state, -state.listHeight);
  if (key === 'pagedown') return move(state, state.listHeight);
  if (!repo) return;
  if (key === 'enter' || key === 'right' || key === 'l') {
    if (item.kind === 'file') return openDiff(state, repo, item.file);
    if (state.open.has(repo.repoPath) && key === 'enter') state.open.delete(repo.repoPath);
    else state.open.add(repo.repoPath);
  } else if (key === 'left' || key === 'h') {
    state.open.delete(repo.repoPath);
    state.cursor = items(state).findIndex((i) => i.key === repo.repoPath);
  } else if (key === 'd') {
    return openDiff(state, repo, item.kind === 'file' ? item.file : null);
  } else if ('cxs'.includes(key)) {
    if (!repo.pr) return say(state, repo.name + ' is not a PR worktree.');
    if (key === 's') return state.core.openShots(repo);
    if (!process.env.TMUX) return say(state, 'Start Minion HQ with minion-hq to open agents in tmux.', true);
    return key === 'c' ? openClaude(state, repo) : openCodex(state, repo);
  }
}

const KEY_NAMES = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up',
  '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\r': 'enter' };

// A held arrow key delivers several sequences in one read.
const TOKEN = /\x1b\[<[\d;]+[Mm]|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-D]|[\s\S]/g;

function onInput(state, data) {
  for (const [token] of data.toString('utf8').matchAll(TOKEN)) {
    const click = token.match(/^\x1b\[<0;\d+;(\d+)M$/);
    if (click) {
      // Screen rows 1 and 2 hold the header and the message; the list starts at row 3.
      const index = state.top + (+click[1] - 3);
      if (+click[1] < 3 || index >= state.top + state.listHeight || !items(state)[index]) continue;
      const again = index === state.cursor;
      state.cursor = index;
      if (again) handle(state, 'enter');
      else draw(state);
    } else if (!token.startsWith('\x1b[<')) {
      handle(state, KEY_NAMES[token] || token);
    }
  }
}

function handle(state, key) {
  const item = items(state)[state.cursor];
  Promise.resolve(act(state, key)).then(() => {
    // Selection stays on the same row when rows open, close or arrive.
    if (item && key !== 'up' && key !== 'down' && key !== 'k' && key !== 'j' && !/^page/.test(key)) {
      const kept = items(state).findIndex((i) => i.key === item.key);
      if (kept >= 0 && key !== 'left' && key !== 'h') state.cursor = kept;
    }
    draw(state);
  }, (error) => say(state, error.message, true));
}

function quit() {
  process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
  process.exit(0);
}

function main() {
  const settings = readSettings();
  const excluded = settings['scmDiffStats.excludePaths'];
  const state = {
    core: loadCore(settings), patterns: Array.isArray(excluded) ? excluded : [],
    repos: [], open: new Set(), cursor: 0, top: 0, listHeight: 1,
    agents: {}, glyphs: new Map(), paneGlyphs: new Map(), message: null,
  };
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b]2;Minion HQ\x07');
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  process.stdout.on('resize', () => draw(state));
  process.stdin.setRawMode(true);
  process.stdin.on('data', (data) => onInput(state, data));
  draw(state);
  refresh(state);
  setInterval(() => refresh(state), REFRESH_MS);
  if (process.env.TMUX) {
    pollTitles(state);
    setInterval(() => pollTitles(state), TITLE_MS);
  }
}

if (require.main === module) main();

module.exports = { agentGlyph, diffCommand, fileGroups, line, loadCore, shellCommand, spread, statusColor, tail };
