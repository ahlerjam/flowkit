# flowkit

A Claude Code plugin for a universal, GitHub-issue-driven agent workflow:
the AI writes and grooms the backlog, an autonomous runner works it off with
hard per-issue budgets, model tiering and a layered verification stack —
built for solo developers who want autonomy **and** working results.

> Skill prompts are currently written in German. The workflow itself
> (labels, commands, config) is language-neutral.

## Install

```
/plugin marketplace add ahlerjam/flowkit
/plugin install flowkit@flowkit
```

Then, inside each target repository:

```
/flowkit:setup
```

Installing flowkit pulls in `superpowers` automatically (declared plugin
dependency). The setup is idempotent: it checks the optional companions
(browser-use, context7 — reported if missing), creates labels, a per-repo config
(`.claude/workflow.config.json`), permission/hook templates and (optionally)
a generalized PR-deep-review CI gate. Nothing lands on your default branch
directly — the install arrives as a pull request.

## Daily use

| Action | Command | Result |
|---|---|---|
| Idea → issue | `/flowkit:issue impuls "<one sentence>"` | Full spec issue (What/Why/Scope/AC + labels); low-risk issues become `agent-ready` automatically |
| AI finds work | `/flowkit:issue gaps <area> [max N]` | Spec issues labeled `needs-triage` — flipping the label to `agent-ready` is your only mandatory touchpoint |
| Work it off | `/flowkit:implement next N \| issues A,B \| epic N \| milestone "X" [max X]` | Autonomous run: Planner → Builder (TDD, isolated worktree) → PR check against GitHub → fresh AC verifier → PR deep review → auto squash-merge → post-merge smoke |
| Pick up stranded work | `/flowkit:implement resume [all]` | Re-opens `budget-exceeded` (with `all`: also `needs-human`) issues that have an open PR — the builder continues the existing branch, clears any stale abort label on the PR, instead of starting over; human commits on the branch are treated as ground truth |
| Lagebild | `/flowkit:status` | Read-only dashboard: label queues, stranded work, recent runs, budget calibration, template drift |
| Nachtlauf einrichten | `/flowkit:nightly` | Guardrail-gated setup of an unattended nightly `implement` run |

## Guardrails

- **Hard turn budget per issue** (by `size/S|M|L` label): overruns abort cleanly
  with a `budget-exceeded` label on the issue and its PR plus an explicit abort
  comment on the PR instead of burning tokens — the PR stays ready so the review
  pipeline still runs.
- **Issue-global fix-round state machine** (`maxFixRounds`): exactly one model
  escalation, then `needs-human` — the run moves on, never loops.
- **Infrastructure is retried, not debugged:** when a CI job dies before the
  test call (checkout, setup action, package download, runner provisioning) or
  its log carries a known infrastructure signature, the gate answers with
  `gh run rerun --failed` instead of a fix round — one rerun per red run, at
  most two per station. It never counts against `maxFixRounds`, so a broken
  package mirror no longer sends a unit to `needs-human`. A step that fails
  again is reproducible and is treated as a code problem. Extend the signature
  list via `ciInfraSignatures`.
- **Auto-merge only with active branch protection**; post-merge smoke check with
  a configurable `onSmokeFailure` policy (`revert` by default).
- **A merge the harness refuses is not a failed unit:** if the merge station
  comes back empty (an unattended merge can be stopped by the safety layer), a
  read-only diagnosis reads the real PR state and the scheduler decides — the PR
  is already merged (the unit counts as done, with the post-merge proof flagged
  as not run), or it is open, green and finished but unmerged (`merge-blocked`:
  labeled and commented on issue and PR, PR stays open and ready, waiting for a
  human merge), or genuinely not ready (`needs-human`, carrying the state that
  was read). The report never says "no result" again. A blocked merge counts as
  no progress, so a systemic block halts the run instead of repeating itself.
- **The builder's claim is checked against GitHub**, not believed: a `pr-check`
  station resolves the PR via `gh pr list --search "Closes #<n>"` right after the
  build, and every later station uses that number and branch. No PR on GitHub is
  a technical error, not a silent success.
- **A run that stops making progress stops** (`progressStopAfter`, default 3):
  after that many consecutive units without a merge the run halts and reports
  why, instead of burning the whole queue on a broken environment. A merge or a
  gh-verified skip resets the counter; `0` disables the breaker.
- **GitHub-native issue dependencies are respected** (`blocked by`, set via
  `gh issue edit --add-blocked-by`): blockers run first, blocked issues never
  occupy a slot, and anything that stays blocked is reported instead of retried
  forever. Set `respectDependencies: false` to opt out.
- **Verification is enforced structurally, not requested politely:** blocking CI
  gates, a fresh-context AC verifier with a refutation mandate (including a
  mechanical test-gaming check and a proof that new tests actually fail on the
  merge base), an independent PR review pipeline and command-level PreToolUse
  hooks.
- **Merge conflicts are never guessed away:** the gate resolves only pure
  append-conflicts in accumulating files (both entries survive); anything
  semantic aborts cleanly (`git merge --abort`, no half-merged worktree) into
  `needs-human` with the conflicting files listed — the run continues.
- **The deep review never pays twice for the same diff:** every merge updates
  the remaining PR branches (a `synchronize` event) — the review pipeline
  hashes the diff against the merge base and, when it is byte-identical to the
  last reviewed version, skips all LLM reviewer jobs and re-applies the stored
  verdict from the sticky comment. Any anomaly falls open toward a full
  review, never toward green-without-review.
- **Worktree cleanup is deterministic:** a script
  (`scripts/cleanup-worktrees.sh`), not an LLM, decides what may be removed —
  only worktrees whose branch carries the issue number as its own segment;
  main tree, detached and foreign worktrees are structurally out of reach.

## Configuration

Everything lives in `.claude/workflow.config.json` per repository — commands
(test/lint/typecheck/smoke), protected areas, parallelism, budgets, models,
auto-ready policy, markers and the merge check. See
`templates/workflow.config.json.template` and the JSON schema next to it.

## License

MIT
