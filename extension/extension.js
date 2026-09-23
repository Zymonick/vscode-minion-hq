const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CI_TASK_TYPE = 'scm-diff-stats-ci';
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

async function existsAtRef(repoPath, ref, relPath) {
  return (await gitFull(repoPath, ['cat-file', '-e', `${ref}:${relPath}`])).code === 0;
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
    if (r) p = r.length === 5 ? r[1] + r[3] + r[4] : r[2];
    files.push({ path: p, add: binary ? null : +m[1], del: binary ? null : +m[2], binary });
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

function parseShortstatLine(line) {
  const add = (line.match(/(\d+) insertion/) || [])[1];
  const del = (line.match(/(\d+) deletion/) || [])[1];
  const filesChanged = (line.match(/(\d+) files? changed/) || [])[1];
  return { add: add ? +add : 0, del: del ? +del : 0, files: filesChanged ? +filesChanged : 0 };
}

function sumFiles(files) {
  return files.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });
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
  const [unstagedOut, stagedOut, untrackedOut, branchOut, statusOut, headOut] = await Promise.all([
    git(repoPath, ['diff', '--numstat']),
    git(repoPath, ['diff', '--numstat', '--cached']),
    git(repoPath, ['ls-files', '--others', '--exclude-standard']),
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['status', '--porcelain']),
    git(repoPath, ['rev-parse', '--verify', 'HEAD']),
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

  let vsMaster = null;
  let masterSha = '';
  const headRef = headOut.trim();
  if (branch && branch !== 'master' && headRef) {
    masterSha = (await git(repoPath, ['rev-parse', '--verify', '--quiet', 'master'])).trim();
    if (masterSha) {
      const [behindOut, aheadOut, mbOut, numstatOut, nameStatusOut] = await Promise.all([
        git(repoPath, ['rev-list', '--count', headRef + '..' + masterSha]),
        git(repoPath, ['rev-list', '--count', masterSha + '..' + headRef]),
        git(repoPath, ['merge-base', headRef, masterSha]),
        git(repoPath, ['diff', '--numstat', '--find-renames', masterSha + '...' + headRef]),
        git(repoPath, ['diff', '--name-status', '--find-renames', masterSha + '...' + headRef]),
      ]);
      const files = withLetter(parseNumstat(numstatOut), parseNameStatus(nameStatusOut), 'M');
      const mergeBase = mbOut.trim();
      const renames = parseRenames(nameStatusOut);
      const dependencies = await collectDependencies(repoPath, mergeBase, headRef, files, renames).catch((e) => {
        log('dependencies: ' + path.basename(repoPath) + ': ' + e.message);
        return null;
      });
      vsMaster = {
        behind: +behindOut.trim() || 0,
        ahead: +aheadOut.trim() || 0,
        mergeBase,
        files,
        totals: sumFiles(files),
        dependencies: dependencies ? dependencies.changes : null,
        cx: await collectComplexity(repoPath, mergeBase, files, renames, dependencies, headRef).catch((e) => {
          log('complexity: ' + path.basename(repoPath) + ': ' + e.message);
          return null;
        }),
      };
    }
  }

  const aheadUpstreamOut = await git(repoPath, ['rev-list', '--count', '@{u}..HEAD']);
  const aheadUpstream = aheadUpstreamOut.trim() === '' ? null : +aheadUpstreamOut.trim();

  // branch repos: only commits not already on master; master itself: recent history
  const logOut = vsMaster
    ? await git(repoPath, ['log', '-n', '50', '--pretty=format:%x01%H%x02%h%x02%s%x02%cr', '--shortstat', 'master..HEAD'])
    : await git(repoPath, ['log', '-n', '30', '--pretty=format:%x01%H%x02%h%x02%s%x02%cr', '--shortstat']);

  const commits = [];
  for (const entry of logOut.split('\x01')) {
    if (!entry.trim()) continue;
    const lines = entry.split('\n');
    const [hash, short, subject, when] = lines[0].split('\x02');
    const statLine = (lines.slice(1).join('\n').match(/\d+ files? changed[^\n]*/) || [''])[0];
    const s = statLine ? parseShortstatLine(statLine) : { add: 0, del: 0, files: 0 };
    commits.push({ hash, short, subject, when, ...s });
  }
  const shownCommits = vsMaster
    ? commits
    : aheadUpstream != null && aheadUpstream > 0
      ? commits.slice(0, aheadUpstream)
      : commits.slice(0, 8);
  const commitsLabel = `Commits (${shownCommits.length})`;

  const totals = sumFiles([...staged, ...unstaged, ...untracked]);
  const dirtyCount = staged.length + unstaged.length + untracked.length;
  const ci = await collectCi(repoPath, branch, vsMaster, dirtyCount, masterSha);
  const pr = await collectPr(repoPath, masterSha, testing);
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

function ciCommandPath() {
  return (vscode.workspace.getConfiguration('scmDiffStats').get('ciCommand') || '').trim();
}

// Fallback page list for the preview button when the preview command printed
// only the base URL: the PR's own docs/PR_N/urls_changed.md, read the way
// scripts/ci reads it — one root-relative path per line, '#' and blanks out.
function changedPagePaths(repoPath, number) {
  if (!number) return [];
  const file = path.join(repoPath, 'docs', 'PR_' + number, 'urls_changed.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const paths = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#') && /^\/\S*$/.test(line) && !paths.includes(line)) {
      paths.push(line);
    }
  }
  return paths;
}

const SUMMARY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+){2}$/;
const CASE_NUMBER_RE = /^[1-9][0-9]{0,6}$/;

// `ci new` input: three lowercase words, optionally behind the Kylie case
// number the PR works on — "#6654 three word summary" or "6654 three word …".
// A slug whose own first token is numeric ("2fa token reset") still parses as
// a slug: the case number only splits off when a space follows it.
function parseNewSummary(value) {
  const m = /^\s*(?:#?([1-9][0-9]{0,6})\s+)?(\S.*?)\s*$/.exec(value || '');
  if (!m) return null;
  const slug = m[2].replace(/\s+/g, '-');
  return SUMMARY_SLUG_RE.test(slug) ? { caseNumber: m[1] || '', slug } : null;
}

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
// independent of `ciCommand`: the label and the status are files on disk, and a
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
// its status in the precedence scripts/rename-session applies —
// landed > testing > green > open. The worktree being on screen is what
// rename-session reads as `open`, so a sibling .ci is the only thing a pr-N
// folder needs to carry a status; "gone" cannot occur here for the same reason.
async function collectPr(repoPath, masterSha, testing) {
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
  else if (fs.existsSync(path.join(ciState, 'pr-' + serial + '.tested.json'))) status = 'green';
  else if (known) status = 'open';
  return (label || status) ? { serial, label, status } : null;
}

// Land-readiness of a scripts/ci PR worktree: the .ci/pr-N.tested.json green
// record must name exactly this HEAD, and master must not have moved since.
async function collectCi(repoPath, branch, vsMaster, dirtyCount, masterSha) {
  if (!ciCommandPath()) return null;
  if (!branch || branch === 'master') return null;
  const m = path.basename(repoPath).match(/^pr-(\d+)$/);
  if (!m) return null;
  const serial = +m[1];
  // only new-style PRs (with their docs/PR_N folder) — not old review worktrees
  if (!fs.existsSync(path.join(repoPath, 'docs', 'PR_' + serial))) return null;
  const ciState = ciStateDir(repoPath);
  let tested = null;
  try {
    tested = JSON.parse(fs.readFileSync(path.join(ciState, 'pr-' + serial + '.tested.json')));
  } catch { /* no green record yet */ }
  const headSha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  let state, reason = '';
  if (dirtyCount || !tested || tested.branch_sha !== headSha) {
    state = 'untested';
    reason = dirtyCount
      ? 'working tree changed since the last green run'
      : tested ? 'HEAD is not the tested revision' : 'no green test record';
  } else if ((vsMaster && vsMaster.behind > 0) || tested.master_sha !== masterSha) {
    state = 'behind';
    reason = 'master moved since the green run';
  } else {
    state = 'ready';
  }
  return { serial, state, reason, suite: tested && tested.suite, time: tested && tested.time };
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
    const vendor = vendorAt(file.path, head.roots) || vendorAt(renames[file.path] || file.path, base.roots);
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

function isTestPath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const name = parts.pop();
  if (parts.some((part) => /^(?:tests?|__tests__|__mocks__|specs?)$/i.test(part))) {
    return true;
  }
  return /^(?:tests?|conftest)\.[^.]+$/i.test(name)
    || /^(?:test|spec)_.+\.[^.]+$/i.test(name)
    || /[._](?:tests?|specs?)\.[^.]+$/i.test(name)
    || /(?:Test|Tests|TestCase|Spec|Specs)\.[^.]+$/.test(name);
}

// Per-file deltas from the scored sides: `scored` holds one entry per file
// with its qlty row at HEAD and at the merge base (null where the file does
// not exist on that side or qlty produced no row). Files qlty scored on
// neither side get no `cx` and do not count; an added or deleted file counts
// from or to zero. Test scores stay separate from the application total;
// renames classify each side by its own path.
function complexityTotals(scored, renames = {}) {
  const total = { cognitive: 0, cyclo: 0, head: 0, base: 0, files: 0 };
  total.tests = { cognitive: 0, cyclo: 0, head: 0, base: 0, files: 0 };
  for (const { f, head, base } of scored) {
    if (!head && !base) {
      continue;
    }
    const h = head || { complex: 0, cyclo: 0 };
    const b = base || { complex: 0, cyclo: 0 };
    f.cx = { cognitive: h.complex - b.complex, cyclo: h.cyclo - b.cyclo, head: h.complex, base: b.complex };
    const headTotal = isTestPath(f.path) ? total.tests : total;
    const baseTotal = isTestPath(renames[f.path] || f.path) ? total.tests : total;
    f.cx.test = headTotal === total.tests;
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
async function collectComplexity(repoPath, mergeBase, files, renames, dependencies, headRef = 'HEAD') {
  const cmd = qltyCommandPath();
  if (!cmd || cmd === qltyMissing || !mergeBase) return null;
  const root = await qltyRoot();
  if (!root) return null;
  const wanted = [];
  for (const f of files) {
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
    treeBlobs(repoPath, headRef, paths('head')),
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
  .dependencies { font-size: .85em; margin-right: 8px; overflow: hidden; text-overflow: ellipsis; }
  .st-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .st-A, .st-U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .st-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .st-R, .st-C { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .behind { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .empty { padding: 8px; opacity: .6; }
  .cbox { display: flex; gap: 4px; padding: 3px 8px 5px 18px; }
  .cmsg { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 6px;
          font-family: inherit; font-size: inherit; outline: none; }
  .cmsg:focus { border-color: var(--vscode-focusBorder); }
  .cmsg::placeholder { color: var(--vscode-input-placeholderForeground); }
  .cbtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
          border-radius: 2px; padding: 2px 8px; cursor: pointer; font-family: inherit; font-size: inherit; white-space: nowrap; }
  .cbtn:hover { background: var(--vscode-button-hoverBackground); }
  .sbtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
          border: none; border-radius: 2px; padding: 0 6px; margin-left: 8px; cursor: pointer;
          font-family: inherit; font-size: .85em; height: 18px; white-space: nowrap; flex: none; }
  .sbtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .agent { color: var(--vscode-charts-yellow, #d7ba7d); margin-left: 8px; font-size: .85em; flex: none;
           animation: agentpulse 2s ease-in-out infinite; }
  @keyframes agentpulse { 50% { opacity: .4; } }
  .ibtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
          border: none; border-radius: 2px; width: 20px; padding: 0; margin-left: 4px; cursor: pointer;
          font-family: inherit; font-size: .9em; height: 18px; line-height: 18px; flex: none; text-align: center; }
  .ibtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .ibtn.blocked { opacity: .45; }
  .prst { margin-left: 7px; flex: none; font-size: .85em; font-weight: 600; cursor: default; }
  .prst-landed { color: var(--vscode-charts-blue, #75beff); }
  .prst-testing { color: var(--vscode-charts-yellow, #d7ba7d); }
  .prst-green { color: var(--vscode-charts-green, #89d185); }
  .prst-open { color: var(--vscode-descriptionForeground); }
  .prst-gone { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .cist { margin-left: 6px; flex: none; font-weight: 700; cursor: default; }
  .ci-ready { color: var(--vscode-charts-green, #89d185); }
  .ci-behind { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .ci-untested { color: var(--vscode-charts-yellow, #d7ba7d); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let repos = [];
let agents = {};
let syncEnabled = false;
let previewEnabled = false;
let ciEnabled = false;
let pendingRepos = null;
const commitFiles = {};
const state = vscode.getState() || { collapsed: {} };
state.collapsed = state.collapsed || {};
state.drafts = state.drafts || {};

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// the status scripts/rename-session puts in every session title for this PR
const PR_STATUS_TIP = {
  landed: 'landed — master carries the squash commit for this PR',
  testing: 'testing — a live ci test / ci land run holds the lock for this PR',
  green: 'green — tested, awaiting land',
  open: 'open — the worktree exists; no green test record yet',
  gone: 'gone — CI knows this PR, but its worktree is gone',
};

// "[green] case number labels" — the session title's own label and status.
// The status sits outside the dimmed label so its colour reads at full strength.
function prTag(pr) {
  if (!pr || !pr.status) return '';
  return '<span class="prst prst-' + esc(pr.status) + '" title="'
    + esc(PR_STATUS_TIP[pr.status] || pr.status) + '">[' + esc(pr.status) + ']</span>';
}
function isCollapsed(id, dflt) { return state.collapsed[id] !== undefined ? state.collapsed[id] : dflt; }
function toggle(id, dflt) { state.collapsed[id] = !isCollapsed(id, dflt); vscode.setState(state); render(); }

function ciBtn(repoPath, serial, cmd, glyph, tip, blocked) {
  return '<button class="ibtn' + (blocked ? ' blocked' : '') + '" data-repo="' + esc(repoPath)
    + '" data-serial="' + serial + '" data-cmd="' + cmd + '" title="' + esc(tip) + '">' + glyph + '</button>';
}

function ciHtml(r) {
  if (ciEnabled && r.branch === 'master') {
    return ciBtn(r.repoPath, '', 'new', '✚', 'ci new — create a new PR: worktree, branch, docs/PR_N, database');
  }
  if (!r.ci) return '';
  const c = r.ci, s = c.serial;
  let st;
  if (c.state === 'ready') {
    st = '<span class="cist ci-ready" title="tested (' + esc(c.suite || '') + ') ' + esc(c.time || '')
      + ' — ready to land">✓</span>';
  } else if (c.state === 'behind') {
    st = '<span class="cist ci-behind" title="land blocked: behind master — ' + esc(c.reason)
      + '. Run ci test ' + s + '.">↓</span>';
  } else {
    st = '<span class="cist ci-untested" title="land blocked: not tested — ' + esc(c.reason)
      + '. Run ci test ' + s + '.">○</span>';
  }
  return ciBtn(r.repoPath, s, 'preview', '▷', 'ci preview ' + s + ' — start the preview server and open the changed pages in Edge')
    + ciBtn(r.repoPath, s, 'test', '⇣', 'ci test ' + s + ' --fix — sync with master, run the gate, let Claude fix failures')
    + ciBtn(r.repoPath, s, 'land', '⇪', 'ci land ' + s + ' — squash-merge onto master (interactive terminal)', c.state !== 'ready')
    + st;
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
  const cls = n > 0 ? 'cx-up' : n < 0 ? 'cx-down' : 'cx-zero';
  const label = cx.test ? 'Test' : 'Application';
  let tip = label + ' cognitive complexity ' + cx.base + ' → ' + cx.head + ' (' + signed(n) + '), cyclomatic '
    + signed(cx.cyclo);
  if (cx.tests && cx.tests.files) {
    const t = cx.tests;
    tip += '; Tests: ' + t.base + ' → ' + t.head + ' (' + signed(t.cognitive) + '), cyclomatic '
      + signed(t.cyclo) + ' (excluded from application total)';
  } else if (cx.test) {
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
  return '<span class="cx cx-zero" title="' + esc(name + ': vendored dependency, excluded from application and test complexity') + '">vendor</span>';
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
  if (!repos.length) { root.innerHTML = '<div class="empty">No git repositories found.</div>'; return; }
  let h = '';
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
    const ci = ciHtml(r);
    const previewBtn = (!ci && previewEnabled && r.branch !== 'master')
      ? '<button class="sbtn pbtn" data-repo="' + esc(r.repoPath) + '" title="start the worktree preview server and open its changed pages (max 5) in the browser">▷ preview</button>'
      : '';
    // A PR worktree's branch only ever repeats its folder name, so the row shows
    // the CI label instead — the same text the sessions working here are titled
    // with, collapsed or not. Everything else keeps naming its branch.
    let repoDim = esc(r.pr && r.pr.label ? r.pr.label : r.branch);
    let repoCols = (t.add || t.del) ? cols(t.add, t.del, null, false) : '';
    if (rc && r.vsMaster) {
      const v = r.vsMaster;
      repoCols = dependencyCell(v.dependencies) + cxCell(v.cx && (v.cx.files || v.cx.tests.files) ? v.cx : undefined) + cols(v.totals.add, v.totals.del, null, false);
      if (v.behind) repoDim += ' <span class="behind">↓' + v.behind + '</span>';
    }
    h += row(0, { hdr: true, twist: rc, name: esc(r.name), tag: prTag(r.pr), dim: repoDim,
      btns: ci + previewBtn + agentHtml, cols: repoCols, act: 't|' + rid + '|0' });
    if (rc) continue;

    if (r.staged.length + r.unstaged.length + r.untracked.length > 0) {
      const draft = state.drafts[r.repoPath] || '';
      h += '<div class="cbox">'
        + '<input class="cmsg" data-repo="' + esc(r.repoPath) + '" placeholder="Commit message" value="' + esc(draft) + '">'
        + '<button class="cbtn" data-repo="' + esc(r.repoPath) + '" data-push="0" title="git add -A && git commit">Commit all</button>'
        + (r.upstream
          ? '<button class="cbtn" data-repo="' + esc(r.repoPath) + '" data-push="1" title="commit, then push to the PR branch">+ Push</button>'
          : '')
        + '</div>';
    }

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
      if (!sc) for (const f of files) h += fileRow(2, r.repoPath, f, 'w|' + r.repoPath + '|' + f.path);
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
        cols: dependencyCell(v.dependencies) + cxCell(v.cx && (v.cx.files || v.cx.tests.files) ? v.cx : undefined) + cols(v.totals.add, v.totals.del, null, false),
        btns: (syncEnabled && !r.ci) ? '<button class="sbtn" data-repo="' + esc(r.repoPath) + '" title="merge master in, run the full test suite, launch a fix agent on failure">⇣ sync + test</button>' : '',
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

function doCommit(repoPath, push) {
  const msg = (state.drafts[repoPath] || '').trim();
  if (!msg) return;
  vscode.postMessage({ type: 'commit', repoPath, message: msg, push });
}

document.addEventListener('input', (ev) => {
  if (ev.target.classList && ev.target.classList.contains('cmsg')) {
    state.drafts[ev.target.dataset.repo] = ev.target.value;
    vscode.setState(state);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.classList && ev.target.classList.contains('cmsg') && ev.key === 'Enter') {
    doCommit(ev.target.dataset.repo, ev.ctrlKey || ev.metaKey);
  }
});

// pointerdown fires before the input's focusout, so a deferred render can't swallow the click
document.addEventListener('pointerdown', (ev) => {
  const btn = ev.target.closest && ev.target.closest('button.cbtn');
  if (btn) { ev.preventDefault(); doCommit(btn.dataset.repo, btn.dataset.push === '1'); return; }
  const ibtn = ev.target.closest && ev.target.closest('button.ibtn');
  if (ibtn) {
    ev.preventDefault();
    vscode.postMessage({ type: 'ci', cmd: ibtn.dataset.cmd, repoPath: ibtn.dataset.repo, serial: ibtn.dataset.serial });
    return;
  }
  const pbtn = ev.target.closest && ev.target.closest('button.pbtn');
  if (pbtn) { ev.preventDefault(); vscode.postMessage({ type: 'preview', repoPath: pbtn.dataset.repo }); return; }
  const sbtn = ev.target.closest && ev.target.closest('button.sbtn');
  if (sbtn) { ev.preventDefault(); vscode.postMessage({ type: 'synctest', repoPath: sbtn.dataset.repo }); }
});

document.addEventListener('focusout', (ev) => {
  if (pendingRepos && ev.target.classList && ev.target.classList.contains('cmsg')) {
    repos = pendingRepos;
    pendingRepos = null;
    setTimeout(render, 100);
  }
});

document.addEventListener('click', (ev) => {
  if (ev.target.closest('button')) return;
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
        vscode.postMessage({ type: 'expandCommit', repoPath, hash });
      }
    }
    toggle(id, dflt);
  } else if (type === 'w') {
    const i = rest.indexOf('|');
    vscode.postMessage({ type: 'open', mode: 'working', repoPath: rest.slice(0, i), path: rest.slice(i + 1) });
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
  if (m.type === 'data') {
    syncEnabled = !!m.syncEnabled;
    previewEnabled = !!m.previewEnabled;
    ciEnabled = !!m.ciEnabled;
    agents = m.agents || {};
    // don't re-render while a commit message is being typed
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('cmsg')) {
      pendingRepos = m.repos;
    } else {
      repos = m.repos;
      render();
    }
  }
  else if (m.type === 'commitFiles') { commitFiles[m.repoPath + '|' + m.hash] = m.files; render(); }
  else if (m.type === 'committed') {
    delete state.drafts[m.repoPath];
    vscode.setState(state);
    render();
  }
});

function sumFiles(files) {
  return files.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });
}

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

function findClaudeBin() {
  try {
    const extDir = path.join(process.env.HOME || '', '.vscode-server', 'extensions');
    const candidates = fs.readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
      .map((d) => path.join(extDir, d, 'resources', 'native-binary', 'claude'))
      .filter((p) => fs.existsSync(p));
    if (candidates.length) return candidates[0];
  } catch { /* fall through */ }
  return 'claude';
}

class StatsViewProvider {
  constructor() {
    this.view = null;
    this.repos = [];
    this.data = new Map();
    this.fileStats = new Map();
    this.running = new Set();
    this.agents = {};
    this.refreshPromise = null;
    this.refreshPending = false;
    this.channel = vscode.window.createOutputChannel('Minion HQ');
    logChannel = this.channel;
  }

  syncCommand() {
    return (vscode.workspace.getConfiguration('scmDiffStats').get('syncTestCommand') || '').trim();
  }

  previewCommand() {
    return (vscode.workspace.getConfiguration('scmDiffStats').get('previewCommand') || '').trim();
  }

  browserCommand() {
    return (vscode.workspace.getConfiguration('scmDiffStats').get('browserCommand') || '').trim();
  }

  async runPreview(repoPath) {
    const name = path.basename(repoPath);
    const key = 'preview:' + repoPath;
    if (this.running.has(key)) {
      vscode.window.showWarningMessage(`${name}: preview is already starting`);
      return;
    }
    const template = this.previewCommand();
    if (!template) {
      vscode.window.showErrorMessage('Set scmDiffStats.previewCommand in your settings first.');
      return;
    }
    const number = (name.match(/^pr-(\d+)$/) || [])[1];
    if (template.includes('${number}') && !number) {
      vscode.window.showErrorMessage(`${name}: preview command requires a pr-N worktree.`);
      return;
    }
    const cmd = template
      .replace(/\$\{number\}/g, number || '')
      .replace(/\$\{name\}/g, name)
      .replace(/\$\{repoPath\}/g, repoPath);
    this.running.add(key);
    this.channel.appendLine(`\n=== ${new Date().toLocaleTimeString()} · ${name}: ${cmd}`);
    let out = '';
    const append = (buf) => {
      const s = buf.toString();
      this.channel.append(s);
      out += s;
    };
    try {
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `preview: ${name}` },
        () => new Promise((resolve) => {
          const child = cp.spawn('bash', ['-lc', cmd], { cwd: repoPath });
          child.stdout.on('data', append);
          child.stderr.on('data', append);
          child.on('close', resolve);
          child.on('error', (e) => { append(String(e)); resolve(1); });
        })
      );
      if (code !== 0) {
        this.channel.show(true);
        vscode.window.showErrorMessage(`${name}: preview command failed — see the Minion HQ output.`);
        return;
      }
      // base URL: prefer this worktree's status line, else the last URL printed
      let base = null;
      const line = out.match(new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\S+\\s+(https?://\\S+)', 'm'));
      if (line) base = line[1];
      if (!base) {
        const urls = out.match(/https?:\/\/[\d.]+:\d+/g);
        base = urls ? urls[urls.length - 1] : null;
      }
      if (!base) {
        this.channel.show(true);
        vscode.window.showErrorMessage(`${name}: could not find the preview URL in the command output.`);
        return;
      }
      base = base.replace(/\/+$/, '');

      // The pages to open are the ones the preview command itself printed
      // (`ci preview N status` lists every registered page under the base URL).
      // Reading a checked-in manifest instead is what made preview open a long
      // landed PR's pages against the current preview port.
      const printed = new Set();
      for (const raw of out.match(/https?:\/\/[^\s"'<>)\]]+/g) || []) {
        const url = raw.replace(/[.,;]+$/, '');
        if (url.startsWith(base + '/') && url !== base + '/') printed.add(url);
      }
      let pages = [...printed];
      if (!pages.length) pages = changedPagePaths(repoPath, number).map((u) => base + u);
      const urls = (pages.length ? pages.slice(0, 5) : [base]);

      const bcmd = this.browserCommand();
      if (bcmd) {
        const full = bcmd.replace(/\$\{urls\}/g, urls.map((u) => '"' + u + '"').join(' '));
        this.channel.appendLine(`launching browser: ${full}`);
        const child = cp.spawn('bash', ['-lc', full], { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        for (const u of urls) vscode.env.openExternal(vscode.Uri.parse(u));
      }
      vscode.window.setStatusBarMessage(`$(globe) ${name}: opened ${urls.length} page(s) at ${base}`, 8000);
    } finally {
      this.running.delete(key);
    }
  }

  async runSyncTest(repoPath) {
    const name = path.basename(repoPath);
    const d = this.data.get(repoPath);
    const branch = d ? d.branch : '';
    if (this.running.has(repoPath)) {
      vscode.window.showWarningMessage(`${name}: sync + test is already running`);
      return;
    }
    const template = this.syncCommand();
    if (!template) {
      vscode.window.showErrorMessage('Set scmDiffStats.syncTestCommand in your settings first.');
      return;
    }
    const dirty = (await git(repoPath, ['status', '--porcelain'])).trim();
    if (dirty) {
      vscode.window.showWarningMessage(`${name}: commit or stash the working tree changes first.`);
      return;
    }
    const cmd = template
      .replace(/\$\{name\}/g, name)
      .replace(/\$\{branch\}/g, branch)
      .replace(/\$\{repoPath\}/g, repoPath);

    this.running.add(repoPath);
    this.channel.appendLine(`\n=== ${new Date().toLocaleTimeString()} · ${name}: ${cmd}`);
    let tail = '';
    const append = (buf) => {
      const s = buf.toString();
      this.channel.append(s);
      tail = (tail + s).slice(-4000);
    };
    try {
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `sync + test: ${name}` },
        () => new Promise((resolve) => {
          const child = cp.spawn('bash', ['-lc', cmd], { cwd: repoPath });
          child.stdout.on('data', append);
          child.stderr.on('data', append);
          child.on('close', resolve);
          child.on('error', (e) => { append(String(e)); resolve(1); });
        })
      );
      if (code === 0) {
        vscode.window.setStatusBarMessage(`$(check) ${name}: synced with master, tests green`, 8000);
      } else {
        this.channel.show(true);
        this.launchFixAgent(repoPath, name, branch, tail);
      }
    } finally {
      this.running.delete(repoPath);
      this.refresh();
    }
  }

  launchFixAgent(repoPath, name, branch, tail) {
    const prompt =
      `The command "sync + test" for worktree ${name} (branch ${branch}, path ${repoPath}) failed. ` +
      `It runs the repository's test-integration flow: merge local master into the branch, then run the full test suite. ` +
      `Diagnose and fix the problem (merge conflicts and/or test failures) so the flow passes, following the repository rules. ` +
      `The output ended with:\n\n${tail}`;
    const promptFile = path.join(require('os').tmpdir(), `scm-diff-stats-fix-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt);
    const term = vscode.window.createTerminal({ name: `fix ${name}`, cwd: repoPath });
    term.show();
    term.sendText(`${findClaudeBin()} "$(cat '${promptFile}')"`);
    vscode.window.showWarningMessage(`${name}: sync + test failed — launched a fix agent in the terminal.`);
  }

  async runCi(cmd, repoPath, serial) {
    const ci = ciCommandPath();
    if (!ci) return;
    let args;
    if (cmd === 'new') {
      const summary = await vscode.window.showInputBox({
        prompt: 'Three-word PR summary, after the case number if this is case work',
        placeHolder: '#6654 three word summary',
        validateInput: (v) => (parseNewSummary(v) ? null
          : 'enter exactly three lowercase letters/digits words, optionally '
            + 'behind a case number (#6654 three word summary)'),
      });
      if (!summary) return;
      const parsed = parseNewSummary(summary);
      args = ['new', parsed.slug];
      if (parsed.caseNumber) args.push('--case', parsed.caseNumber);
    } else if (!/^\d+$/.test(String(serial))) {
      return;
    } else if (cmd === 'test') {
      args = ['test', String(serial), '--fix'];
    } else if (cmd === 'preview' || cmd === 'land') {
      args = [cmd, String(serial)];
    } else {
      return;
    }
    // Python auto-activation can interrupt commands sent to a new shell.
    // Process tasks retain a TTY without racing shell activation.
    const task = new vscode.Task(
      { type: CI_TASK_TYPE, repoPath, args },
      vscode.TaskScope.Workspace,
      'ci ' + args.join(' '),
      'Minion HQ',
      new vscode.ProcessExecution(ci, args, { cwd: repoPath }),
      []
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      focus: true,
      panel: vscode.TaskPanelKind.Dedicated,
    };
    try {
      await vscode.tasks.executeTask(task);
    } catch (e) {
      vscode.window.showErrorMessage(`${task.name}: ${e.message}`);
    }
  }

  setRepos(paths) {
    this.repos = paths;
    this.refresh();
  }

  refresh() {
    this.refreshPending = true;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = Promise.resolve().then(async () => {
      // Changes during collection request one follow-up, never another parallel scan.
      while (this.refreshPending) {
        this.refreshPending = false;
        const repos = [...this.repos];
        this.agents = scanAgents(repos);
        const testing = scanTestingSerials(
          repos.filter((r) => /^pr-\d+$/.test(path.basename(r))));
        const results = new Array(repos.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(REPO_CONCURRENCY, repos.length) }, async () => {
          while (next < repos.length) {
            const i = next++;
            results[i] = await collectRepo(repos[i], testing).catch(() => null);
          }
        }));

        if (repos.length !== this.repos.length || repos.some((r, i) => r !== this.repos[i])) continue;

        this.data.clear();
        this.fileStats.clear();
        for (const d of results) {
          if (!d) continue;
          this.data.set(d.repoPath, d);
          for (const f of [...d.staged, ...d.unstaged, ...d.untracked]) {
            this.fileStats.set(path.join(d.repoPath, f.path), f);
          }
        }
        this.push();
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
      type: 'data', repos, syncEnabled: !!this.syncCommand(),
      previewEnabled: !!this.previewCommand(), ciEnabled: !!ciCommandPath(),
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
    if (m.type === 'ready') {
      this.push();
    } else if (m.type === 'expandCommit') {
      const [numOut, nsOut] = await Promise.all([
        git(m.repoPath, ['show', '--numstat', '--format=', '--find-renames', m.hash]),
        git(m.repoPath, ['show', '--name-status', '--format=', '--find-renames', m.hash]),
      ]);
      const letters = parseNameStatus(nsOut);
      const files = parseNumstat(numOut).map((f) => ({ ...f, letter: letters[f.path] || 'M' }));
      if (this.view) this.view.webview.postMessage({ type: 'commitFiles', repoPath: m.repoPath, hash: m.hash, files });
    } else if (m.type === 'synctest') {
      this.runSyncTest(m.repoPath);
    } else if (m.type === 'preview') {
      this.runPreview(m.repoPath);
    } else if (m.type === 'ci') {
      this.runCi(m.cmd, m.repoPath, m.serial);
    } else if (m.type === 'commit') {
      const repoName = path.basename(m.repoPath);
      const steps = [
        ['add', '-A'],
        ['commit', '-m', m.message],
      ];
      if (m.push) steps.push(['push']);
      for (const args of steps) {
        const r = await gitFull(m.repoPath, args);
        if (r.code !== 0) {
          vscode.window.showErrorMessage(`${repoName}: git ${args[0]} failed — ${(r.err || r.out).trim().slice(0, 300)}`);
          this.refresh();
          return;
        }
      }
      const sha = (await git(m.repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
      vscode.window.setStatusBarMessage(`$(check) ${repoName}: committed ${sha}${m.push ? ' and pushed' : ''}`, 5000);
      if (this.view) this.view.webview.postMessage({ type: 'committed', repoPath: m.repoPath });
      this.refresh();
    } else if (m.type === 'open') {
      const uri = vscode.Uri.file(path.join(m.repoPath, m.path));
      const base = path.basename(m.path);
      try {
        if (m.mode === 'working') {
          await vscode.commands.executeCommand('git.openChange', uri).then(undefined, () =>
            vscode.commands.executeCommand('vscode.open', uri)
          );
        } else if (m.mode === 'vsmaster' && gitApi) {
          // a side that does not exist (file added/deleted on the branch)
          // must be an empty document, not a nonexistent git object
          const left = (await existsAtRef(m.repoPath, m.mergeBase, m.path))
            ? gitApi.toGitUri(uri, m.mergeBase)
            : emptyUri(uri);
          const right = fs.existsSync(uri.fsPath) ? uri : emptyUri(uri);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${base} (master ↔ branch)`);
        } else if (m.mode === 'commit' && gitApi) {
          const left = (await existsAtRef(m.repoPath, `${m.hash}^`, m.path))
            ? gitApi.toGitUri(uri, `${m.hash}^`)
            : emptyUri(uri);
          const right = (await existsAtRef(m.repoPath, m.hash, m.path))
            ? gitApi.toGitUri(uri, m.hash)
            : emptyUri(uri);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${base} @ ${m.hash.slice(0, 7)}`);
        } else {
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      } catch {
        vscode.commands.executeCommand('vscode.open', uri);
      }
    }
  }
}

function activate(context) {
  const provider = new StatsViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('scmDiffStats', provider));
  context.subscriptions.push(vscode.commands.registerCommand('scmDiffStats.refresh', () => provider.refresh()));
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    })
  );

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
  // replaced once the repository source is known (git API, else workspace folders)
  let syncRepos = () => provider.refresh();
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
    for (const p of paths) {
      const out = await git(p, ['worktree', 'list', '--porcelain']);
      for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) {
          const wt = line.slice(9).trim();
          if (wt && fs.existsSync(wt)) all.add(wt);
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
    const sync = () =>
      expandWorktrees(gitApi.repositories.map((r) => r.rootUri.fsPath)).then((ps) => provider.setRepos(ps));
    syncRepos = sync;
    context.subscriptions.push(gitApi.onDidOpenRepository((repo) => {
      context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
      sync();
    }));
    context.subscriptions.push(gitApi.onDidCloseRepository(sync));
    for (const repo of gitApi.repositories) {
      context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
    }
    sync();
    return gitApi.repositories.length > 0;
  };

  const syncFolders = () => {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    return Promise.all(
      folders.map(async (f) => ((await git(f, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true' ? f : null))
    ).then((rs) => expandWorktrees(rs.filter(Boolean))).then((ps) => provider.setRepos(ps));
  };

  wireGitApi().then((ok) => {
    if (!ok) {
      syncRepos = syncFolders;
      syncFolders();
    }
  });

  // worktrees outside the workspace get no git-extension change events;
  // a slow poll keeps their rows (and the land-readiness state) current
  const repoPoll = setInterval(() => {
    if (gitApi && gitApi.repositories.length) {
      expandWorktrees(gitApi.repositories.map((r) => r.rootUri.fsPath)).then((ps) => {
        if (ps.length !== provider.repos.length || ps.some((p) => !provider.repos.includes(p))) {
          provider.setRepos(ps);
        } else {
          scheduleRefresh();
        }
      });
    } else {
      scheduleRefresh();
    }
  }, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(repoPoll) });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(scheduleRefresh));
  context.subscriptions.push(vscode.tasks.onDidEndTaskProcess((e) => {
    if (e.execution.task.definition.type === CI_TASK_TYPE) scheduleRefresh();
  }));
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
