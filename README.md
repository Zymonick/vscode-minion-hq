# Minion HQ

A status and diff view for your worktrees in VS Code. Open **Minion HQ** from the Activity Bar to see changes, test status, and running agents. Run CI and Git actions in the terminal; apart from each PR's Claude and Codex controls, the panel has no steering buttons.

For every repository / git worktree open in the workspace:

- Line totals exclude the repository's root `docs/` directory, CI and test paths, and identified vendor libraries in worktree, Staged / Changes, Vs master, and commit rows. They share the [complexity exclusions](CONTRACT.md#complexity), including each side of renames; application templates and styles still count. Excluded files remain visible with their individual counts and diffs; file and commit counts still include them. Line totals work without qlty.
- **Staged / Changes** — each file with green `+added` / red `−deleted` line counts in aligned columns next to a colored git status letter (M/A/D/R/U). Staged files open HEAD ↔ index; Changes open index ↔ working tree. Untracked files count their lines as additions and open directly.
- **Vs master** — for branches other than `master`: how many commits the branch is **behind master** (red `↓N`), total `+x −y` relative to the merge base (`git diff master...HEAD`, so master moving ahead doesn't pollute the numbers), and a per-file drill-down; clicking opens a merge-base ↔ working-tree diff. Opening a worktree row always opens this section.
- **Complexity** — a `cx +N` column on the Vs master rows: how much the branch raised (orange) or lowered (green) cognitive complexity, scored with [`qlty metrics`](https://qlty.sh) at the merge base and at HEAD. The branch total counts application code; its tooltip reports CI and test complexity separately, alongside absolute scores and cyclomatic deltas. CI and test files retain their individual scores in grey because they are excluded from the application total. CI/test-only changes show a neutral `cx 0` total. The [complexity contract](CONTRACT.md#complexity) defines the exclusions. Templates, docs and other files qlty does not score show no number. Needs the `qlty` CLI (`~/.qlty/bin/qlty`, PATH, or `scmDiffStats.qltyCommand`); without it the column stays away. Scoring happens in a scratch git repository under the OS temp dir, never in the project, and every git blob is scored once and cached there.
- **Dependencies** — additions, updates, and removals of identified vendored libraries appear separately on Vs master and collapsed worktree rows, for example `+1 dependency · PDF.js · 7.1 MB`. Hover for versions and sizes before/after. Size is the uncompressed tracked footprint, including bundled fonts, images, and other assets; it is not a browser download estimate. Library files show `vendor` in grey and are excluded from both application and test complexity. Application integration code outside those directories stays counted. Dependency reporting works without `qlty` and reads committed Git data, with no registry requests; revision snapshots are cached in memory.
- **PR identity** — a `pr-N` row shows its three-word summary, prefixed with `#<case> - ` when a case is associated. Identity and readiness are read directly from CI state without command settings.
- **PR readiness** — each PR shows the status reported by Kylie CI, including missing agent sign-off, outdated review, failed or outdated checks, WIP, blocked, ready to land, testing, and landed. Its tooltip contains check results, review details, and the responsible person’s next action. A passing test alone does not mean the PR is ready to land.
- **Custom PR label** — use `ci status 615 --label "Waiting for Simon"` (replace `615` with your PR), then refresh Minion HQ. `ci status 615 --clear-label` restores the calculated status text. The label does not change readiness or landing; hover for the underlying CI status and actions. This requires the Kylie CI custom-label update.
- **Claude per PR** — every PR row has a `✻` Claude control that opens the PR's session as `claude` in a VS Code terminal named `Claude pr-N`. It focuses that terminal when it is open; otherwise it resumes the newest Claude session `scripts/rename-session` titled `pr-N` (`claude --resume <id>`, in the folder the session started in), or starts `claude` in the PR worktree, where your first prompt attaches the session to the PR. A session already running in another terminal is focused there rather than resumed twice. Codex threads are not opened. Needs the `claude` CLI on PATH or in `~/.local/bin`.
- **Codex per PR** — the adjacent `Codex` control opens a `Codex pr-N` terminal, resuming the PR's newest interactive Codex session with `codex resume <id>` or starting one in the worktree. It preserves desktop sessions' recorded executable and session stores, focuses an existing terminal, and sends no prompt. Needs the recorded Codex executable or the `codex` CLI on PATH or in `~/.local/bin`.
- **Commits** — outgoing commits when an upstream exists, otherwise the most recent ones, each with `+x −y` vs its parent. Expanding a commit lazy-loads its files; clicking opens the parent ↔ commit diff for that file.
- Visible files open independently of VS Code's Git repository discovery and panel refresh. Revision sides are read-only Git snapshots from the selected worktree; working files remain editable. Missing sides of added or deleted files are empty. Failed reads show an error instead of silently opening a different view.
- **Excluded worktrees** — `scmDiffStats.excludePaths` drops rows for checkouts that are nobody's work (an agent tool's scratch clones, a CI verify worktree). Patterns match the worktree's absolute path and its folder name, `*` inside one path segment and `**` across them; a pattern without a wildcard also excludes everything under it.
- Hover tooltips with `+x −y` on the **built-in** SCM rows (via a `FileDecorationProvider`).
- **Collapse All / Expand All** — panel title buttons close or open every worktree, section, and commit. Expanded commits load their files on demand; the view retains these choices alongside individual row toggles.
- Auto-refreshes on git state changes and file saves; manual ↻ button in the panel title. Rows appear as each repository finishes, with a loading message while other rows remain pending. Complexity scores follow after all basic rows are available, using the same commit as the displayed branch diff. Refreshes collect at most two repositories at once and combine requests received during a scan into one follow-up. Worktree discovery reads each shared list once per scan and combines concurrent requests into one follow-up. Rediscovering the same repositories in another order preserves the active scan and row order. Read-only Git queries leave the index untouched; untracked file reads are asynchronous.

Vendor discovery checks library subdirectories beneath `vendor`, `third_party`, `third-party`, and `staticfiles`, including nested copies of those directories and scoped npm packages. A library needs a `package.json` with a package name and version, or a `README.md` recording a versioned `registry.npmjs.org` archive. Directory names and file extensions alone never exclude code. Metadata identifies the library; it does not verify its integrity or security. Replacing a version is one update, and multiple copies of the same package count as one dependency with a combined footprint. For removed libraries the summary shows the removed size; for other changes it shows the size at HEAD.

Use the resource-scoped `scmDiffStats.vendorLibraries` setting for other vendored directories: `[{"name":"Example","path":"assets/example"}]`. Paths are exact repository-relative directories without wildcards or trailing slashes. Keep local adapters outside declared vendor directories. These declarations apply to both compared revisions; automatic metadata is read separately at each revision. Unidentified files retain normal complexity scoring.

The panel is a webview (custom HTML/CSS) — that is what allows colors and aligned columns, at the cost of the file-icon-theme glyphs a native tree would have.

## Install

Run `./build.sh` to package and install locally with the profile checks described below. Use `./build.sh --package-only` only when a package without installation is needed.

Keep the VS Code window for the target profile open. After installation, run **Ctrl+Shift+P → Developer: Reload Window**, then open **Minion HQ** from the Activity Bar.

Minion HQ updates the existing SCM Diff Stats installation. The extension ID `simon.scm-diff-stats` and `scmDiffStats.*` settings remain compatible with existing installations.

## Deploy

Keep the Kylie VS Code window open in its `minion-hq-minimal` profile. Run `/home/azrael/.local/bin/minion-hq-deploy` from any folder, optionally followed by a quoted commit message. It runs CI, commits all pending changes in its Minion HQ checkout, pushes that checkout's current branch to `origin`, and installs into the default profile and existing Minion HQ profiles in the target extension host.

Named WSL profiles are updated through their running windows. The headless WSL launcher ignores `--profile`, so its success message can leave the active profile on an older release. Deployment must verify the user's profile registration and installed files against the tested package; checking only the default profile or an existing version directory is insufficient. If a profile cannot be updated, open a VS Code window using that profile and rerun the deployment command.

After the target profile is verified, run **Ctrl+Shift+P → Developer: Reload Window** to activate the update. A failed check or push stops deployment; installation failure leaves the pushed commit available for retry. The command uses Node.js 24 from PATH or nvm; `NODE_BIN` overrides detection.

Install the command once from the desired checkout with `mkdir -p "$HOME/.local/bin"` and `ln -s "$PWD/deploy.sh" "$HOME/.local/bin/minion-hq-deploy"`. Keep that checkout on disk and include `$HOME/.local/bin` in PATH. The script follows the symlink to its checkout. Deployment accepts only worktrees of `/home/azrael/vscode-minion-hq`, the exact `git@github.com:Zymonick/vscode-minion-hq.git` origin, the existing release branch other than `master` or `main`, and the `simon.scm-diff-stats` extension. It pushes the current branch without merging it into another branch. Running `./deploy.sh` directly has the same behavior.

## Develop

Everything lives in `extension/extension.js` (plain JS, no build step, no dependencies).

Use Node.js 24, Python 3, and Bash. With nvm installed, run `nvm use` to select the project’s Node version. No npm dependencies are required.

```bash
./ci.sh                    # check syntax, run tests, and build the VSIX
./build.sh --package-only   # build without installing
./build.sh                 # build and install locally; then reload VS Code
```

Bump `version` in `extension/package.json` **and** in `extension.vsixmanifest` when releasing.

The same `./ci.sh` runs in GitHub Actions on every push and pull request. It only checks and packages the extension; it does not publish releases or install it. Locally, `NODE_BIN=/path/to/node ./ci.sh` selects a specific Node executable.

[AGENTS.md](AGENTS.md) defines the required completion workflow for agent changes. Generated `.vsix` files are ignored.
