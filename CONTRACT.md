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

## Sections

A worktree with a `master` comparison shows one Vs master section: the diff
from its merge base with `master` to the working tree, including staged,
unstaged, and untracked files. Untracked files show as added. Each file with
uncommitted changes carries an `uncommitted` marker, and the section row
counts them. These worktrees show no Staged or Changes section, and their
expanded row shows no line totals. A checkout without a `master` comparison,
such as `master` itself, shows Staged and Changes sections.

## File groups

Staged, Changes, Vs master, and commit file lists show their files in groups,
in this order: Code, Migrations, CI and tests, Scripts, Docs, Other, Vendor. A
group appears only when it has files and lists them in natural path order. Each
file goes to the first group that matches its destination path:

- Vendor: identified vendor library files on either side.
- Docs: root `docs/` files and `.md`, `.markdown`, or `.rst` files.
- CI and tests: the CI and test paths of [Complexity](#complexity).
- Migrations: files in a directory named `migrations`.
- Scripts: files in a `script`, `scripts`, or `bin` directory, and shell or
  batch files.
- Code: source, template, and style files.
- Other: all remaining files.

A group row shows its file count and all lines of its files, without the
line-total exclusions. Each group collapses separately. Collapse All and Expand
All reopen every group, so an opened section shows its files.

## Line totals

Worktree, Staged, Changes, Vs master, collapsed worktree, and commit line totals
exclude root `docs/` files and the same CI, test, migration, and identified
vendor paths as application complexity. Reuse the complexity path classifier and vendor
identification rules. Application templates, styles, and other unscored file
types still contribute their changed lines.

Classify additions by their destination path and revision, and deletions by
their source path and revision, including renames. Staged changes compare
HEAD with the index; unstaged changes compare the index with working files.
Untracked additions and uncommitted Vs master additions use working-copy
vendor metadata. Reuse immutable vendor
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

Identified vendor libraries and migration files, in a directory named
`migrations`, stay outside both totals and show no score; each side of a rename
is classified by its own path. Scores compare the merge
base with the same working files used by the branch diff; unscored files show
no score.

Each scored refresh writes the worktree row's rating to
`~/.cache/minion-hq/complexity/<worktree folder>.json` for agents: repository
path, `head`, `mergeBase`, `cx` (the shown application rating), the
`application` and `checks` totals, and the cognitive and cyclomatic change of
each scored file with its exclusion. A file is rewritten only when its content
changes and is never deleted; it rates the working tree, and `head` names the
commit under it.

A PR row also shows the agent's estimate of the smallest application
complexity increase that the PR's requests need, as a neutral `est +N` before
`cx` on the collapsed worktree row and the Vs master row. The agent keeps it in
`docs/PR_N/cx_estimate.json` of the working tree: an integer `cx`, with an
optional `prompt` time and `reason` for the tooltip. Read the file within the
existing repository scan; a missing or malformed file shows no estimate.
A measured application `cx` above the estimate shows in red in both rows.

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

A PR origin that `ci new --from M` or `--on M` records in `.ci/pr-N.from`
appears as a neutral `(->pr-M)` marker before the custom label, as in the
session title. A missing or malformed file, or one that names the PR itself,
adds no marker.

An optional `conflicts` list in the `pr_status` report names the open PRs whose
own changes conflict with this PR's. It appears as a warning-coloured
`conflicts 802, 805` marker after the custom label and before the task status.
An empty or missing list adds no marker, a landed row shows none, and a list
with anything other than positive integers makes the report malformed.

Minion HQ displays CI state without controls to create PRs, start previews,
run tests, land, commit, push, or launch repair agents. Run those actions in
the terminal. Legacy action messages and command settings do not enable them.
Keep file and diff navigation, refresh, expansion, and Claude, Codex and screenshot per PR controls.
Use the existing refresh lifecycle; do not add polling or background jobs for
readiness.

## Claude per PR

Every PR row carries one Claude control; other rows have none. It opens the
PR's Claude session as the `claude` CLI in a VS Code terminal, never in the
Claude Code chat panel. Do not assign a fixed terminal name: Claude's live
title shows `◐`/`◑` while it works and `✳` while it is idle or waiting for input.
Associate each terminal with its PR path in `MINION_HQ_CLAUDE_PR` so title
changes do not open duplicate terminals:

- A running terminal of the PR is focused, including an existing `Claude pr-N`
  terminal.
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
opening the interactive CLI in a VS Code terminal. Name the terminal
`pr-N · Codex`, with the PR number first so it stays visible in narrow tabs.
Use this fixed name instead of the CLI's live activity title: resumed sessions
can have a title without a PR and an original folder outside the PR worktree.
Do not change global settings, poll session state, or start background jobs.
Existing terminals retain their current labels until reopened from the PR control.
Associate each terminal with its PR path in `MINION_HQ_CODEX_PR` so title
updates and manual renames do not open duplicate terminals. Continue to
recognize existing `Codex pr-N` terminals. Focus that terminal when it is running;
otherwise resume the newest matching session with
`codex resume --remote unix:// --approve-for-me <id>` in its original folder.
Without a session, start `codex --remote unix:// --approve-for-me` in the PR
worktree. Prepare the same home's local server with the bounded, idempotent
`codex app-server daemon start` before opening the terminal; report startup
failure without opening a disconnected terminal. A later click may retry.
Use automatic approval review with the workspace-write sandbox for both launches.
Connect directly to the shared server so sessions open in the desktop app or
another window remain the same conversation. Do not restart the shared server
or change its feature settings to match the terminal.

Match the PR title in `.ci/session-titles` to an unarchived Codex rollout whose
metadata confirms the session id, an interactive CLI or IDE source, and the PR
worktree or a workspace folder. Claude associations, non-interactive runs,
subagents, and other projects do not count. Use `.ci/codex-runtimes` when present
to preserve the session's executable, `CODEX_HOME`, and `CODEX_SQLITE_HOME`;
otherwise use the current Codex home and CLI. If a recorded executable is no
longer available, use `codex` on PATH or in `~/.local/bin` with the same stores.

A CLI identified by its resume id or open rollout is focused in this window's
terminal. A CLI outside this window does not block opening a terminal connected
to the shared server. Background app servers do not identify an interactive
terminal. Legacy standalone terminals retain their writer until closed; do not
terminate them, remove writer locks, or fork the conversation automatically.
Concurrent clicks open only one terminal. Session lookup runs only on click and
reads bounded rollout metadata. The CLI is the terminal's process; send no prompt, start no CI run,
and never toggle the PR row when the control is clicked.

## Screenshots per PR

A PR row carries a picture control when `kylie-shots/PR_N` beside the worktrees
folder, or one of its direct subfolders, holds a PNG, WebP, JPEG or GIF image.
Its tooltip gives the image count and the `taken` time of `shots.json`, when
present. Detect the set within the existing repository scan; add no polling.

Clicking the control opens one editor tab per PR, named `pr-N · Screenshots`,
and never toggles the row. The tab shows CI's `index.html` with its relative
image links loaded from the set folder, then every image of the set the page
does not show, in natural path order. Without `index.html` it shows all
images. The tab loads resources only from the set folder and runs only its own
script; links outside the set go nowhere. Clicking an image opens that file
full size in an editor. A later click re-reads the set and reuses an open tab.

## Editor placement

Files, diffs, images, and screenshot tabs open in the last editor group.
Floating editor windows hold the last groups, so these editors open there and
leave the main window's layout unchanged.

## Installation

Deployment scripts and installer tests must support Python 3.8, including
when the caller has activated Kylie's virtual environment.

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
