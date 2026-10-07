const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_CONCURRENCY = 2;
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;

let gitApi = null;

function git(cwd, args) {
  return new Promise((resolve) => {
    // Read-only status checks must not rewrite the index and trigger Git watchers.
    cp.execFile('git', args, {
      cwd, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

function gitFull(cwd, args) {
  return new Promise((resolve) => {
    cp.execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout || '', err: stderr || '' });
    });
  });
}

// Empty-document scheme for diff sides that do not exist at a ref
// (file added or deleted between the two sides).
const EMPTY_SCHEME = 'scm-diff-stats-empty';
const emptyUri = (uri) => uri.with({ scheme: EMPTY_SCHEME });
const REVISION_SCHEME = 'scm-diff-stats-revision';

function readGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', ['--literal-pathspecs', ...args], {
      cwd: repoPath, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = error.killed ? 'Git read timed out.' : String(stderr || error.message).trim();
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function revisionUri(repoPath, ref, relPath) {
  const uri = vscode.Uri.file(path.join(repoPath, relPath));
  if (ref === null) {
    return emptyUri(uri);
  }
  // Resolve to a blob now: even an index snapshot stays stable after another stage/commit.
  const index = ref === '';
  const output = await readGit(repoPath, index
    ? ['ls-files', '--stage', '-z', '--', relPath]
    : ['ls-tree', '-z', ref, '--', relPath]);
  const entry = output.toString().split('\0').find((line) => line.slice(line.indexOf('\t') + 1) === relPath);
  if (!entry) {
    return emptyUri(uri);
  }
  const fields = entry.slice(0, entry.indexOf('\t')).split(' ');
  if (index && fields[2] !== '0') {
    // A conflicted index has multiple stages; keep its working file accessible.
    return revisionUri(repoPath, 'HEAD', relPath);
  }
  if (!index && fields[1] !== 'blob') {
    throw new Error('This entry is not a file.');
  }
  return uri.with({ scheme: REVISION_SCHEME,
    query: JSON.stringify({ repoPath, blob: fields[index ? 1 : 2] }) });
}

function revisionSource(uri) {
  const source = JSON.parse(uri.query);
  if (!path.isAbsolute(source.repoPath) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.blob)) {
    throw new Error('Invalid revision.');
  }
  return source;
}

const revisionFileSystem = {
  watch() { return { dispose() {} }; },
  async stat(uri) {
    const { repoPath, blob } = revisionSource(uri);
    const size = Number((await readGit(repoPath, ['cat-file', '-s', blob])).toString());
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
  },
  readFile(uri) {
    const { repoPath, blob } = revisionSource(uri);
    return readGit(repoPath, ['cat-file', 'blob', blob]);
  },
  readDirectory() { throw vscode.FileSystemError.FileNotADirectory(); },
  createDirectory() { throw vscode.FileSystemError.NoPermissions(); },
  writeFile() { throw vscode.FileSystemError.NoPermissions(); },
  delete() { throw vscode.FileSystemError.NoPermissions(); },
  rename() { throw vscode.FileSystemError.NoPermissions(); },
};

async function workingUri(repoPath, relPath) {
  const uri = vscode.Uri.file(path.join(repoPath, relPath));
  try {
    await fs.promises.stat(uri.fsPath);
    return uri;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return emptyUri(uri);
    }
    throw error;
  }
}

function parseNumstat(out) {
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    const binary = m[1] === '-';
    let p = m[3];
    const r = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/) || p.match(/^(.*) => (.*)$/);
    const oldPath = r ? (r.length === 5 ? r[1] + r[2] + r[4] : r[1]) : null;
    if (r) {
      p = r.length === 5 ? r[1] + r[3] + r[4] : r[2];
    }
    files.push({ path: p, ...(oldPath ? { oldPath } : {}),
      add: binary ? null : +m[1], del: binary ? null : +m[2], binary });
  }
  return files;
}

function parseNameStatus(out) {
  // lines: "M\tpath" or "R100\told\tnew"
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z])\S*\t(.*)$/);
    if (!m) continue;
    const parts = m[2].split('\t');
    map[parts[parts.length - 1]] = m[1];
  }
  return map;
}

// the old path of every rename/copy in `--name-status --find-renames` output,
// keyed by the new path — the base-side name of a moved file
function parseRenames(out) {
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^[RC]\d*\t(.*)\t(.*)$/);
    if (m) map[m[2]] = m[1];
  }
  return map;
}

function isExcludedLinePath(filePath) {
  // Git quotes paths containing non-ASCII or special characters.
  const normalized = filePath.replace(/^"|"$/g, '');
  return normalized.startsWith('docs/') || isVerificationPath(normalized);
}

function sumFiles(files) {
  return files.reduce((total, file) => {
    if (!file.vendorHead && !isExcludedLinePath(file.path)) {
      total.add += file.add || 0;
    }
    if (!file.vendorBase && !isExcludedLinePath(file.oldPath || file.path)) {
      total.del += file.del || 0;
    }
    return total;
  }, { add: 0, del: 0 });
}

async function countLines(file) {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return null;
    const buf = await fs.promises.readFile(file);
    if (buf.includes(0)) return null;
    if (buf.length === 0) return 0;
    let n = 0;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
    if (buf[buf.length - 1] !== 10) n++;
    return n;
  } catch {
    return null;
  }
}

async function collectRepo(repoPath, testing) {
  const [unstagedOut, stagedOut, untrackedOut, branchOut, statusOut] = await Promise.all([
    git(repoPath, ['diff', '--numstat']),
    git(repoPath, ['diff', '--numstat', '--cached']),
    git(repoPath, ['ls-files', '--others', '--exclude-standard']),
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['status', '--porcelain']),
  ]);

  // status letters: index (staged) and worktree columns
  const idxLetter = {}, wtLetter = {};
  for (const line of statusOut.split('\n')) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (line[0] !== ' ' && line[0] !== '?') idxLetter[p] = line[0];
    if (line[1] !== ' ') wtLetter[p] = line[1] === '?' ? 'U' : line[1];
  }

  const branch = branchOut.trim();
  const withLetter = (files, letters, fallback) =>
    files.map((f) => ({ ...f, letter: letters[f.path] || fallback }));
  const unstaged = withLetter(parseNumstat(unstagedOut), wtLetter, 'M');
  const staged = withLetter(parseNumstat(stagedOut), idxLetter, 'M');
  const untracked = [];
  for (const p of untrackedOut.split('\n').filter(Boolean)) {
    const n = await countLines(path.join(repoPath, p));
    untracked.push({ path: p, add: n, del: n == null ? null : 0, binary: n == null, untracked: true, letter: 'U' });
  }
  const declarations = vendorDeclarations(repoPath);
  // Reuse metadata within this scan; index and working files can change between scans.
  const lineRoots = new Map();
  await markLineVendors(repoPath, 'HEAD', '', staged, declarations, lineRoots);
  await markLineVendors(repoPath, '', null, [...unstaged, ...untracked], declarations, lineRoots);

  let vsMaster = null;
  let masterSha = '';
  if (branch && branch !== 'master') {
    const refs = (await git(repoPath, ['rev-parse', '--quiet', 'master', 'HEAD'])).trim().split('\n');
    masterSha = refs[0];
    const headSha = refs[1];
    if (masterSha && headSha) {
      const [behindOut, aheadOut, mbOut, numstatOut, nameStatusOut] = await Promise.all([
        git(repoPath, ['rev-list', '--count', `${headSha}..${masterSha}`]),
        git(repoPath, ['rev-list', '--count', `${masterSha}..${headSha}`]),
        git(repoPath, ['merge-base', headSha, masterSha]),
        git(repoPath, ['diff', '--numstat', '--find-renames', `${masterSha}...${headSha}`]),
        git(repoPath, ['diff', '--name-status', '--find-renames', `${masterSha}...${headSha}`]),
      ]);
      const files = withLetter(parseNumstat(numstatOut), parseNameStatus(nameStatusOut), 'M');
      const mergeBase = mbOut.trim();
      const renames = parseRenames(nameStatusOut);
      const dependencies = await collectDependencies(repoPath, mergeBase, headSha, files, renames).catch((e) => {
        log('dependencies: ' + path.basename(repoPath) + ': ' + e.message);
        return null;
      });
      vsMaster = {
        behind: +behindOut.trim() || 0,
        ahead: +aheadOut.trim() || 0,
        mergeBase,
        headSha,
        files,
        totals: sumFiles(files),
        dependencies: dependencies ? dependencies.changes : null,
        vendorRoots: dependencies,
        renames,
        cx: null,
      };
    }
  }

  const aheadUpstreamOut = await git(repoPath, ['rev-list', '--count', '@{u}..HEAD']);
  const aheadUpstream = aheadUpstreamOut.trim() === '' ? null : +aheadUpstreamOut.trim();

  // branch repos: only commits not already on master; master itself: recent history
  const logOut = vsMaster
    ? await git(repoPath, ['log', '-n', '50', '--pretty=format:%x01%H%x02%h%x02%s%x02%cr', '--numstat', 'master..HEAD'])
    : await git(repoPath, ['log', '-n', '30', '--pretty=format:%x01%H%x02%h%x02%s%x02%cr', '--numstat']);

  const commits = [];
  const commitChanges = new Map();
  for (const entry of logOut.split('\x01')) {
    if (!entry.trim()) continue;
    const lines = entry.split('\n');
    const [hash, short, subject, when] = lines[0].split('\x02');
    const files = parseNumstat(lines.slice(1).join('\n'));
    commitChanges.set(hash, files);
    commits.push({ hash, short, subject, when, ...sumFiles(files), files: files.length });
  }
  const shownCommits = vsMaster
    ? commits
    : aheadUpstream != null && aheadUpstream > 0
      ? commits.slice(0, aheadUpstream)
      : commits.slice(0, 8);
  const commitsLabel = `Commits (${shownCommits.length})`;
  for (const commit of shownCommits) {
    const files = commitChanges.get(commit.hash);
    await markLineVendors(repoPath, commit.hash + '^', commit.hash, files, declarations, lineRoots);
    Object.assign(commit, sumFiles(files));
  }

  const totals = sumFiles([...staged, ...unstaged, ...untracked]);
  const ci = await collectCi(repoPath, branch);
  if (ci && testing && testing.has(ci.serial)) {
    ci.state = 'testing'; ci.reason = 'A CI operation is running'; ci.checkLabel = 'Checks running';
  }
  const pr = await collectPr(repoPath, masterSha, testing, ci);
  return {
    repoPath,
    name: path.basename(repoPath),
    branch,
    staged,
    unstaged,
    untracked,
    totals,
    vsMaster,
    commits: shownCommits,
    commitsLabel,
    upstream: aheadUpstream != null,
    ci,
    pr,
  };
}

const SUMMARY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+){2}$/;
const CASE_NUMBER_RE = /^[1-9][0-9]{0,6}$/;

// ── Excluded worktrees ──────────────────────────────────────────────────────
// A repository's worktree list also carries checkouts that are nobody's work:
// scratch clones an agent tool made for itself, a CI verify worktree. Those
// rows are noise, and `scmDiffStats.excludePaths` drops them: each pattern is
// matched against the worktree's absolute path and against its folder name,
// with `*` (one path segment) and `**` (any) as the only wildcards; a pattern
// without a wildcard also excludes everything under it.
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function excludedPath(p, patterns) {
  const base = path.basename(p);
  for (const raw of patterns) {
    const pat = String(raw).trim().replace(/\/+$/, '');
    if (!pat) continue;
    if (/[*?]/.test(pat)) {
      const re = globToRegExp(pat);
      if (re.test(p) || re.test(base)) return true;
    } else if (p === pat || base === pat || p.startsWith(pat + '/')) {
      return true;
    }
  }
  return false;
}

function excludePatterns() {
  const v = vscode.workspace.getConfiguration('scmDiffStats').get('excludePaths');
  return Array.isArray(v) ? v : [];
}

// ── PR identity ─────────────────────────────────────────────────────────────
// scripts/rename-session titles every agent session "pr-N [status]: <label>",
// composed from scripts/ci state alone. The panel reads the same state, so a
// PR row says exactly what the sessions working in it say. This is deliberately
// The label and status are files on disk, and a
// row should carry them whether or not the ci tool itself is wired up.

function ciStateDir(repoPath) {
  return path.join(path.dirname(repoPath), '.ci');
}

function readCiState(ciState, name) {
  try {
    return fs.readFileSync(path.join(ciState, name), 'utf8').trim();
  } catch {
    return null; // absent or unreadable sidecar: the PR simply lacks that fact
  }
}

// A PR's human label: the three-word summary, behind "#<case> - " when `ci case`
// recorded the Kylie case it works on. Null for a slug predating the summary
// rule — the same fallback scripts/ci and scripts/rename-session make.
function labelFrom(slug, caseNumber) {
  if (!slug || !SUMMARY_SLUG_RE.test(slug)) return null;
  const summary = slug.replace(/-/g, ' ');
  return CASE_NUMBER_RE.test(caseNumber || '') ? '#' + caseNumber + ' - ' + summary : summary;
}

// Serials whose "PR N — …" squash commit is on master. Worktrees share refs, so
// one log per master revision answers for every row in the window.
let landedCache = { sha: null, serials: new Set() };
async function landedSerials(repoPath, masterSha) {
  if (!masterSha) return new Set();
  if (landedCache.sha === masterSha) return landedCache.serials;
  const r = await gitFull(repoPath, ['log', '--format=%s', '-1000', masterSha]);
  const serials = new Set();
  for (const m of r.out.matchAll(/^PR (\d+) [—–-]/gm)) serials.add(+m[1]);
  if (r.code === 0) landedCache = { sha: masterSha, serials };
  return serials;
}

// PRs whose .ci/pr-N.lock a live process holds — a `ci test` / `ci land` run in
// flight. The kernel already publishes every held flock in /proc/locks, keyed by
// MAJOR:MINOR:INODE, so one small read plus a stat per PR row answers this: no
// walk over every process, and the lock files themselves are never opened here,
// so a starting ci run can never die on this probe. The presence of a lock file
// says nothing — scripts/ci never unlinks them, so .ci keeps one for every PR it
// has ever run; only the kernel's held set is evidence.
function scanTestingSerials(prWorktrees) {
  const held = new Set();
  if (!prWorktrees.length) return held;
  let text;
  try { text = fs.readFileSync('/proc/locks', 'utf8'); } catch { return held; }
  const locked = new Set();
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    // holders only: the kernel prefixes a blocked waiter's line with "-> "
    if (f[1] === 'FLOCK' && f[5]) locked.add(f[5]);
  }
  if (!locked.size) return held;
  for (const wt of prWorktrees) {
    const serial = +path.basename(wt).slice(3);
    let st;
    try { st = fs.statSync(path.join(ciStateDir(wt), 'pr-' + serial + '.lock')); } catch { continue; }
    const major = (st.dev >>> 8) & 0xfff;
    const minor = (st.dev & 0xff) | ((st.dev >>> 12) & 0xfff00);
    const key = major.toString(16).padStart(2, '0') + ':'
      + minor.toString(16).padStart(2, '0') + ':' + st.ino;
    if (locked.has(key)) held.add(serial);
  }
  return held;
}

// The PR identity of a worktree: its serial, the label CI recorded for it, and
// its effective readiness. Landed and running CI operations take precedence;
// a stored test result alone never declares completion.
async function collectPr(repoPath, masterSha, testing, readiness) {
  const m = path.basename(repoPath).match(/^pr-(\d+)$/);
  if (!m) return null;
  const serial = +m[1];
  const ciState = ciStateDir(repoPath);
  const slug = readCiState(ciState, 'pr-' + serial + '.slug');
  const label = labelFrom(slug, readCiState(ciState, 'pr-' + serial + '.case'));
  const known = fs.existsSync(ciState); // an unrelated repo named pr-N stays untagged
  let status = '';
  if ((await landedSerials(repoPath, masterSha)).has(serial)) status = 'landed';
  else if (testing && testing.has(serial)) status = 'testing';
  else if (readiness) status = readiness.state;
  else if (known) status = 'wip';
  return (label || status) ? { serial, label, status, reason: readiness && readiness.reason,
    statusLabel: readiness && status === readiness.state ? readiness.statusLabel : undefined } : null;
}

// Import only the landed CI's read-only report. Never execute a worktree's CI
// entry point or maintain a second copy of its proof/completion policy here.
const KYLIE_PYTHON = '/home/azrael/kylie/env/bin/python';
const CI_STATUS_READER = String.raw`
import importlib.machinery
import importlib.util
import json
import sys
from pathlib import Path

loader = importlib.machinery.SourceFileLoader('minion_ci_status', '/home/azrael/kylie/scripts/ci')
spec = importlib.util.spec_from_loader(loader.name, loader)
ci = importlib.util.module_from_spec(spec)
loader.exec_module(ci)
worktree = Path(sys.argv[1]).resolve()
if worktree.parent != ci.WORKTREES.resolve() or not ci.re.fullmatch(r'pr-[0-9]+', worktree.name):
    raise ValueError('Not a canonical Kylie PR worktree')
print(json.dumps(ci.pr_status(int(worktree.name[3:]), worktree)))
`;

function validCiReport(report) {
  return report && typeof report === 'object' && !Array.isArray(report)
    && ['status', 'checks', 'review', 'next'].every((key) => typeof report[key] === 'string' && report[key])
    && Array.isArray(report.issues) && report.issues.every((issue) => issue && typeof issue === 'object'
      && ['status', 'detail', 'owner', 'action'].every((key) => typeof issue[key] === 'string' && issue[key]))
    && Array.isArray(report.operator_steps) && report.operator_steps.every((step) => typeof step === 'string' && step);
}

function readCiReport(repoPath) {
  return new Promise((resolve, reject) => {
    cp.execFile(KYLIE_PYTHON, ['-I', '-B', '-c', CI_STATUS_READER, repoPath], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.killed ? 'CI status read timed out' : 'Cannot read the landed CI status'));
        return;
      }
      try {
        const report = JSON.parse(stdout);
        if (!validCiReport(report)) {
          throw new Error('Invalid CI status report');
        }
        resolve(report);
      } catch (error) {
        reject(new Error('Cannot read CI status report: ' + error.message));
      }
    });
  });
}

async function collectCi(repoPath, branch) {
  if (!branch || branch === 'master' || branch === 'main') return null;
  const m = path.basename(repoPath).match(/^pr-(\d+)$/);
  if (!m) return null;
  const serial = +m[1];
  if (!fs.existsSync(path.join(repoPath, 'docs', 'PR_' + serial))) return null;
  try {
    const report = await readCiReport(repoPath);
    const details = report.issues.map((issue) => issue.status + ': ' + issue.detail
      + '\n' + issue.owner + ': ' + issue.action);
    if (!details.length) {
      details.push(report.next);
    }
    details.push(...report.operator_steps.map((step) => 'Operator after landing: ' + step));
    return {
      serial, state: report.status.split(':')[0].split(' (')[0].replace(/ /g, '-'),
      statusLabel: report.status, reason: details.join('\n'),
      checkLabel: report.checks, reviewLabel: report.review,
    };
  } catch (error) {
    return { serial, state: 'status-unavailable', statusLabel: 'status unavailable',
      reason: error.message + '\nAgent: inspect CI status; /home/azrael/kylie/scripts/ci status ' + serial,
      checkLabel: 'Checks unavailable', reviewLabel: 'Agent sign-off unavailable' };
  }
}

// ── Vendored dependencies vs master ─────────────────────────────────────────
const VENDOR_CACHE_MAX = 64;
const VENDOR_METADATA_MAX = 128 * 1024;
const vendorCache = new Map();

function vendorLocation(filePath) {
  const match = /^(.*?(?:^|\/)(?:vendor|third_party|third-party|staticfiles))\/((?:@[^/]+\/)?[^/]+)\//.exec(filePath);
  return match ? { container: match[1], root: match[1] + '/' + match[2] } : null;
}

function vendorDeclarations(repoPath) {
  const settings = vscode.workspace.getConfiguration('scmDiffStats', vscode.Uri.file(repoPath));
  const entries = settings.get('vendorLibraries') || [];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim()
    && typeof entry.path === 'string' && entry.path
    && !entry.path.startsWith('/') && !entry.path.includes('\\')
    && !entry.path.split('/').some((part) => !part || part === '.' || part === '..' || /[*?:]/.test(part)))
    .map((entry) => ({ path: entry.path, name: entry.name.trim(), id: entry.name.trim().toLowerCase() }));
}

function vendorIdentity(packageText, readme) {
  try {
    const metadata = JSON.parse(packageText);
    if (typeof metadata.name === 'string' && /^(@[\w.-]+\/)?[\w.-]+$/.test(metadata.name)
      && typeof metadata.version === 'string' && /^\d+\.\d+/.test(metadata.version)) {
      return { id: metadata.name, name: metadata.name, version: metadata.version };
    }
  } catch { /* A documented, pinned npm archive can identify a prebuilt bundle. */ }
  const archive = /https:\/\/registry\.npmjs\.org\/((?:@[\w.-]+\/)?[\w.-]+)\/-\/[\w.-]+-(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.tgz/.exec(readme || '');
  if (!archive) {
    return null;
  }
  const title = /^(?:#\s*)?(.+?)\s+v?\d+\.\d+\.\d+/.exec(readme.trim());
  return { id: archive[1], name: title ? title[1] : archive[1], version: archive[2] };
}

function parseVendorTree(output) {
  const files = new Map();
  for (const entry of output.split('\0')) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\s+(\d+)\t([^]*)$/.exec(entry);
    if (match) {
      files.set(match[4], { oid: match[2], bytes: Number(match[3]) });
    }
  }
  return files;
}

function vendorAt(filePath, roots) {
  return roots.find((root) => filePath.startsWith(root.path + '/'));
}

const lineVendorCache = new Map();

async function markLineVendors(repoPath, baseRef, headRef, files, declarations, cache) {
  for (const [side, ref] of [['Base', baseRef], ['Head', headRef]]) {
    for (const file of files) {
      if (!(side === 'Base' ? file.del : file.add)) {
        continue;
      }
      const name = side === 'Base' ? file.oldPath || file.path : file.path;
      if (vendorAt(name, declarations)) {
        file['vendor' + side] = true;
        continue;
      }
      const location = vendorLocation(name);
      if (!location) {
        continue;
      }
      const immutable = ref && /^[a-f0-9]{40,64}\^?$/.test(ref);
      const roots = immutable ? lineVendorCache : cache;
      const key = JSON.stringify([repoPath, ref, location.root]);
      if (!roots.has(key)) {
        const contents = [];
        for (const metadata of ['package.json', 'README.md']) {
          const metadataPath = location.root + '/' + metadata;
          let content = '';
          if (ref === null) {
            try {
              const absolute = path.join(repoPath, metadataPath);
              const stat = await fs.promises.stat(absolute);
              if (stat.isFile() && stat.size <= VENDOR_METADATA_MAX) {
                content = await fs.promises.readFile(absolute, 'utf8');
              }
            } catch { /* Missing metadata does not identify a library. */ }
          } else {
            content = await git(repoPath, ['show', ref + ':' + metadataPath]);
          }
          contents.push(Buffer.byteLength(content) <= VENDOR_METADATA_MAX ? content : '');
        }
        roots.set(key, !!vendorIdentity(...contents));
        while (roots.size > VENDOR_CACHE_MAX) {
          roots.delete(roots.keys().next().value);
        }
      }
      file['vendor' + side] = roots.get(key);
    }
  }
}

async function vendorSnapshot(repoPath, ref, containers, declarations) {
  const key = JSON.stringify([repoPath, ref, containers, declarations]);
  if (vendorCache.has(key)) {
    return vendorCache.get(key);
  }
  const snapshot = (async () => {
    const result = await gitFull(repoPath, ['ls-tree', '-r', '-l', '-z', ref, '--', ...containers.map((p) => ':(literal)' + p)]);
    if (result.code !== 0) {
      throw new Error('could not read dependency tree');
    }
    const files = parseVendorTree(result.out);
    const candidates = new Set(declarations.map((entry) => entry.path));
    for (const file of files.keys()) {
      const location = vendorLocation(file);
      if (location) {
        candidates.add(location.root);
      }
    }
    const metadata = new Map();
    for (const root of candidates) {
      for (const name of ['package.json', 'README.md']) {
        const file = files.get(root + '/' + name);
        if (file && file.bytes <= VENDOR_METADATA_MAX) {
          metadata.set(root + '/' + name, file.oid);
        }
      }
    }
    const blobs = await catBlobs(repoPath, [...new Set(metadata.values())]);
    if ([...metadata.values()].some((oid) => !blobs.has(oid))) {
      throw new Error('could not read dependency metadata');
    }
    const contents = (file) => blobs.get(metadata.get(file))?.toString('utf8') || '';
    const roots = [];
    for (const root of candidates) {
      const declared = declarations.find((entry) => entry.path === root);
      const identity = vendorIdentity(contents(root + '/package.json'), contents(root + '/README.md'));
      if (declared || identity) {
        roots.push({ ...identity, ...declared, path: root });
      }
    }
    // The most specific declaration owns a file when vendor directories nest.
    roots.sort((a, b) => b.path.length - a.path.length);
    const libraries = new Map();
    for (const [file, blob] of files) {
      const root = vendorAt(file, roots);
      if (!root) {
        continue;
      }
      const library = libraries.get(root.id) || { name: root.name, bytes: 0, versions: new Set(), signature: [] };
      library.bytes += blob.bytes;
      if (root.version) {
        library.versions.add(root.version);
      }
      library.signature.push(file + ':' + blob.oid);
      libraries.set(root.id, library);
    }
    for (const library of libraries.values()) {
      library.versions = [...library.versions].sort();
      library.signature = library.signature.sort().join('\n');
    }
    return { roots, libraries };
  })();
  vendorCache.set(key, snapshot);
  while (vendorCache.size > VENDOR_CACHE_MAX) {
    vendorCache.delete(vendorCache.keys().next().value);
  }
  try {
    return await snapshot;
  } catch (error) {
    vendorCache.delete(key);
    throw error;
  }
}

function dependencyChanges(base, head) {
  const changes = [];
  for (const id of new Set([...base.libraries.keys(), ...head.libraries.keys()])) {
    const before = base.libraries.get(id), after = head.libraries.get(id);
    if (before && after && before.signature === after.signature) {
      continue;
    }
    changes.push({
      name: (after || before).name,
      kind: !before ? 'added' : !after ? 'removed' : 'updated',
      baseBytes: before?.bytes || 0, headBytes: after?.bytes || 0,
      baseVersions: before?.versions || [], headVersions: after?.versions || [],
    });
  }
  return changes;
}

async function collectDependencies(repoPath, baseRef, headRef, files, renames) {
  const declarations = vendorDeclarations(repoPath);
  const containers = new Set(declarations.map((entry) => entry.path));
  for (const file of files) {
    for (const name of [file.path, renames[file.path]]) {
      const location = name && vendorLocation(name);
      if (location) {
        containers.add(location.container);
      }
    }
  }
  if (!containers.size || !baseRef || !headRef) {
    return { changes: [], baseRoots: [], headRoots: [] };
  }
  const paths = [...containers].sort();
  const [base, head] = await Promise.all([
    vendorSnapshot(repoPath, baseRef, paths, declarations),
    vendorSnapshot(repoPath, headRef, paths, declarations),
  ]);
  for (const file of files) {
    const headVendor = vendorAt(file.path, head.roots);
    const baseVendor = vendorAt(renames[file.path] || file.path, base.roots);
    file.vendorHead = !!headVendor;
    file.vendorBase = !!baseVendor;
    const vendor = headVendor || baseVendor;
    if (vendor) {
      file.vendor = vendor.name;
    }
  }
  return { changes: dependencyChanges(base, head), baseRoots: base.roots, headRoots: head.roots };
}

// ── Complexity vs master ────────────────────────────────────────────────────
// `qlty metrics` (https://qlty.sh) scores changed application and test files at the
// merge base and at HEAD; the panel shows the difference, so a PR row says how
// much harder to read its code got, not only how much longer. qlty only runs
// inside a git repository carrying `.qlty/qlty.toml`, and the project must stay
// untouched, so the blobs are analysed in a private scratch repository under
// the OS temp dir. A blob's score never changes, so each git object id is
// scored once and kept in a cache file beside the scratch repo; a refresh with
// nothing new costs two `git ls-tree` calls and no qlty run.
const QLTY_EXTS = new Set(['py', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'java', 'rb', 'go', 'rs',
  'php', 'kt', 'kts', 'swift', 'cs', 'scala', 'c', 'cc', 'cpp', 'h', 'hpp']);
const QLTY_CACHE_MAX = 5000;
let logChannel = null;
let qltyRootPromise = null;
let qltyCache = null;
let qltyMissing = ''; // the command that failed to spawn; retried once the setting changes

function log(line) {
  if (logChannel) logChannel.appendLine(line);
}

function qltyCommandPath() {
  const set = (vscode.workspace.getConfiguration('scmDiffStats').get('qltyCommand') || '').trim();
  if (set) return set;
  const home = path.join(process.env.HOME || '', '.qlty', 'bin', 'qlty');
  return fs.existsSync(home) ? home : 'qlty';
}

// the extension a blob is scored under — qlty picks the language from it —
// or null for a file type qlty metrics does not score (templates, docs, …)
function qltyExt(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(p);
  const ext = m ? m[1].toLowerCase() : '';
  return QLTY_EXTS.has(ext) ? ext : null;
}

function qltyRoot() {
  if (!qltyRootPromise) {
    qltyRootPromise = (async () => {
      const root = path.join(os.tmpdir(), 'scm-diff-stats-qlty');
      fs.mkdirSync(path.join(root, '.qlty'), { recursive: true });
      const toml = path.join(root, '.qlty', 'qlty.toml');
      if (!fs.existsSync(toml)) fs.writeFileSync(toml, 'config_version = "0"\n');
      if (!fs.existsSync(path.join(root, '.git')) && (await gitFull(root, ['init', '-q'])).code !== 0) {
        throw new Error('git init failed in ' + root);
      }
      return root;
    })().catch((e) => {
      qltyRootPromise = null; // the next refresh tries again
      log('complexity: ' + e.message);
      return null;
    });
  }
  return qltyRootPromise;
}

function qltyCacheLoad(root) {
  if (qltyCache) return qltyCache;
  qltyCache = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'cache.json'), 'utf8'));
    for (const [k, v] of Object.entries(saved)) qltyCache.set(k, v);
  } catch { /* no cache yet */ }
  return qltyCache;
}

function qltyCacheSave(root) {
  while (qltyCache.size > QLTY_CACHE_MAX) qltyCache.delete(qltyCache.keys().next().value);
  try {
    fs.writeFileSync(path.join(root, 'cache.json'), JSON.stringify(Object.fromEntries(qltyCache)));
  } catch { /* the cache is a convenience */ }
}

// The `qlty metrics` table — "name | classes | funcs | fields | cyclo | complex
// | LCOM | lines | LOC", one row per scored file, ANSI colour stripped (qlty
// emits it even when piped) — as a Map from the row's file name to its numbers.
function parseQltyTable(out) {
  const rows = new Map();
  let cols = null;
  for (const raw of out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    if (!raw.includes('|')) continue;
    const cells = raw.split('|').map((c) => c.trim());
    if (!cols) {
      if (cells[0] === 'name') cols = cells;
      continue;
    }
    if (cells.length !== cols.length || cells[0] === 'TOTAL') continue;
    const row = {};
    for (let i = 1; i < cols.length; i++) row[cols[i]] = +cells[i];
    rows.set(path.basename(cells[0]), row);
  }
  return rows;
}

// object id of every listed path in a tree; absent paths are simply missing
async function treeBlobs(repoPath, tree, paths) {
  const map = new Map();
  if (!paths.length) return map;
  const out = await git(repoPath, ['ls-tree', '-z', tree, '--', ...paths]);
  for (const entry of out.split('\0')) {
    const m = entry.match(/^\d+ blob ([0-9a-f]+)\t([^]*)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

// contents of many blobs from one `git cat-file --batch` call
function catBlobs(repoPath, oids) {
  return new Promise((resolve) => {
    const map = new Map();
    if (!oids.length) { resolve(map); return; }
    const chunks = [];
    const child = cp.spawn('git', ['cat-file', '--batch'], { cwd: repoPath });
    child.stdout.on('data', (b) => chunks.push(b));
    child.on('error', () => resolve(map));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      let i = 0;
      while (i < buf.length) {
        const nl = buf.indexOf(10, i);
        if (nl < 0) break;
        const hdr = buf.toString('utf8', i, nl).split(' ');
        i = nl + 1;
        if (hdr[1] !== 'blob') continue; // "<oid> missing"
        const size = +hdr[2];
        map.set(hdr[0], buf.subarray(i, i + size));
        i += size + 1;
      }
      resolve(map);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(oids.join('\n') + '\n');
  });
}

function qltyRun(cmd, root, files) {
  return new Promise((resolve) => {
    cp.execFile(cmd, ['metrics', '--no-upgrade-check', '--quiet', ...files],
      { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 120000 },
      (err, stdout, stderr) => resolve({ err, out: stdout || '', errOut: stderr || '' }));
  });
}

const CI_SUPPORT_PATHS = new Set([
  'scripts/ci', 'scripts/ci.bash', 'scripts/ci_settings.py',
  'scripts/audit_runner.py', 'scripts/quick_runner.py', 'scripts/quick_tests.py',
  'scripts/benchmark_request_timing.py',
  'scripts/land_checks.py', 'scripts/land_migrations.py', 'scripts/refresh-local-db',
  'kylie/management/commands/visual_baselines.py',
]);

function isVerificationPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (CI_SUPPORT_PATHS.has(normalized)) {
    return true;
  }
  const parts = normalized.split('/');
  const name = parts.pop();
  if (parts.some((part) => /^(?:(?:tests?|testing|specs?|ci)(?:[_-].+)?|__tests__|__mocks__|\.github|\.gitlab|\.circleci|\.buildkite)$/i.test(part))) {
    return true;
  }
  return /^(?:tests?|conftest)\.[^.]+$/i.test(name)
    || /^(?:tests?|specs?)_.+\.[^.]+$/i.test(name)
    || /[._](?:tests?|specs?)\.[^.]+$/i.test(name)
    || /(?:Test|Tests|TestCase|Spec|Specs)\.[^.]+$/.test(name);
}

// Per-file deltas from the scored sides: `scored` holds one entry per file
// with its qlty row at HEAD and at the merge base (null where the file does
// not exist on that side or qlty produced no row). Files qlty scored on
// neither side get no `cx` and do not count; an added or deleted file counts
// from or to zero. CI and test scores stay separate from the application total;
// renames classify each side by its own path.
function complexityTotals(scored, renames = {}) {
  const total = { cognitive: 0, cyclo: 0, head: 0, base: 0, files: 0 };
  total.checks = { cognitive: 0, cyclo: 0, head: 0, base: 0, files: 0 };
  for (const { f, head, base } of scored) {
    if (!head && !base) {
      continue;
    }
    const h = head || { complex: 0, cyclo: 0 };
    const b = base || { complex: 0, cyclo: 0 };
    f.cx = { cognitive: h.complex - b.complex, cyclo: h.cyclo - b.cyclo, head: h.complex, base: b.complex };
    const headTotal = isVerificationPath(f.path) ? total.checks : total;
    const baseTotal = isVerificationPath(renames[f.path] || f.path) ? total.checks : total;
    f.cx.excluded = headTotal === total.checks;
    headTotal.cognitive += h.complex;
    headTotal.cyclo += h.cyclo;
    headTotal.head += h.complex;
    baseTotal.cognitive -= b.complex;
    baseTotal.cyclo -= b.cyclo;
    baseTotal.base += b.complex;
    if (head) {
      headTotal.files++;
    }
    if (base && (!head || baseTotal !== headTotal)) {
      baseTotal.files++;
    }
  }
  return total;
}

// Scores the branch's changed files at the merge base and at HEAD (the same
// two sides the +/- numbers compare), adds `cx` to each scored file and returns
// the totals — null when qlty is unavailable or the run failed, so the column
// simply stays away.
async function collectComplexity(repoPath, mergeBase, files, renames, headSha, dependencies) {
  const cmd = qltyCommandPath();
  if (!cmd || cmd === qltyMissing || !mergeBase) return null;
  const root = await qltyRoot();
  if (!root) return null;
  const wanted = [];
  for (const f of files) {
    delete f.cx;
    if (f.binary) continue;
    const ext = qltyExt(f.path);
    if (!ext) continue;
    const old = renames[f.path] || f.path;
    if (!vendorAt(f.path, dependencies?.headRoots || [])) {
      wanted.push({ f, side: 'head', path: f.path, ext });
    }
    if (!vendorAt(old, dependencies?.baseRoots || [])) {
      wanted.push({ f, side: 'base', path: old, ext: qltyExt(old) || ext });
    }
  }
  if (!wanted.length) return complexityTotals([]);
  const paths = (side) => [...new Set(wanted.filter((w) => w.side === side).map((w) => w.path))];
  const [headIds, baseIds] = await Promise.all([
    treeBlobs(repoPath, headSha, paths('head')),
    treeBlobs(repoPath, mergeBase, paths('base')),
  ]);
  for (const w of wanted) {
    w.oid = (w.side === 'head' ? headIds : baseIds).get(w.path) || null;
    w.key = w.oid ? w.oid + '.' + w.ext : null;
  }
  const cache = qltyCacheLoad(root);
  const missing = new Map();
  for (const w of wanted) if (w.key && !cache.has(w.key)) missing.set(w.key, w.oid);
  if (missing.size) {
    const run = path.join(root, 'blobs', process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(run, { recursive: true });
    try {
      const blobs = await catBlobs(repoPath, [...new Set(missing.values())]);
      const names = [];
      for (const [name, oid] of missing) {
        const content = blobs.get(oid);
        if (!content) continue;
        fs.writeFileSync(path.join(run, name), content);
        names.push(path.relative(root, path.join(run, name)));
      }
      if (names.length) {
        const r = await qltyRun(cmd, root, names);
        if (r.err && r.err.code === 'ENOENT') {
          qltyMissing = cmd;
          log('complexity: ' + cmd + ' not found — install qlty (https://qlty.sh) or set scmDiffStats.qltyCommand');
          return null;
        }
        if (r.err) {
          log('complexity: qlty failed in ' + path.basename(repoPath) + ' — ' + (r.errOut || r.err.message).trim().slice(0, 300));
          return null;
        }
        const rows = parseQltyTable(r.out);
        for (const rel of names) {
          const name = path.basename(rel);
          cache.set(name, rows.get(name) || null);
        }
        qltyCacheSave(root);
      }
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  }
  const sides = new Map();
  for (const w of wanted) {
    const s = sides.get(w.f) || { f: w.f, head: null, base: null };
    s[w.side] = (w.key && cache.get(w.key)) || null;
    sides.set(w.f, s);
  }
  return complexityTotals([...sides.values()], renames);
}

function getHtml(nonce) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 0; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); user-select: none; }
  .row { display: flex; align-items: center; height: 22px; cursor: pointer; white-space: nowrap; padding-right: 8px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .twist { width: 16px; flex: none; text-align: center; opacity: .8; font-size: .8em; }
  .name { overflow: hidden; text-overflow: ellipsis; }
  .hdr .name { font-weight: 600; }
  .dim { opacity: .6; margin-left: 7px; font-size: .9em; overflow: hidden; text-overflow: ellipsis; }
  .spacer { flex: 1; min-width: 8px; }
  .st { width: 1.4em; flex: none; text-align: center; font-weight: 600; }
  .add, .del { width: 3.6em; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .cx { width: 4.8em; flex: none; text-align: right; font-variant-numeric: tabular-nums; margin-right: 4px; }
  .cxl { opacity: .55; font-size: .85em; margin-right: 3px; }
  .cx-up { color: var(--vscode-charts-orange, #d18616); }
  .cx-down { color: var(--vscode-charts-green, #89d185); }
  .cx-zero { opacity: .6; }
  .cx-excluded { color: var(--vscode-descriptionForeground, #999); }
  .dependencies { font-size: .85em; margin-right: 8px; overflow: hidden; text-overflow: ellipsis; }
  .st-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .st-A, .st-U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .st-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .st-R, .st-C { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .behind { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .empty { padding: 8px; opacity: .6; }
  .agent { color: var(--vscode-charts-yellow, #d7ba7d); margin-left: 8px; font-size: .85em; flex: none;
           animation: agentpulse 2s ease-in-out infinite; }
  @keyframes agentpulse { 50% { opacity: .4; } }
  .prst { margin-left: 7px; flex: none; font-size: .85em; font-weight: 600; cursor: default; }
  .prst-landed { color: var(--vscode-charts-blue, #75beff); }
  .prst-testing { color: var(--vscode-charts-yellow, #d7ba7d); }
  .prst-blocked, .prst-checks-outdated, .prst-checks-missing, .prst-agent-sign-off-missing,
  .prst-agent-review-outdated, .prst-agent-sign-off-incomplete, .prst-agent-sign-off-outdated,
  .prst-agent-documentation-incomplete, .prst-status-unavailable { color: var(--vscode-charts-yellow, #d7ba7d); }
  .prst-checks-failed { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .prst-ready, .prst-ready-to-land { color: var(--vscode-charts-green, #89d185); }
  .prst-open { color: var(--vscode-descriptionForeground); }
  .prst-gone { color: var(--vscode-gitDecoration-deletedResourceForeground); }
</style>
</head>
<body>
<div id="root"><div class="empty">Loading repositories…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: e.message }));
let repos = [];
let loading = true;
let agents = {};
const commitFiles = {};
const pendingCommitFiles = new Set();
const state = vscode.getState() || { collapsed: {} };
state.collapsed = state.collapsed || {};

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// One task marker; checks, agent review and actions stay in its tooltip.
const PR_STATUS_TIP = {
  landed: 'landed — master carries the squash commit for this PR',
  testing: 'testing — a live ci test / ci land run holds the lock for this PR',
  ready: 'Completion and verification recorded for the current revision',
  wip: 'Work in progress; passed checks do not establish completion',
  blocked: 'Awaiting a decision or repair',
  'ready-to-land': 'Completion and verification recorded for the current revision',
  'status-unavailable': 'The CI status could not be read',
  open: 'open — the worktree exists; no green test record yet',
  gone: 'gone — CI knows this PR, but its worktree is gone',
};

// Task state accompanies its existing case number and summary.
// The status sits outside the dimmed label so its colour reads at full strength.
function prTag(pr, ci) {
  if (!pr || !pr.status) return '';
  const reason = pr.status === 'landed' || pr.status === 'testing'
    ? PR_STATUS_TIP[pr.status]
    : [pr.reason || PR_STATUS_TIP[pr.status] || pr.status, ci?.checkLabel, ci?.reviewLabel].filter(Boolean).join('\\n');
  return '<span class="prst prst-' + esc(pr.status) + '" title="'
    + esc(reason) + '">[' + esc(pr.statusLabel || pr.status.replace(/-/g, ' ')) + ']</span>';
}
function isCollapsed(id, dflt) { return state.collapsed[id] !== undefined ? state.collapsed[id] : dflt; }
function toggle(id, dflt) { state.collapsed[id] = !isCollapsed(id, dflt); vscode.setState(state); render(); }

function loadCommitFiles(repoPath, hash) {
  const key = repoPath + '|' + hash;
  if (commitFiles[key] || pendingCommitFiles.has(key)) { return; }
  pendingCommitFiles.add(key);
  vscode.postMessage({ type: 'expandCommit', repoPath, hash });
}

function setExpansion(mode) {
  const collapsed = mode === 'collapse';
  for (const r of repos) {
    state.collapsed['r|' + r.repoPath] = collapsed;
    for (const kind of ['staged', 'changes', 'vsmaster', 'commits']) {
      state.collapsed['s|' + r.repoPath + '|' + kind] = collapsed;
    }
    for (const c of r.commits) {
      state.collapsed['c|' + r.repoPath + '|' + c.hash] = collapsed;
      if (!collapsed) { loadCommitFiles(r.repoPath, c.hash); }
    }
  }
  vscode.setState(state);
  render();
}

function cols(add, del, letter, binary) {
  const st = letter ? '<span class="st st-' + esc(letter) + '">' + esc(letter) + '</span>' : '<span class="st"></span>';
  const a = binary ? '<span class="add">bin</span>' : (add != null ? '<span class="add">+' + add + '</span>' : '<span class="add"></span>');
  const d = binary ? '<span class="del"></span>' : (del != null ? '<span class="del">−' + del + '</span>' : '<span class="del"></span>');
  return st + a + d;
}

// The qlty complexity change of one file or of the whole branch vs master:
// undefined → no cell (the branch was not scored), null → an empty cell (a file
// qlty does not score) so the +/- columns keep their place.
function signed(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v); }
function cxCell(cx) {
  if (cx === undefined) return '';
  if (!cx) return '<span class="cx"></span>';
  const n = cx.cognitive;
  const cls = cx.excluded ? 'cx-excluded' : n > 0 ? 'cx-up' : n < 0 ? 'cx-down' : 'cx-zero';
  const label = cx.excluded ? 'CI and test' : 'Application';
  let tip = label + ' cognitive complexity ' + cx.base + ' → ' + cx.head + ' (' + signed(n) + '), cyclomatic '
    + signed(cx.cyclo);
  if (cx.checks && cx.checks.files) {
    const t = cx.checks;
    tip += '; CI and tests: ' + t.base + ' → ' + t.head + ' (' + signed(t.cognitive) + '), cyclomatic '
      + signed(t.cyclo) + ' (excluded from application total)';
  } else if (cx.excluded) {
    tip += ' (excluded from application total)';
  }
  tip += ' — qlty metrics, merge base vs HEAD';
  return '<span class="cx ' + cls + '" title="' + esc(tip) + '"><span class="cxl">cx</span>' + signed(n) + '</span>';
}

function dependencySize(bytes) {
  if (bytes < 1000) return bytes + ' B';
  if (bytes < 1000000) return (bytes / 1000).toFixed(1) + ' kB';
  return (bytes / 1000000).toFixed(1) + ' MB';
}

function dependencyCell(changes) {
  if (changes === null) {
    return '<span class="dependencies" title="Dependency inspection failed; vendor exclusions are unavailable">Dependencies unavailable</span>';
  }
  if (!changes || !changes.length) return '';
  const count = changes.length;
  const kinds = new Set(changes.map((change) => change.kind));
  const noun = count === 1 ? 'dependency' : 'dependencies';
  const kind = kinds.size === 1 ? changes[0].kind : 'mixed';
  let label = kind === 'added' ? '+' + count + ' ' + noun
    : kind === 'removed' ? '−' + count + ' ' + noun
    : count + ' ' + noun + (kind === 'updated' ? ' updated' : ' changed');
  if (count === 1) label += ' · ' + changes[0].name;
  const bytes = changes.reduce((sum, change) => sum + (change.kind === 'removed' ? change.baseBytes : change.headBytes), 0);
  label += ' · ' + dependencySize(bytes);
  const details = changes.map((change) => change.name + ' (' + change.kind + '): '
    + (change.baseVersions.join(', ') || '—') + ' → ' + (change.headVersions.join(', ') || '—') + ', '
    + dependencySize(change.baseBytes) + ' → ' + dependencySize(change.headBytes)).join('; ');
  const tip = details + '. Uncompressed tracked vendor files, not browser transfer size. Vendor code is excluded from cx.';
  return '<span class="dependencies" title="' + esc(tip) + '">' + esc(label) + '</span>';
}

function vendorCell(name) {
  return '<span class="cx cx-excluded" title="' + esc(name + ': vendored dependency, excluded from application and test complexity') + '">vendor</span>';
}

function row(depth, opts) {
  const pad = 4 + depth * 14;
  const twist = opts.twist === undefined ? '<span class="twist"></span>'
    : '<span class="twist">' + (opts.twist ? '▸' : '▾') + '</span>';
  return '<div class="row ' + (opts.hdr ? 'hdr' : '') + '" style="padding-left:' + pad + 'px" data-act="' + esc(opts.act || '') + '">'
    + twist
    + '<span class="name">' + opts.name + '</span>'
    + (opts.tag || '')
    + (opts.dim ? '<span class="dim">' + opts.dim + '</span>' : '')
    + (opts.btns || '')
    + '<span class="spacer"></span>'
    + (opts.cols || '')
    + '</div>';
}

function fileRow(depth, repoPath, f, act, lead) {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  return row(depth, {
    name: esc(f.path.split('/').pop()),
    dim: esc(dir),
    cols: (lead || '') + cols(f.add, f.del, f.letter, f.binary),
    act,
  });
}

function render() {
  const root = document.getElementById('root');
  if (!repos.length) {
    root.innerHTML = '<div class="empty">' + (loading ? 'Loading repositories…' : 'No git repositories found.') + '</div>';
    return;
  }
  let h = loading ? '<div class="empty">Loading remaining repositories…</div>' : '';
  for (const r of repos) {
    const rid = 'r|' + r.repoPath;
    const rc = isCollapsed(rid, false);
    const t = r.totals;
    const ag = agents[r.repoPath] || [];
    let agentHtml = '';
    if (ag.length) {
      const byKind = {};
      for (const a of ag) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
      const label = Object.entries(byKind).map(([k, n]) => (n > 1 ? k + ' ×' + n : k)).join(', ');
      agentHtml = '<span class="agent" title="agent session(s) working in this worktree: '
        + esc(ag.map(a => a.kind + (a.name ? ' “' + a.name + '”' : '') + ' (pid ' + a.pid + ')').join(', ')) + '">● ' + esc(label) + '</span>';
    }
    // A PR worktree's branch only ever repeats its folder name, so the row shows
    // the CI label instead — the same text the sessions working here are titled
    // with, collapsed or not. Everything else keeps naming its branch.
    let repoDim = esc(r.pr && r.pr.label ? r.pr.label : r.branch);
    let repoCols = (t.add || t.del) ? cols(t.add, t.del, null, false) : '';
    if (rc && r.vsMaster) {
      const v = r.vsMaster;
      repoCols = dependencyCell(v.dependencies) + cxCell(v.cx && (v.cx.files || v.cx.checks.files) ? v.cx : undefined) + cols(v.totals.add, v.totals.del, null, false);
      if (v.behind) repoDim += ' <span class="behind">↓' + v.behind + '</span>';
    }
    h += row(0, { hdr: true, twist: rc, name: esc(r.name), tag: prTag(r.pr, r.ci), dim: repoDim,
      btns: agentHtml, cols: repoCols, act: 't|' + rid + '|0' });
    if (rc) continue;

    const sections = [
      ['staged', 'Staged', r.staged, false],
      ['changes', 'Changes', [...r.unstaged, ...r.untracked], false],
    ];
    for (const [kind, label, files, dflt] of sections) {
      if (!files.length) continue;
      const sid = 's|' + r.repoPath + '|' + kind;
      const sc = isCollapsed(sid, dflt);
      const st = sumFiles(files);
      h += row(1, { hdr: true, twist: sc, name: esc(label) + ' (' + files.length + ')',
        cols: cols(st.add, st.del, null, false), act: 't|' + sid + '|' + (dflt ? 1 : 0) });
      if (!sc) for (const f of files) h += fileRow(2, r.repoPath, f, (kind === 'staged' ? 's|' : 'w|') + r.repoPath + '|' + f.path);
    }

    if (r.vsMaster) {
      const v = r.vsMaster;
      const vid = 's|' + r.repoPath + '|vsmaster';
      const vc = isCollapsed(vid, false);
      const behind = v.behind
        ? '<span class="behind">↓' + v.behind + ' behind master</span>'
        : 'not behind master';
      h += row(1, { hdr: true, twist: vc, name: 'Vs master (' + v.files.length + ')',
        dim: behind + ' · ↑' + v.ahead,
        cols: dependencyCell(v.dependencies) + cxCell(v.cx && (v.cx.files || v.cx.checks.files) ? v.cx : undefined) + cols(v.totals.add, v.totals.del, null, false),
        act: 't|' + vid + '|0' });
      if (!vc) for (const f of v.files) {
        h += fileRow(2, r.repoPath, f, 'm|' + r.repoPath + '|' + v.mergeBase + '|' + f.path,
          f.vendor && !f.cx ? vendorCell(f.vendor) : v.cx ? cxCell(f.cx || null) : '');
      }
    }

    if (r.commits.length) {
      const cid = 's|' + r.repoPath + '|commits';
      const cc = isCollapsed(cid, true);
      h += row(1, { hdr: true, twist: cc, name: esc(r.commitsLabel), act: 't|' + cid + '|1' });
      if (!cc) for (const c of r.commits) {
        const kid = 'c|' + r.repoPath + '|' + c.hash;
        const kc = isCollapsed(kid, true);
        h += row(2, { twist: kc, name: esc(c.subject), dim: esc(c.short + ' · ' + c.when),
          cols: cols(c.add, c.del, null, false), act: 'e|' + kid + '|1' });
        if (!kc) {
          const key = r.repoPath + '|' + c.hash;
          const files = commitFiles[key];
          if (!files) {
            h += row(3, { name: '<span class="dim">loading…</span>' });
          } else {
            for (const f of files) h += fileRow(3, r.repoPath, f, 'k|' + r.repoPath + '|' + c.hash + '|' + f.path);
          }
        }
      }
    }
  }
  root.innerHTML = h;
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('.row');
  if (!el || !el.dataset.act) return;
  const act = el.dataset.act;
  const sep1 = act.indexOf('|');
  const type = act.slice(0, sep1);
  const rest = act.slice(sep1 + 1);
  if (type === 't' || type === 'e') {
    const i = rest.lastIndexOf('|');
    const id = rest.slice(0, i);
    const dflt = rest.slice(i + 1) === '1';
    if (type === 'e') {
      const [, repoPath, hash] = id.split('|');
      if (isCollapsed(id, dflt) && !commitFiles[repoPath + '|' + hash]) {
        loadCommitFiles(repoPath, hash);
      }
    }
    // Opening a worktree always shows its branch diff, even if Vs master was closed before.
    if (id.startsWith('r|') && isCollapsed(id, dflt)) {
      state.collapsed['s|' + id.slice(2) + '|vsmaster'] = false;
    }
    toggle(id, dflt);
  } else if (type === 'w' || type === 's') {
    const i = rest.indexOf('|');
    vscode.postMessage({ type: 'open', mode: type === 's' ? 'staged' : 'working', repoPath: rest.slice(0, i), path: rest.slice(i + 1) });
  } else if (type === 'm') {
    const [repoPath, mergeBase, ...p] = rest.split('|');
    vscode.postMessage({ type: 'open', mode: 'vsmaster', repoPath, mergeBase, path: p.join('|') });
  } else if (type === 'k') {
    const [repoPath, hash, ...p] = rest.split('|');
    vscode.postMessage({ type: 'open', mode: 'commit', repoPath, hash, path: p.join('|') });
  }
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'expansion') {
    setExpansion(m.mode);
  } else if (m.type === 'data') {
    loading = !!m.loading;
    agents = m.agents || {};
    repos = m.repos;
    render();
  }
  else if (m.type === 'commitFiles') {
    const key = m.repoPath + '|' + m.hash;
    pendingCommitFiles.delete(key);
    commitFiles[key] = m.files;
    render();
  }
});

const CI_SUPPORT_PATHS = new Set(${JSON.stringify([...CI_SUPPORT_PATHS])});
${isVerificationPath.toString()}
${isExcludedLinePath.toString()}
${sumFiles.toString()}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

// Which repo is a claude session actually working in? The IDE spawns every
// session at the workspace root, so the process cwd says "master" even when
// the session spends all its time in a pr-N worktree. But the session's
// transcript (~/.claude/sessions/<pid>.json → sessionId →
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl) records every tool
// call, so the repo root dominating its tail is where the work happens.
const TRANSCRIPT_TAIL = 256 * 1024;
function claudeSessionRepo(c, repoPaths) {
  try {
    const home = process.env.HOME || '';
    const meta = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', c.pid + '.json')));
    if (!meta.sessionId || !meta.cwd) return null;
    // pid-reuse guard: the record must describe this very process
    if (meta.procStart && String(meta.procStart) !== String(c.start)) return null;
    const proj = String(meta.cwd).replace(/[^a-zA-Z0-9]/g, '-');
    const file = path.join(home, '.claude', 'projects', proj, meta.sessionId + '.jsonl');
    const fd = fs.openSync(file, 'r');
    let tail;
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, TRANSCRIPT_TAIL);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    // mentions of each known repo root, boundary-checked so a root never
    // counts on a longer path (…/kylie on …/kylie-worktrees, pr-2 on pr-23);
    // the per-entry "cwd" field is bookkeeping, not work — subtract it
    const counts = [];
    for (const rp of repoPaths) {
      let n = 0;
      for (let i = tail.indexOf(rp); i !== -1; i = tail.indexOf(rp, i + rp.length)) {
        const ch = tail[i + rp.length];
        if (ch === undefined || !/[A-Za-z0-9_.-]/.test(ch)) n++;
      }
      const cwdField = '"cwd":"' + rp + '"';
      for (let i = tail.indexOf(cwdField); i !== -1; i = tail.indexOf(cwdField, i + cwdField.length)) n--;
      if (n > 0) counts.push({ rp, n });
    }
    counts.sort((a, b) => b.n - a.n);
    // a clear winner only: enough mentions, and dominant over the runner-up
    // (a session that merely lists all worktrees names them all about equally)
    const top = counts[0];
    const repo = top && top.n >= 5 && (!counts[1] || top.n >= 2 * counts[1].n) ? top.rp : null;
    return { repo, name: meta.name || '' };
  } catch {
    return null; // no session record or transcript — fall back to process cwd
  }
}

function scanAgents(repoPaths) {
  // agent processes (claude/codex) attributed to the repo they work in
  const map = {};
  const candidates = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return map; }
  for (const pid of pids) {
    let cwd, cmd, ppid = 0, start = '';
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
      const stat = fs.readFileSync(`/proc/${pid}/stat`).toString();
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ppid = +f[1];
      start = f[19]; // starttime, matches the session record's procStart
    } catch { continue; }
    if (!cmd.length) continue;
    const exe = path.basename(cmd[0]);
    let kind = null;
    if (exe === 'claude' || cmd[0].includes('native-binary/claude')) kind = 'claude';
    else if (exe === 'codex') kind = 'codex';
    else continue;
    candidates.push({ pid: +pid, ppid, kind, cwd, start });
  }
  // one session = one badge: drop children whose parent is itself an agent process
  const agentPids = new Set(candidates.map((c) => c.pid));
  for (const c of candidates) {
    if (agentPids.has(c.ppid)) continue;
    let repo = null, name = '';
    if (c.kind === 'claude') {
      const s = claudeSessionRepo(c, repoPaths);
      if (s) { repo = s.repo; name = s.name; }
    }
    if (!repo) {
      for (const rp of repoPaths) {
        if (c.cwd === rp || c.cwd.startsWith(rp + path.sep)) { repo = rp; break; }
      }
    }
    if (repo) (map[repo] = map[repo] || []).push({ pid: c.pid, kind: c.kind, name });
  }
  return map;
}

function compareRepoPaths(a, b) {
  const aName = path.basename(a);
  const bName = path.basename(b);
  const rank = (name) => name.toLowerCase() === 'kylie' ? 0 : /^pr-\d+$/.test(name) ? 1 : 2;
  return rank(aName) - rank(bName)
    || aName.localeCompare(bName, undefined, { numeric: true })
    || a.localeCompare(b);
}

class StatsViewProvider {
  constructor() {
    this.view = null;
    this.repos = [];
    this.reposKnown = false;
    this.data = new Map();
    this.fileStats = new Map();
    this.agents = {};
    this.refreshPromise = null;
    this.refreshPending = false;
    this.loading = true;
    this.channel = vscode.window.createOutputChannel('Minion HQ');
    logChannel = this.channel;
  }

  setExpansion(mode) {
    if (this.view) {
      this.view.webview.postMessage({ type: 'expansion', mode });
    }
  }

  setRepos(paths) {
    // Git discovers siblings in a different order from `worktree list`.
    // Keep the active scan and row order when membership has not changed.
    const known = new Set(this.repos);
    if (this.reposKnown && paths.length === known.size && paths.every((p) => known.has(p))) {
      return;
    }
    this.reposKnown = true;
    this.repos = [...paths].sort(compareRepoPaths);
    this.loading = true;
    this.refresh();
  }

  refresh() {
    this.refreshPending = true;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = Promise.resolve().then(async () => {
      // Changes during collection request one follow-up, never another parallel scan.
      while (this.refreshPending) {
        this.refreshPending = false;
        const repos = this.repos;
        const current = () => repos === this.repos;
        this.agents = scanAgents(repos);
        const testing = scanTestingSerials(
          repos.filter((r) => /^pr-\d+$/.test(path.basename(r))));
        const results = new Array(repos.length);
        let completed = 0;
        const publish = () => {
          if (!current()) {
            return;
          }
          // Keep previous rows usable while refreshing; a failed scan removes its stale row.
          this.data = new Map(repos.map((r, i) =>
            [r, results[i] === undefined ? this.data.get(r) : results[i]]).filter(([, d]) => d));
          this.loading = completed < repos.length;
          this.fileStats.clear();
          for (const d of this.data.values()) {
            for (const f of [...d.staged, ...d.unstaged, ...d.untracked]) {
              this.fileStats.set(path.join(d.repoPath, f.path), f);
            }
          }
          this.push();
        };
        const collect = async (visit) => {
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(REPO_CONCURRENCY, repos.length) }, async () => {
            while (current() && next < repos.length) {
              await visit(next++);
            }
          }));
        };
        await collect(async (i) => {
          results[i] = await collectRepo(repos[i], testing).catch((e) => {
            log('collect: ' + repos[i] + ': ' + (e.stack || e.message));
            return null;
          });
          const v = results[i] && results[i].vsMaster;
          const previous = this.data.get(repos[i])?.vsMaster;
          if (v && previous && v.headSha && v.headSha === previous.headSha && v.mergeBase === previous.mergeBase) {
            v.cx = previous.cx;
            const scores = new Map(previous.files.map((f) => [f.path, f.cx]));
            for (const f of v.files) {
              f.cx = scores.get(f.path);
            }
          }
          completed++;
          publish();
        });
        if (!repos.length) {
          publish();
        }

        // Complexity can take much longer than Git status. Publish every basic row first.
        await collect(async (i) => {
          const d = results[i];
          if (!d || !d.vsMaster) {
            return;
          }
          const v = d.vsMaster;
          v.cx = await collectComplexity(d.repoPath, v.mergeBase, v.files, v.renames, v.headSha, v.vendorRoots).catch((e) => {
            log('complexity: ' + path.basename(d.repoPath) + ': ' + e.message);
            return null;
          });
          publish();
        });
      }
    }).catch((e) => log('refresh: ' + e.message)).finally(() => {
      this.refreshPromise = null;
      if (this.refreshPending) return this.refresh();
    });
    return this.refreshPromise;
  }

  push() {
    if (!this.view) return;
    const repos = this.repos.filter((r) => this.data.has(r)).map((r) => this.data.get(r));
    this.view.webview.postMessage({
      type: 'data', repos, loading: this.loading,
      agents: this.agents,
    });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    view.webview.html = getHtml(nonce);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  async onMessage(m) {
    if (m.type === 'error') {
      log('webview: ' + m.message);
    } else if (m.type === 'ready') {
      this.push();
    } else if (m.type === 'expandCommit') {
      const [numOut, nsOut] = await Promise.all([
        git(m.repoPath, ['show', '--numstat', '--format=', '--find-renames', m.hash]),
        git(m.repoPath, ['show', '--name-status', '--format=', '--find-renames', m.hash]),
      ]);
      const letters = parseNameStatus(nsOut);
      const files = parseNumstat(numOut).map((f) => ({ ...f, letter: letters[f.path] || 'M' }));
      if (this.view) this.view.webview.postMessage({ type: 'commitFiles', repoPath: m.repoPath, hash: m.hash, files });
    } else if (m.type === 'open') {
      const uri = vscode.Uri.file(path.join(m.repoPath, m.path));
      const base = path.basename(m.path);
      try {
        if (m.mode === 'working' || m.mode === 'staged') {
          let ref = '';
          let basePath = m.path;
          if (m.mode === 'staged') {
            try {
              ref = (await readGit(m.repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toString().trim();
            } catch (error) {
              if (error.code !== 1) {
                throw error;
              }
              ref = null; // An unborn branch has no HEAD side.
            }
            const names = await readGit(m.repoPath, ['diff', '--cached', '--name-status', '--find-renames']);
            basePath = parseRenames(names.toString())[m.path] || m.path;
          }
          const [left, right] = await Promise.all([
            revisionUri(m.repoPath, ref, basePath),
            m.mode === 'staged' ? revisionUri(m.repoPath, '', m.path) : workingUri(m.repoPath, m.path),
          ]);
          if (m.mode === 'working' && left.scheme === EMPTY_SCHEME && right.scheme === 'file') {
            await vscode.commands.executeCommand('vscode.open', right);
          } else {
            await vscode.commands.executeCommand('vscode.diff', left, right,
              `${base} (${m.mode === 'staged' ? 'HEAD ↔ index' : 'index ↔ working tree'})`);
          }
        } else if (m.mode === 'vsmaster') {
          const basePath = this.data.get(m.repoPath)?.vsMaster?.renames?.[m.path] || m.path;
          const [left, right] = await Promise.all([
            revisionUri(m.repoPath, m.mergeBase, basePath), workingUri(m.repoPath, m.path),
          ]);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${base} (master ↔ branch)`);
        } else if (m.mode === 'commit') {
          const revisions = (await readGit(m.repoPath, ['rev-list', '--parents', '-n', '1', m.hash])).toString().trim().split(' ');
          const [left, right] = await Promise.all([
            revisionUri(m.repoPath, revisions[1] || null, m.path), revisionUri(m.repoPath, revisions[0], m.path),
          ]);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${base} @ ${m.hash.slice(0, 7)}`);
        } else {
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      } catch (error) {
        log('open: ' + m.repoPath + '/' + m.path + ': ' + error.message);
        vscode.window.showErrorMessage(`Could not open ${base}: ${error.message}`);
      }
    }
  }
}

function activate(context) {
  const provider = new StatsViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('scmDiffStats', provider));
  context.subscriptions.push(vscode.commands.registerCommand('scmDiffStats.refresh', () => provider.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('scmDiffStats.collapseAll', () => provider.setExpansion('collapse')));
  context.subscriptions.push(vscode.commands.registerCommand('scmDiffStats.expandAll', () => provider.setExpansion('expand')));
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    })
  );
  const revisionEmitter = new vscode.EventEmitter();
  context.subscriptions.push(revisionEmitter);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(REVISION_SCHEME, {
    ...revisionFileSystem, onDidChangeFile: revisionEmitter.event,
  }, { isReadonly: true, isCaseSensitive: true }));

  const decoEmitter = new vscode.EventEmitter();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decoEmitter.event,
      provideFileDecoration(uri) {
        const f = provider.fileStats.get(uri.fsPath);
        if (!f || f.binary) return undefined;
        return { tooltip: `+${f.add} −${f.del}` };
      },
    })
  );

  let timer;
  let discoveryPromise = null;
  let discoveryPending = false;
  const syncRepos = () => {
    discoveryPending = true;
    if (discoveryPromise) {
      return discoveryPromise;
    }
    discoveryPromise = Promise.resolve().then(async () => {
      while (discoveryPending) {
        discoveryPending = false;
        const paths = gitApi && gitApi.repositories.length
          ? gitApi.repositories.map((r) => r.rootUri.fsPath)
          : await workspaceRepos();
        provider.setRepos(await expandWorktrees(paths));
      }
    }).catch((error) => log('discovery: ' + error.message)).finally(() => {
      discoveryPromise = null;
      if (discoveryPending) {
        return syncRepos();
      }
    });
    return discoveryPromise;
  };
  const scheduleRefresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      provider.refresh().then(() => decoEmitter.fire(undefined));
    }, 700);
  };

  // every worktree of every known repo gets a row, even when it is not a
  // workspace folder (ci new creates worktrees without touching the workspace)
  const expandWorktrees = async (paths) => {
    const all = new Set(paths);
    const discovered = new Set();
    for (const p of paths) {
      if (discovered.has(p)) {
        continue;
      }
      const out = await git(p, ['worktree', 'list', '--porcelain']);
      discovered.add(p);
      for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) {
          const wt = line.slice(9).trim();
          if (wt && fs.existsSync(wt)) {
            all.add(wt);
            discovered.add(wt);
          }
        }
      }
    }
    const patterns = excludePatterns();
    return [...all].filter((p) => !excludedPath(p, patterns));
  };

  const wireGitApi = async () => {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return false;
    gitApi = (await gitExt.activate()).getAPI(1);
    context.subscriptions.push(gitApi.onDidOpenRepository((repo) => {
      context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
      syncRepos();
    }));
    context.subscriptions.push(gitApi.onDidCloseRepository(syncRepos));
    for (const repo of gitApi.repositories) {
      context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
    }
    return gitApi.repositories.length > 0;
  };

  const workspaceRepos = () => {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    return Promise.all(
      folders.map(async (f) => ((await git(f, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true' ? f : null))
    ).then((rs) => rs.filter(Boolean));
  };

  wireGitApi().then(syncRepos);

  // worktrees outside the workspace get no git-extension change events;
  // a slow poll keeps their rows (and the land-readiness state) current
  const repoPoll = setInterval(() => {
    if (gitApi && gitApi.repositories.length) {
      const previous = provider.repos;
      syncRepos().then(() => {
        if (provider.repos === previous) {
          scheduleRefresh();
        }
      });
    } else {
      scheduleRefresh();
    }
  }, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(repoPoll) });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(scheduleRefresh));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    // a changed exclude list changes which worktrees have rows at all
    if (e.affectsConfiguration('scmDiffStats.excludePaths')) syncRepos();
    else if (e.affectsConfiguration('scmDiffStats')) provider.refresh();
  }));

  const agentPoll = setInterval(() => {
    const a = scanAgents(provider.repos);
    if (JSON.stringify(a) !== JSON.stringify(provider.agents)) {
      provider.agents = a;
      provider.push();
    }
  }, 7000);
  context.subscriptions.push({ dispose: () => clearInterval(agentPoll) });
}

function deactivate() {}

module.exports = { activate, deactivate };
