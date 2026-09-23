# Minion HQ

A command center for your worktrees, diffs, and branch tools in VS Code. Open **Minion HQ** from the Activity Bar to see changes, test status, previews, and running agents.

For every repository / git worktree open in the workspace:

- Line totals exclude the repository's root `docs/` directory and all its descendants in worktree, Staged / Changes, Vs master, and commit rows. Those files remain visible with their individual counts and diffs; file and commit counts still include them.
- **Staged / Changes** — each file with green `+added` / red `−deleted` line counts in aligned columns next to a colored git status letter (M/A/D/R/U). Untracked files count their lines as additions. Clicking a file opens its diff.
- **Vs master** — for branches other than `master`: how many commits the branch is **behind master** (red `↓N`), total `+x −y` relative to the merge base (`git diff master...HEAD`, so master moving ahead doesn't pollute the numbers), and a per-file drill-down; clicking opens a merge-base ↔ working-tree diff.
- **Complexity** — a `cx +N` column on the Vs master rows: how much the branch raised (orange) or lowered (green) the cognitive complexity of each changed source file, and the total, scored with [`qlty metrics`](https://qlty.sh) at the merge base and at HEAD (hover for the absolute numbers and the cyclomatic delta). Templates, docs and other files qlty does not score show no number. Needs the `qlty` CLI (`~/.qlty/bin/qlty`, PATH, or `scmDiffStats.qltyCommand`); without it the column stays away. Scoring happens in a scratch git repository under the OS temp dir, never in the project, and every git blob is scored once and cached there.
- **PR identity** — a `pr-N` worktree row carries the label and status its agent sessions are titled with (`pr-N [green]: case number labels`), read straight from the CI state beside the worktrees: the three lowercase words of `.ci/pr-N.slug`, behind `#<case> - ` when `ci case N <number>` recorded one, and a coloured `[landed]` / `[testing]` / `[green]` / `[open]` marker. This needs no `ciCommand` — that setting only gates the CI buttons. The ✚ button accepts the case number in front of the three words (`#6654 three word summary`).
- **Commits** — outgoing commits when an upstream exists, otherwise the most recent ones, each with `+x −y` vs its parent. Expanding a commit lazy-loads its files; clicking opens the parent ↔ commit diff for that file.
- **Excluded worktrees** — `scmDiffStats.excludePaths` drops rows for checkouts that are nobody's work (an agent tool's scratch clones, a CI verify worktree). Patterns match the worktree's absolute path and its folder name, `*` inside one path segment and `**` across them; a pattern without a wildcard also excludes everything under it.
- Hover tooltips with `+x −y` on the **built-in** SCM rows (via a `FileDecorationProvider`).
- Auto-refreshes on git state changes and file saves; manual ↻ button in the panel title. Rows appear as each repository finishes, with a loading message while other rows remain pending. Complexity scores follow after all basic rows are available, using the same commit as the displayed branch diff. Refreshes collect at most two repositories at once and combine requests received during a scan into one follow-up. Rediscovering an unchanged repository list does not restart a scan. Read-only Git queries leave the index untouched; untracked file reads are asynchronous.
- CI buttons use interactive process task terminals so Python shell auto-activation cannot interrupt command startup. The panel refreshes when a CI task finishes.

The panel is a webview (custom HTML/CSS) — that is what allows colors and aligned columns, at the cost of the file-icon-theme glyphs a native tree would have.

## Install

Build the `.vsix` with `./build.sh --package-only`, then:

```bash
code --install-extension minion-hq-<version>.vsix
```

Then reload the window and open **Minion HQ** from the Activity Bar.

Minion HQ updates the existing SCM Diff Stats installation. The extension ID `simon.scm-diff-stats` and `scmDiffStats.*` settings remain compatible with existing installations.

## Deploy

Run `minion-hq-deploy` from any folder, optionally followed by a quoted commit message. It runs CI, commits all pending changes in its Minion HQ checkout, pushes that checkout's current branch to `origin`, and builds and installs the extension locally. A failed check or push stops deployment; installation failure leaves the pushed commit available for retry. Reload the VS Code window after installation. The command uses Node.js 24 from PATH or nvm; `NODE_BIN` overrides detection.

Install the command once from the desired checkout with `mkdir -p "$HOME/.local/bin"` and `ln -s "$PWD/deploy.sh" "$HOME/.local/bin/minion-hq-deploy"`. Keep that checkout on disk and include `$HOME/.local/bin` in PATH. The script follows the symlink to its checkout and pushes the current branch without merging it into another branch. Running `./deploy.sh` directly has the same behavior.

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

Before pushing, run `./ci.sh`, review your changes, then commit the source and `.github/workflows/ci.yml`. Generated `.vsix` files are ignored.
