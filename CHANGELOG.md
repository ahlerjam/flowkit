# Changelog

All notable changes to the flowkit plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions 0.2.0 through 0.5.0 were reconstructed retroactively from the git history.

## [0.9.0] - 2026-08-06

### Fixed
- Effort is decided by the station's *effective model*, not by its name. A repo
  that puts `models.planner` or `models.verifier` on haiku was getting an
  `effort` value on a model that does not support the parameter. The security
  pass also picked its model from a second expression inlined at the call sites
  (`M.verifier || 'sonnet'`) instead of from `modelFor`, so the model and effort
  decisions could drift apart; `modelFor` now covers it and is the single
  source. (#45)
- The hook checks the whole command line again, message text included. An
  earlier attempt at #44 exempted the quoted value behind `-m`/`--body`/`--title`
  via `sed` so that a commit *describing* the patterns would not self-block. That
  is withdrawn: `sed` has no shell-quoting context, so the exemption could be
  turned into a bypass. `git commit -m "x -t 'y" ; rm -rf / ; echo "z'"` passed
  the hook — the pattern matched the bait switch inside the double-quoted value
  and elided across the command separator, hiding a `rm -rf /` the shell really
  runs. The same held for `gh pr create --body "… -t 'x" ; git push --force
  origin main ; …`, for `"… '$(…)' …"` (the shell expands it, the first pass
  removed it), for a secret assignment placed in a PR body, and for `ssh -t
  '<command>'` since the rule keyed on the flag rather than the program. A filter
  that can be disarmed with its own switch is worse than none, because it looks
  like protection. The bypasses are now regression tests so the approach cannot
  return unnoticed. #44 stays open; a correct exemption needs a real shell lexer
  bound to the invoking program. Workaround meanwhile: `git commit -F <file>`.
  (#44, reverted after code review)
- Effort is resolved against a model *capability map*, not a single "does this
  model support the parameter" flag. The capability is not monotonic — Sonnet 4.6
  and Opus 4.6 support `max` but not `xhigh`, Sonnet 5 supports both — so an
  upper bound would have been the wrong structure. An unsupported level now falls
  back to the highest supported level below it instead of going to the engine
  unchecked: an escalation onto Sonnet 4.6 sends `high`. The check also matches by
  containment rather than equality, so a repo that writes the full model name
  (`claude-haiku-4-5`) instead of the alias is covered too. Unknown names keep all
  levels — a name the map does not know is usually a newer model. (#45, from code
  review)
- `effort.planner`/`effort.builder` written as a plain string instead of an
  `{SM, L}` map now stops the run. `Object.assign({}, {SM, L}, "low")` yields
  `{SM, L, 0:"l", 1:"o", 2:"w"}` — both required keys survive with valid values,
  so the value check saw nothing wrong and the run silently continued on the
  default while the operator believed the setting had taken effect. (#45, from
  code review)
- `Bash(git merge --continue)` is back in the allowlist. Narrowing `git merge*`
  dropped it, but the merge and gate-wait prompts allow exactly one conflict
  resolution (pure append conflicts) and instruct the station to commit the
  merge — without the rule an unattended run stalls on a permission prompt on the
  one path we declared resolvable. (#42, from code review)
- The hook's diagnostic line now names the rule class it hit, e.g.
  `blocked dangerous pattern [pipe-to-shell]`. It previously printed the
  protected-branch list on *every* hit, which pointed the diagnosis in the wrong
  direction and never said which pattern matched. The branch list now only
  appears for `protected-branch-push`, the override label only for
  `override-label`. (#44)
- `| sh` followed by anything other than whitespace or end-of-line — most
  notably `… | sh)` inside a command substitution — was not blocked. The right
  boundary now accepts any non-identifier character while still keeping
  `shasum`, `shuf` and `sort` out. Same fix for the `curl … | python3` class.
  (found while testing #44)

### Changed
- `Bash(git merge*)` in `settings.json.template` is a prefix match and also
  covered `git mergetool` — a command whose `mergetool.<tool>.cmd` is a freely
  choosable command line that may come from a `.git/config` the runner did not
  write — plus `merge-file`, `merge-index` and `merge-tree`. It is replaced by
  the two calls the runner actually makes: `Bash(git merge origin/*)` and
  `Bash(git merge --abort)`. The same review found `Bash(git diff*)`, which
  covered `git difftool` (same class of problem, `difftool.<tool>.cmd`); it
  becomes `Bash(git diff)` plus `Bash(git diff *)`. All remaining `git`/`gh`
  subcommand prefixes were checked against the full command lists of git 2.51 and
  gh 2.96; `git commit*` and `git fetch*` stay deliberately wide (they only reach
  plumbing that writes objects or reads packs, never an external program) and are
  now recorded as such with their reason. As a second line of defence the hook
  blocks `git mergetool`/`git difftool` outright, which also protects a repo that
  has widened the allowlist again on its own. (#42)

### Added
- `effort` config section: reasoning effort is now set per station instead of
  every station inheriting whatever effort the calling session happened to run
  at. `models` picks *which* model, `effort` picks *how much work it puts in*;
  the two are separate maps and the escalation after a failed fix round raises
  both from `models.escalation` and `effort.escalation`, so neither silently
  moves the other. Defaults: planner `medium`/`high` (S/M vs L), builder
  `medium`/`high`, ac-verify `high`, security `high`, escalation `xhigh`; the
  mechanical Haiku stations get no value at all, because Haiku does not support
  the parameter. Invalid values (including `adaptive`, which is a *thinking*
  mode, not an effort level) stop the run at the config guard rather than being
  passed through. Rationale and the availability caveat for `xhigh` are in the
  README. (#45)

  Research basis: `platform.claude.com/docs/en/build-with-claude/effort`,
  retrieved 2026-08-06. Three findings shaped the defaults. Effort affects
  *all* tokens including tool calls, so per station the question is how broadly
  it may work, not how clever it should be. `xhigh` is the level Anthropic
  names as the starting point for coding and agentic work — which here is
  exactly one station, the builder; the default deliberately sits one step
  below it, because the same source calls `low`/`medium` the primary control
  for token cost and latency "wherever your evals show quality holds". That is
  a cost decision to re-check against real runs, not a correction of the
  guidance. And the issue's suspicion that more effort is not monotonically
  better checks out, but not where it was expected: the documented overthinking
  risk sits at `max` ("adds significant cost for relatively small quality
  gains… can lead to overthinking"), not between `medium` and `high` — so `max`
  appears nowhere in the defaults, and no station was lowered on that theory.
- Config-migration coverage assertion: every top-level key in
  `workflow.config.json.template` must be either in the pre-0.3.0 baseline or
  in `config-migrations.json`, and every migration must point at a key the
  template still has. Existing repos only ever receive new config keys through
  that list, so a key added to the template alone works via the built-in
  default but stays invisible and unadjustable in the operator's own config —
  which is exactly what happened to `effort` on the first pass.
- Rule-class completeness probe in `test-pretooluse-blocker.sh`, mirroring the
  existing one for the secret alternation: every `rule` class in the hook needs
  a `must_block_as` case, so the rule list can't grow without its diagnostic
  ever being checked.
- Hardening assertion for subcommand prefixes: every `Bash(git <sub>*)` /
  `Bash(gh <topic> <sub>*)` rule must match exactly one real subcommand or be
  listed in `WIDE_SUBCOMMAND_PREFIXES` with a reason. The existing assertion only
  looked at the first word of a rule and could not see this class at all. A rule
  for a namespace with no entry in the subcommand registry fails the test rather
  than passing silently. A counter-test pins that the narrowed rules still cover
  the runner's real calls. (#42)
- Test for the `pin_decision=error-no-template-pin` branch of the downgrade
  guard: with a template that has no findable pin the guard must abort with
  exit 2 and print that one line and nothing else. Mutation probe: with the
  branch removed the guard reports `keep-installed` with an empty
  `pin_template` — success claimed, target-repo pin left standing. (#43)
- Test pair right at the secret regex's length threshold: 15 characters pass,
  16 block. Mutation probe: changing the repetition to `{17,}` turns the
  16-character case red. (#43)

## [0.8.0] - 2026-08-02

### Added
- `pr-check` station: right after the builder the runner asks GitHub itself
  (`gh pr list --search "Closes #<n>" --state all`) and takes PR number, branch
  and state from that answer. Every later station works off the verified PR.
  Ambiguous matches, a closed PR and an empty branch name are all treated as
  "no usable result". (#31, #33)
- Progress circuit breaker: a run now stops after `progressStopAfter`
  consecutive units that finished without a merge (needs-human, budget abort,
  externally blocked merge, or the second technical attempt of the same unit); a
  merge or a gh-verified skip resets the counter, blocked units and requeued
  transient first failures do not count. Default 3, `0` disables it. (#31)
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
  `scripts/gitignore-guard.sh`, which asks `git check-ignore --no-index` whether
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
  migrated — the guard takes effect the next time `/flowkit:setup` runs.
  Three things the guard deliberately refuses to do, each pinned by a test:
  it measures against the ignore *rules* (`--no-index`), not against the index —
  reading the index made every already-tracked path look "not ignored", so the
  run after the documented install commit shrank the block to `/.flowkit/`,
  reported success (the re-check was blind for the same reason) and left
  `git add .claude/hooks/<new>.sh` failing; it recognises the END marker by the
  same prefix as the BEGIN marker and aborts (exit 1, file untouched) when a
  marked block has no END marker at all — an END line one byte off, from CRLF
  normalisation or a hand edit, used to delete everything from the BEGIN marker
  to EOF including the target repo's own rules and still report `fixed`; and it
  rejects a path that is not the work-tree root (exit 1) instead of silently
  writing a monorepo's root `.gitignore` with a block that cannot help
  `pkg-a/.claude/`. (#39)
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
- The blocker hook now also refuses interpreter escapes, the class that turns a
  single allowlist entry into a blanket approval: `awk` reaching a shell
  (`system(…)`, `| "sh"`, `| getline`), a pipe into `sh`/`bash`/`zsh`/`ksh`/`dash`
  (`curl … | sh`), a download piped into `python`/`perl`/`ruby`/`node`, and an
  absolute interpreter path that traverses out of its directory
  (`bash /…/scripts/../../x.sh`) — the shape that would slip past the
  `Bash(bash <plugin>/scripts/*)` prefix rule. Every rule has both a blocking
  and a non-blocking test case, so the pipelines the runner itself uses
  (`… | awk '{print $4}' | sort | uniq -d`, `… | tail -n 300`) keep running.
  (#31)
- Existing installations need one more `/flowkit:setup` run to pick up
  0.8.0: the new `merge-blocked` label, every allowlist entry added this
  release (plugin script paths, `gh pr edit`, `gh run rerun`,
  `git check-ignore`, `git merge-base`, `git revert`, `tail`/`head`/`sort`/
  `uniq` and the two literal `awk '{print $4}'` entries, quoted and unquoted)
  and the changed hook templates only reach a repo that way — there is no
  migration mechanism for `.claude/settings.json` beyond the merge rule setup
  step 5 already has.
- Allow rules for plain commands carry a word boundary (`Bash(tail *)`, not
  `Bash(tail*)`, which also covers `tailscale …`), and `awk` is allowed only as
  the one literal call the merge station's malformed-tree check makes. A prefix
  rule on a program-text interpreter is not a narrow permission at all:
  `Bash(awk *)` approves `awk 'BEGIN{system("…")}'`, and with it every command,
  in an unattended run that reads untrusted issue and PR text. A test now fails
  the build for either shape.

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
  reports "no checks reported" and re-triggers exactly once. That re-trigger is a
  real BEHIND update — `git merge origin/<default branch>` in its own worktree,
  pushed — because that is the only measure that actually starts a run: on the
  two PRs of the incident, `gh pr ready` produced no Actions run at all and an
  empty commit produced none either, while the update had the pipeline running
  within seconds. A draft toggle and `git commit --allow-empty` are therefore
  ruled out in the prompt, as is `gh run rerun` (there is no run to repeat). The
  update runs outside the merge lock, which is safe because it writes to the
  unit's feature branch, never to the default branch, and the merge station
  re-checks BEHIND later anyway — but it follows that station's conflict rule to
  the letter: only a pure append conflict is resolved, anything else is
  `git merge --abort` with nothing pushed and the conflicting files in the note.
  If the branch already contains the default branch the merge would be a no-op
  that pushes nothing, so nothing is triggered and the finding is reported
  instead; after a successful update the run count is measured against the new
  head SHA. The draft *check* stays: a draft PR cannot get a green required
  check, so establishing that still comes before any waiting. A station that does
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
- The progress circuit breaker no longer voids the runner's own retry, and it no
  longer depends on how many workers are running (#31):
  - A technical error that is requeued as transient does not count. It is not a
    finished outcome — the runner cleans up and rebuilds the unit. Counting it
    meant that three units each hitting one network or classifier hiccup halted
    a run that 0.7.0 would have merged end to end, in every existing repo and
    without any opt-in. Counted are the outcomes that are actually final:
    `needs-human`, budget abort, externally blocked merge and the *second*
    technical attempt of the same unit (which stops the run anyway, with the
    concrete error instead of the breaker text).
  - The counter is updated the moment an outcome is known, no longer after the
    admin agent has finished. The success path reported synchronously while both
    failure paths reported only after `await needsHumanStop(...)` /
    `await cleanupUnit(...)`, so with `parallelism > 1` failures were sorted
    behind successes: the same sequence of outcomes stopped a healthy run purely
    because more workers were running. `parallelism` 3 is the shipped default.
- "No further merges" after a red post-merge proof now also holds for units that
  are already parked in the merge chain (#32). `stopped` only keeps *new* units
  from starting; a unit that was waiting for the lock when the proof came back
  red went on to merge while the revert PR was open — and since the proof waits
  in the lock for up to ten minutes, that is exactly the window in which
  finished units pile up. The merge station now sets and checks the halt inside
  the lock; a parked unit ends as `needs-human` naming the unit whose post-merge
  proof was red. Only a red post-merge halts merges — a breaker or double-fault
  stop still lets a finished, green-verified unit merge.
- A merge the station deliberately refuses no longer reaches the operator as
  "the PR is green and finished, only the merge approval is missing" (#35, #37).
  The merge prompt demanded a `GATE:` throw for an abort label on the PR and for
  a semantic merge conflict, but `GATE_SCHEMA` (`additionalProperties: false`)
  had no return value for it — under a forced schema the only valid way out was
  `merged: false`, which routes into the merge diagnosis, and that station reads
  neither labels nor mergeability. It saw an open, green, finished PR and asked
  a human to merge by hand exactly the PR an earlier run had marked as not
  mergeable. The station now reports `blocked: "abort-label" | "conflict"` and
  the workflow raises the `GATE:` abort itself, before the diagnosis; a thrown
  error remains equivalent, and `blocked: "none"` (or a missing field) leaves the
  `merge-blocked` path untouched.
- The two abort stations no longer risk labelling and commenting on a foreign
  PR. Both verified their search hit with "body contains `Closes #<n>`", which
  is true of `Closes #4123` for issue 41; both run on haiku without a schema and
  without a JS-side re-check. They now use the same rule as the pr-check station
  (the match must be bounded on the right by a non-digit or end of line) and, if
  more than one verified hit remains, mutate nothing on any PR and report the
  ambiguity on the issue instead. The builder's idempotency search uses the same
  rule.
- An ambiguous PR result (two verified open PRs with `Closes #<n>`) is a
  `needs-human` instead of a technical error (#31). The pr-check station detects
  the case deliberately, but `runUnit` could not tell it from "no PR at all": the
  unit was requeued including a second builder run, and the identical second
  result stopped the whole run with neither label nor comment on the issue. The
  station now reports `ambiguous: true` (new, optional field in
  `PRCHECK_SCHEMA`), the runner raises a `GATE:` naming the candidates, and the
  needs-human station leaves both PRs untouched.
- Builder and pr-check no longer prioritise MERGED and OPEN against each other
  (#31, #33). The builder checked for a merged PR first, the station requires
  OPEN before MERGED. When both states exist — an issue reopened after a merge
  plus an open PR from a needs-human run — both stations behaved exactly as
  prompted and the unit threw anyway, without a `GATE:` prefix, so it was
  requeued and the second attempt reproduced the same constellation and stopped
  the run. The builder prompt now carries the station's priority rule, and a
  claimed skip against an open PR takes that PR over instead of throwing.
- The budget check after the build no longer overtakes the `skipped` path (#31).
  It was moved in front of the pr-check station on purpose — a builder that
  blows its budget usually has no PR yet — but that also put it in front of an
  already-finished issue, which then got `budget-exceeded`, lost `agent-ready`
  and left its dependents permanently blocked for work that was long since
  merged.
- A CI infrastructure signature only counts in a step that runs before the
  actual test/lint/review invocation (#36). `gh run view --log-failed` prints
  the failed step's output in full, and `operation timed out` is also the
  message of a legitimately failing timeout test — as a bare substring match it
  triggered a rerun that just re-measured the same red test. The signature is
  now evidence for such a step rather than a trigger of its own; a runner that
  dies mid-step stays infrastructure.
- Area serialisation counts in-flight units per area instead of holding a set of
  areas. Two units of one area can legitimately run at once (the fallback in
  `pickNext` allows it when nothing else is runnable); the set released the area
  on the first completion, after which the preference pulled another unit of the
  busy area ahead of a unit from a genuinely free one.
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
