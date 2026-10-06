These instructions govern Minion HQ work, including requests made from a Kylie chat. Minion HQ uses its own release workflow; Kylie's PR lifecycle and application design checkpoints do not apply to Minion HQ-only changes.

Resolve `/home/azrael/.local/bin/minion-hq-deploy` and work in the existing checkout containing its target `deploy.sh`. The user gives standing authorization to reuse and edit this release checkout even when it was created by an earlier task. Keep its existing non-main branch. Do not create a new worktree, branch, or PR unless the user requests one; do not repoint the deployment symlink as part of routine work.

Before edits, confirm the canonical common Git directory is `/home/azrael/vscode-minion-hq/.git`, fetch and push origin are exactly `git@github.com:Zymonick/vscode-minion-hq.git`, and the current branch is neither `master` nor `main`. Inspect pending changes and preserve unrelated user work. Use an explicit checkout path or working directory for direct Git commands. Never force-push or write main/master refs.

Read [CONTRACT.md](CONTRACT.md) before changing Minion HQ behavior. Keep its rules and focused regression tests current with intentional behavior changes.

Every completed Minion HQ change must be published to the pinned origin and installed in the user's local VS Code environment before handoff. The user gives standing authorization for both actions; do not request separate checkout, publishing, or installation confirmation. A pushed branch or PR alone is not completion.

Review the task's changes, preserve improvements already present in the installed extension, and keep the version in `extension/package.json` and `extension.vsixmanifest` aligned. Increase the version beyond the installed version when shipped extension contents change.

Use `/home/azrael/.local/bin/minion-hq-deploy`, optionally followed by one quoted commit message, to check, commit, push the existing branch, and install. This absolute command is the scoped Codex allow rule. It stages all pending changes: ensure the release includes only intended changes before invoking it. Do not include unrelated work or bypass a failed deployment check.

Verify the registered installed version and that its extension files match the tested build. State when VS Code needs `Developer: Reload Window` to activate an update. Report publishing or installation failures as incomplete work.
