# Changelog

All notable changes to the flowkit plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions 0.2.0 through 0.5.0 were reconstructed retroactively from the git history.

## [Unreleased]

## [0.5.0] - 2026-07-31

### Added
- Review cache in the PR deep-review pipeline: `render.py` embeds the sha256
  of the bounded diff in the sticky comment, the new `cache_check.py` skips
  all reviewer jobs and re-applies the stored findings when the diff against
  the merge base is byte-identical (a BEHIND update after a disjoint merge no
  longer burns a full re-review). Any anomaly fails open toward a full
  review, never toward green-without-review. (#17)

## [0.4.0] - 2026-07-31

### Added
- Resume mode: new scope mode `resume [all]` in the implement skill — the
  builder takes over open PRs (draft to ready) and treats human commits on
  the branch as ground truth. (#3)
- `commands.setup` config field: bootstrap command for fresh worktrees
  (e.g. `uv sync --extra dev`, `npm ci`), run as step 0 by builder, fix
  rounds and verifier.
- Deterministic worktree cleanup: `scripts/cleanup-worktrees.sh` with test
  suite; cleanup stations call the script instead of relying on prompt
  discipline.
- Run reports persisted to `.flowkit/runs/` after every run (data base for
  budget calibration).

### Changed
- Gate step 3b: pure append conflicts in accumulating files are resolved
  keeping both sides; anything semantic aborts via `git merge --abort` into
  needs-human with the conflicting files listed. (#2)
- AC verifier hardening: mechanical test-gaming check on the diff plus a
  proof that at least one new test fails on the merge base.

### Fixed
- Worktree cleanup is scoped to the failing issue's own branch — a cleanup
  agent can no longer remove worktrees of running peer units or earlier
  runs. (#4)

## [0.3.0] - 2026-07-28

### Added
- The implement runner respects GitHub-native issue dependencies
  ("blocked by"): blocked issues are never picked before their blockers are
  merged, unsatisfiable units are reported as `blocked` instead of requeued.
  New config field `respectDependencies` (default `true`, requires
  gh >= 2.94 for `--json blockedBy`). (#1)

## [0.2.1] - 2026-07-26

### Changed
- `flowkit:issue` enforces exactly one `size/*` label at creation (the
  runner derives the token budget from it) and creates missing repo labels
  idempotently.
- The implement runner cleans up the builder worktree and local feature
  branch after a gh-verified merge — previously only failure paths cleaned
  up.

## [0.2.0] - 2026-07-26

### Added
- Review convergence alert after 3 consecutive review rounds with blocking
  findings on the same file, carried via the sticky comment's JSON marker.
- Proportionality clause for defense-in-depth artifacts in the code-review
  prompt (judge against the documented scope statement).

### Changed
- Review pipeline template bumped to Opus 5.

### Fixed
- Hardening round: protected-areas taxonomy fix with fail-fast guard in the
  runner; gate commands joined with `&&` so a failing test can no longer be
  masked; 45-minute cap on the gate check-watch loop; settings template with
  complete runner verb allowlist and fail-closed blocker hook invocation;
  blocker hook covers short delete flags and implicit/attached `gh api`
  mutations.
