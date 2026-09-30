# Minion HQ contract

## Repository order

Kylie appears first, followed by `pr-N` worktrees in ascending numeric order.
Other worktrees follow in natural folder-name order, with their full paths
breaking ties. This order applies during incremental loading, refreshes, and
repository additions or removals, regardless of Git's discovery order.
Rediscovering the same repositories in a different order must not restart
their active scan.

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

Task completion and technical check results are separate. A stored green test
file never means ready. Show WIP, blocked, verification needed, or ready, with
an independent smoke/configuration/CI/full-suite result. Landed and running CI
states take precedence.

Ready requires a single ready marker, clean worktree, valid current development
proof, and CI's versioned completion seal matching HEAD, the tracked completion
record hash, tested base and proof policies/fingerprint. Missing, malformed or
stale evidence fails closed with a reason. Master movement requires integration
verification. Legacy PRs have no inferred completion.

Land controls are disabled unless ready and revalidate current state when
clicked. CI remains authoritative at execution. The test button invokes the
supported fast test command without retired repair flags. Use the existing
refresh lifecycle; do not add polling or background jobs for readiness.
