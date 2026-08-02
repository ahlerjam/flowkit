# Changelog

All notable changes to the flowkit plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions 0.2.0 through 0.5.0 were reconstructed retroactively from the git history.

## [Unreleased]

## [0.8.0] - 2026-08-01

### Added
- `pr-check` station: right after the builder the runner asks GitHub itself
  (`gh pr list --search "Closes #<n>" --state all`) and takes PR number, branch
  and state from that answer. Every later station works off the verified PR.
  Ambiguous matches, a closed PR and an empty branch name are all treated as
  "no usable result". (#31, #33)
- Progress circuit breaker: a run now stops after `progressStopAfter`
  consecutive units without a merge (needs-human, budget abort or technical
  error); a merge or a gh-verified skip resets the counter, blocked units do
  not count. Default 3, `0` disables it. (#31)
- Merge diagnosis station and the new `merge-blocked` state: when the merge
  station returns nothing (the harness can stop an unattended merge) or reports
  `merged != true`, a read-only station reads the real PR state — `state`,
  `mergedAt`, green/red/pending check counts and the configured `mergeCheck` —
  before the unit is judged. The scheduler, not the agent, then picks one of
  three outcomes: a merge gh confirms counts as a success, but the post-merge
  proof did not run, so the unit reports `postMerge: "unmeasured"` plus
  `postMergeUnverified: true` rather than claiming green; a PR that is open,
  green and finished (no red and no pending check) becomes `merge-blocked` —
  label and comment on issue and PR, the PR stays open and ready, the run
  continues, dependents do not start; everything else stays `needs-human`, now
  carrying the state that was read instead of "kein Ergebnis". A blocked merge
  counts as no progress for the circuit breaker, because a harness-side block is
  systemic rather than PR-specific. New report fields: `done[].mergeBlocked` and
  `done[].postMergeUnverified`. `/flowkit:setup` creates the `merge-blocked`
  label (existing repos need to re-run it, otherwise the label call fails
  silently and the state only shows up in the run report); `/flowkit:status`
  lists the queue and a new `merge-blocked` / `post-merge-unmeasured` tally, and
  the SessionStart hook points at a manual merge instead of a resume. (#37)
- Pin registry test: every `uses: anthropics/claude-code-action@…` line in the
  CI template must be byte-identical to one canonical, SHA-pinned line, and a
  separate check rejects a moving tag (`@v1`, `@main`, …) at any of those
  positions. CI also resolves the pinned SHA against its version comment
  upstream and warns (non-blocking) once a newer tag exists. Pins drifting
  apart or a half-finished bump now fail the build instead of going unnoticed
  for 46 patch releases, which is what happened before this fix. (#38)
- `.gitignore` guard: `/flowkit:setup` step 7 now runs
  `scripts/gitignore-guard.sh`, which asks `git check-ignore` whether
  `.claude/flowkit-version`, `.claude/settings.json`,
  `.claude/workflow.config.json` and `.claude/hooks/*.sh` are ignored, writes
  the required negations as one marker-delimited, root-anchored block
  (`# >>> flowkit` … `# <<< flowkit`), re-checks afterwards and reports every
  path that stays ignored (exit 3) instead of claiming success. In repos that
  ignore `.claude/` the install PR previously carried none of the files setup
  had just written, so the installation was purely local and the
  template-drift warning stayed silent in every fresh clone, in CI and in every
  runner worktree. Each line is need-driven: what was visible before stays
  visible, and `!/.claude/` is root-anchored so a monorepo's `pkg-*/.claude/`
  is not exposed. The runtime artefacts `.flowkit/` and `.claude/worktrees/`
  are ignored by the same block. The block is rebuilt on every run, so a second
  `/flowkit:setup` produces no duplicate lines. Existing installations are not
  migrated — the guard takes effect the next time `/flowkit:setup` runs. (#39)
- `scripts/test-templates-vendor-neutral.sh`, wired into CI: keeps `templates/`
  — copied verbatim into every target repo by `/flowkit:setup` — free of
  cloud/SaaS provider names. (#40)

### Changed
- The merge station's post-merge proof is now three-valued: the gate return
  changed from `postMergeGreen: boolean` to
  `postMerge: "green" | "red" | "unmeasured"`, and run reports carry
  `done[].postMerge` instead of `done[].postMergeRed`. Operators who parse
  `.flowkit/runs/*.json` need to adapt. (#32)
- The `needs-human` and budget-abort paths no longer set the PR back to draft.
  The "do not merge" signal now travels as a label on the PR (`needs-human` /
  `budget-exceeded`) plus an explicit, idempotent abort comment (first line
  `<!-- flowkit-abort:v1 -->` — a repeated abort with the same reason does not
  post twice). The PR stays ready, so the deep-review pipeline — which skips
  drafts by design, taking its verdict with it — still produces the findings
  the human taking over needs. The builder strips those labels when it takes
  an existing PR over, and the merge station refuses to merge a PR that still
  carries one (`gh pr view --json labels`); this is a prompt-level guard on the
  cheapest model in the pipeline, not the hard server-side block the draft
  state used to be. PRs an earlier flowkit version left as draft are healed on
  `resume`; without it, a manual `gh pr ready <N>` is still required. (#35)
- `/flowkit:setup` no longer silently downgrades the `claude-code-action` CI
  pin: before overwriting an existing `.github/workflows/pr-deep-review.yml`
  it compares the installed pin's version against the template's with
  `sort -V` (never a lexical guess — `v1.0.9` looks newer than `v1.0.183` but
  is not), keeps a newer installed pin, and reports which pin ended up
  installed. (#38)
- The shipped blocker test is provider-neutral: the Hetzner-specific
  `HCLOUD_TOKEN` case became `MY_TOKEN`, and every keyword of the hook's secret
  alternation (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `APIKEY`) now has its
  own `must_block` case — previously only `TOKEN` and `API_KEY` did. A
  completeness probe (template mode only, so it does not penalize a repo's own
  hardening of its installed hook) derives the keyword list from the hook
  under test and fails when a branch has no `MY_<KEYWORD>=` case, so new
  alternation branches cannot stay untested. The installed hook's comment also
  lost its dangling reference to a source document that never shipped with
  flowkit. Regex behaviour is unchanged. (#40)
- Existing installations need one more `/flowkit:setup` run to pick up
  0.8.0: the new `merge-blocked` label, every allowlist entry added this
  release (plugin script paths, `gh pr edit`, `gh run rerun`,
  `git check-ignore`, `git merge-base`, `git revert`,
  `tail`/`head`/`awk`/`sort`/`uniq`) and the changed hook templates only
  reach a repo that way — there is no migration mechanism for
  `.claude/settings.json` beyond the merge rule setup step 5 already has.

### Fixed
- Post-merge proof no longer treats a cancelled CI run as a failure (#32). The
  merge station anchors on the PR's own merge commit
  (`gh pr view --json mergeCommit`), waits for `status: completed` before
  reading `conclusion`, and only `failure`/`timed_out` on that commit (or a red
  smoke command) trigger the `onSmokeFailure` policy. Any other conclusion is
  re-measured against the most recent completed default-branch run that
  contains the merge commit — the usual case under
  `concurrency: cancel-in-progress`, where the next merge kills the previous
  post-merge run. That run also covers foreign commits, so it may only confirm
  green: a red result there stays inconclusive instead of reverting a healthy
  squash commit. If it stays inconclusive the unit reports
  `postMerge: "unmeasured"`: no revert PR, no run stop, just a log line and the
  field in the report.
- Gate-wait no longer burns the full 45-minute window on a PR that can never
  report a green required check: it resolves the draft state first
  (`gh pr view --json isDraft,headRefOid`, then `gh pr ready` — the deep-review
  pipeline skips drafts by design, so the required check comes back SKIPPED
  instead of SUCCESS), counts the workflow runs on the PR's own head SHA when gh
  reports "no checks reported" and re-triggers exactly once. A station that does
  not go green now returns `{ green: false, draftAtEntry, runsFound,
  retriggered, note }` instead of throwing, the resulting `GATE:` message names
  all three, and the needs-human comment repeats the reason verbatim instead of
  paraphrasing it away. The same three fields are reported as `done[].gateDiag`
  on the success path too — otherwise the most common case, a draft the station
  quietly healed, would leave no trace in `.flowkit/runs/*.json`. (#34)
- A builder that produced no PR — e.g. because the Bash permission classifier
  was unavailable — is a technical error instead of a silent success, a
  reported `pr: 0` is healed from the gh result instead of failing the unit,
  and a claimed skip is only accepted with a merged PR on GitHub. (#31, #33)
- A CI job that dies in its setup phase (package download, runner provisioning,
  checkout) is no longer debugged as if it were a test failure: gate-wait first
  diagnoses which step failed (`gh run view --json jobs`, `--log-failed`) and
  answers a known infrastructure signature with `gh run rerun --failed` before
  spending a fix round — one rerun per red run, at most two per station, since
  `--failed` acts per run and one outage usually hits several workflows. The
  rerun never counts against `maxFixRounds` and stays allowed once the fix
  budget is exhausted; a step that fails again is reproducible and is treated as
  a code problem. Repo-specific signatures via the new `ciInfraSignatures`
  config field (empty strings rejected — they would match every log). Whether a
  rerun happened is readable in the run report as `done[].gateDiag.infraRerun`
  and is named in the `GATE:` message, so it survives the needs-human path as
  well. (#36)
- `/flowkit:setup` allowlists the plugin's own script paths
  (`bash <pluginRoot>/scripts/*`, `python3 <pluginRoot>/scripts/*`,
  `bash <pluginRoot>/templates/hooks/*`) plus previously missing prefixes
  (`gh pr edit`, `gh run rerun`, `git check-ignore`, `git merge-base`,
  `git revert`, `tail`, `head`, `awk`, `sort`, `uniq`), and the runner no
  longer quotes those paths unnecessarily — Bash permission rules are prefix
  patterns, so a leading quote made every such rule useless. (#31)

## [0.7.0] - 2026-07-31

### Added
- Knowledge compounding: after every merged issue a best-effort haiku station
  distills transferable learnings to `.flowkit/learnings/`; planner and
  builder read the 10 most recent distillates. Config switch `learnings`
  (default true). (#27)
- Run-level token cap for parallel runs: with `parallelism > 1` the run stops
  starting new units once global spend exceeds the sum of unit budgets ×
  `runBudgetFactor` (default 1.2); deferred units are reported as
  `deferredByBudget`. The exact per-issue cap at `parallelism: 1` is
  unchanged. (#27)
- Template version stamping + drift warning: setup stamps every copied file
  and writes `.claude/flowkit-version`; the SessionStart hook warns when the
  installed templates lag behind the plugin. (#25)
- Repo CI running all six test suites on every PR, plus local tests for the
  critical review-pipeline shell steps (#29)
- Operator commands: `/flowkit:status` (read-only dashboard),
  `/flowkit:nightly` (guardrail-gated unattended night runs), and the
  `prd` mode in flowkit:issue (PRD → epic + child issues with blocked-by
  graph). (#26)
- Plugin dependency on `superpowers` (auto-installed via
  `claude-plugins-official`; cross-marketplace allowlist set).

### Removed
- The cross-vendor critic station — entirely: the Codex CLI integration, the
  Claude fallback review, the `flowkit:critic` skill, `critic`/
  `models.critic`/`markers.critic` config and the `codex exec` permission.
  The PR deep-review pipeline with its adversarial verifier proved strictly
  stronger in live use; the critic was redundant token spend.

### Changed
- Token savings: gate-wait and gate-merge stations run on haiku (mechanical
  work — waiting, merge commands, gh verification); dead-code and doc-sync
  reviewers in the CI pipeline default to haiku (triage over pre-filtered
  input). Code review and the adversarial verifier stay on opus.

## [0.6.0] - 2026-07-31

### Added
- Builder mirrors the plan's task checklist into the PR body as `### Tasks`
  and keeps it growing across fix rounds — reviewers see live progress. (#6)
- Machine-readable AC verdict: the verifier comment carries a JSON block
  (`{"verdicts":[{ac,met,evidence}]}`), fix rounds receive the previous
  verdict, regressions (met → unmet) are called out explicitly; default
  marker bumped to `<!-- ac-verify:v2 -->` (repos pinning v1 in
  `markers.acVerify` keep the old wording without regression diffing). (#8)
- Budget telemetry: `scripts/budget_report.py` aggregates per-issue token
  spend from `.flowkit/runs/` (delta runs only) into median/p90 per size
  label plus a config suggestion — never applied automatically. (#7)
- SessionStart hook lists stranded work (budget-exceeded / needs-human
  issues with their open PRs) and hints `/flowkit:implement resume`. (#15)
- Machine-readable config migration list (`templates/config-migrations.json`)
  consumed by setup; this changelog. (#16)
- Scheduler core test suite: `node scripts/test-implement-workflow.mjs`,
  11 cases covering cap coherence, dead blockers, dependency cycles, the
  WAIT signal and merge-lock serialization, mutation-hardened. (#10)

### Changed
- Merge-lock split: the gate now waits for green checks OUTSIDE the merge
  lock; only BEHIND update, conflict handling and the merge itself are
  serialized — parallel units no longer wait on each other's CI. (#9)
- pr-deep-review generalized: `criticalPaths` replaces hardcoded
  source-project paths, `deadCode: auto|on|off` gates the Python-only
  dead-code job, iac-safety scopes to `iacChangePaths`; gates.yml documents
  removing the typecheck step when no command is configured. (#11)
- Prompt-injection hardening: PR/issue context is sanitized and every
  reviewer prompt declares diff + context as untrusted data. (#12)
- Gap-scan weekly cap counts only `seed/gap-scan`-labeled issues, not every
  issue created that week. (#14)

### Fixed
- Override label is read live by the gate (event snapshot went stale — the
  label could never unblock a red PR without a new push); label events
  re-trigger the check cheaply via the review cache. (#13)
- Admin agents in the runner's failure paths (needs-human, budget abort,
  error cleanup) are now guarded: a transient agent failure no longer
  crashes the whole run or re-queues a budget-exceeded unit (found by the
  new scheduler test suite).
- Stray `__pycache__` artifacts removed from the repo; `.gitignore` added.

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
