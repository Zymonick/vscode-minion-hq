Every completed Minion HQ change must be published to `origin` (`git@github.com:Zymonick/vscode-minion-hq.git`) and installed in the user's local VS Code environment before handoff. The user gives standing authorization for both actions; do not request separate publishing or installation confirmation. A pushed branch or PR alone is not completion.

Review the task's changes, preserve improvements already present in the installed extension, and keep the version in `extension/package.json` and `extension.vsixmanifest` aligned. Increase the version beyond the installed version when shipped extension contents change.

Run `./deploy.sh` from the task's checkout to check, commit, push the task branch, and install. Use `minion-hq-deploy` only after verifying that its symlink targets the intended checkout. Preserve unrelated user changes.

Verify the registered installed version and that its extension files match the tested build. State when VS Code needs `Developer: Reload Window` to activate the update. Report publishing or installation failures as incomplete work.
