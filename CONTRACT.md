# Minion HQ contract

## Repository order

Kylie appears first, followed by `pr-N` worktrees in ascending numeric order.
Other worktrees follow in natural folder-name order, with their full paths
breaking ties. This order applies during incremental loading, refreshes, and
repository additions or removals, regardless of Git's discovery order.
Rediscovering the same repositories in a different order must not restart
their active scan.

## Expansion

Opening a worktree row also opens its Vs master section, whatever state that
section was left in. Collapse All and Expand All set every worktree, section,
and commit at once; expanded commits load their files once.

## Line totals

Worktree, Staged, Changes, Vs master, collapsed worktree, and commit line totals
exclude root `docs/` files and the same CI, test, and identified vendor paths
as application complexity. Reuse the complexity path classifier and vendor
identification rules. Application templates, styles, and other unscored file
types still contribute their changed lines.

Classify additions by their destination path and revision, and deletions by
their source path and revision, including renames. Staged changes compare
HEAD with the index; unstaged changes compare the index with working files.
Untracked additions use working-copy vendor metadata. Reuse immutable vendor
metadata across refreshes; index and working metadata must remain current.
Line totals must work without qlty. Individual file counts, file visibility,
diffs, file counts, and commit counts retain excluded files.

## Complexity

The branch `cx` rating measures application code complexity. For Kylie, only
Kylie application code contributes. All CI and testing code is excluded,
including runners, checks, settings, fixtures, helpers, visual-test tools,
and CI orchestration. CI and test additions or removals must neither increase
nor offset the application rating.

CI and test scores remain visible in grey on individual files and in a separate
`CI and tests` total in the branch tooltip. Changes confined to CI and tests
show a neutral `cx 0` in expanded and collapsed worktree rows.

Classification applies to each revision's path, including renames:

- Directories named `test`, `tests`, `testing`, `spec`, `specs`, or `ci`,
  including underscore or hyphen suffixes, and `__tests__`, `__mocks__`,
  `.github`, `.gitlab`, `.circleci`, and `.buildkite`, contain excluded code.
- Test filenames include `test.*`, `tests.*`, `conftest.*`, `test_*`, `tests_*`, `spec_*`, `specs_*`,
  and names ending in `.test`, `.tests`, `.spec`, `.specs`, `_test`, `_tests`,
  `_spec`, or `_specs` before the extension, or capitalized `Test`, `Tests`,
  `TestCase`, `Spec`, or `Specs` suffixes.
- Kylie CI support paths also include `scripts/ci`, `scripts/ci.bash`,
  `scripts/ci_settings.py`, `scripts/audit_runner.py`, `scripts/quick_runner.py`,
  `scripts/quick_tests.py`, `scripts/land_checks.py`, `scripts/land_migrations.py`,
  `scripts/refresh-local-db`, `scripts/benchmark_request_timing.py`, and
  `kylie/management/commands/visual_baselines.py`.

New CI or test support paths must join these exclusions. Business code outside
these paths remains counted, including application CLI code. Directory or file
names that merely contain `ci`, `test`, or `audit` do not establish an exclusion.
Tests embedded in application files are not separated from their file's score.

Identified vendor libraries stay outside both totals. Scores compare the merge
base with the same HEAD used by the branch diff; unscored files show no score.

## PR readiness

Show one task status marker per PR using the landed Kylie's `pr_status` report.
Read the report through the integration runtime and `scripts/ci`, never through
an unlanded worktree copy. Do not duplicate proof-policy versions or completion
validation in the extension. Use a bounded, read-only subprocess within the
existing repository scan, with optional Git locks and Python bytecode writes
disabled. An unavailable runtime or malformed report shows `status unavailable`.

Preserve CI's specific labels for missing sign-off, outdated review, failed or
outdated checks, WIP, blocked work and ready-to-land work. Show the complete
readiness reasons, check result, agent review, owners and next actions in the
single marker's tooltip. Later operator steps remain separate from unfinished
PR work. Do not render a second check-result indicator. Landed and running CI
states take precedence and use their own tooltip, without superseded readiness
or check details. A stored green test file alone never means ready.

An optional `display_label` from CI appears as a separate neutral label before
the task status marker. Render custom text as escaped plain text, with its own
tooltip. The task marker retains its calculated text, colour, checks, review
and next actions. Landed and running CI states affect only the task marker;
the custom label remains while supplied by CI. Missing or empty labels add
no marker. `ci label TARGET TEXT` sets the label in the terminal; omitting
`TEXT` clears it. Reuse the existing readiness read and refresh lifecycle.

Minion HQ displays CI state without controls to create PRs, start previews,
run tests, land, commit, push, or launch repair agents. Run those actions in
the terminal. Legacy action messages and command settings do not enable them.
Keep file and diff navigation, refresh, expansion, and Claude and Codex per PR controls.
Use the existing refresh lifecycle; do not add polling or background jobs for
readiness.

## Claude per PR

Every PR row carries one Claude control; other rows have none. It opens the
PR's Claude session as the `claude` CLI in a VS Code terminal named
`Claude pr-N`, never in the Claude Code chat panel:

- A running `Claude pr-N` terminal is focused.
- Otherwise the PR's newest Claude session resumes with `claude --resume <id>`
  in the folder it started in. A session belongs to the PR when its id in
  `.ci/session-titles` has a title `scripts/rename-session` began with that
  `pr-N`, and its transcript lies in the Claude project directory of the PR
  worktree or of a workspace folder. Codex threads in the same registry and
  sessions of other projects do not count.
- A session that is already running is never resumed a second time: the
  terminal whose process tree holds it is focused, or, outside this window's
  terminals, a message names its pid. Liveness comes from Claude's session
  record with a matching process start time.
- Without a session, `claude` starts in the PR worktree, so its first prompt
  attaches it to the PR.

`claude` is the terminal's process, not a command typed into a shell. Minion HQ
sends no prompt and starts no CI run or agent work by itself. Clicking the
control never toggles the row. Look sessions up on click, never during refresh,
polling, or agent scans.

## Codex per PR

Every PR row also carries one small Codex terminal icon with a Codex tooltip,
opening the interactive CLI in a VS Code terminal named `Codex pr-N`. Focus
that terminal when it is running;
otherwise resume the newest matching session with
`codex resume --no-daemon --approve-for-me <id>` in its original folder.
Without a session, start `codex --no-daemon --approve-for-me` in the PR worktree.
Use automatic approval review with the workspace-write sandbox for both launches.
Launch without the shared background server so conflicting feature settings
cannot request a restart or change settings for other clients.

Match the PR title in `.ci/session-titles` to an unarchived Codex rollout whose
metadata confirms the session id, an interactive CLI or IDE source, and the PR
worktree or a workspace folder. Claude associations, non-interactive runs,
subagents, and other projects do not count. Use `.ci/codex-runtimes` when present
to preserve the session's executable, `CODEX_HOME`, and `CODEX_SQLITE_HOME`;
otherwise use the current Codex home and CLI. If a recorded executable is no
longer available, use `codex` on PATH or in `~/.local/bin` with the same stores.

A CLI identified by its resume id or open rollout is focused in this window's
terminal, or reported with its pid when outside the window. Background app
servers do not identify an interactive terminal. Concurrent clicks open only
one terminal. Session lookup runs only on click and reads bounded rollout
metadata. The CLI is the terminal's process; send no prompt, start no CI run,
and never toggle the PR row when the control is clicked.

## Installation

Deployment updates the default VS Code profile and each existing profile that
already registers Minion HQ in the target extension host. In WSL, use the VS Code
server profile registry and the live window CLI for named profiles; the
headless WSL launcher does not select them. Only use window connections that
already report Minion HQ installed. Inactive profiles must be opened before
retrying a deployment that cannot update them. Resolve profile names from VS Code metadata before
installation; missing names fail deployment. Use the VS Code CLI for all writes.
Verify each target profile registers the released version and its installed
files match the tested package, excluding only installer-added manifest metadata.
An existing version directory alone does not prove installation.
