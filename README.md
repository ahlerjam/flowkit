# flowkit

A Claude Code plugin for a universal, GitHub-issue-driven agent workflow:
the AI writes and grooms the backlog, an autonomous runner works it off with
hard per-issue budgets, model tiering and a five-layer verification stack —
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

The setup is idempotent: it checks companion plugins (superpowers, browser-use,
context7 — optional, reported if missing), creates labels, a per-repo config
(`.claude/workflow.config.json`), permission/hook templates and (optionally)
a generalized PR-deep-review CI gate. Nothing lands on your default branch
directly — the install arrives as a pull request.

## Daily use

| Action | Command | Result |
|---|---|---|
| Idea → issue | `/flowkit:issue impuls "<one sentence>"` | Full spec issue (What/Why/Scope/AC + labels); low-risk issues become `agent-ready` automatically |
| AI finds work | `/flowkit:issue gaps <area> [max N]` | Spec issues labeled `needs-triage` — flipping the label to `agent-ready` is your only mandatory touchpoint |
| Work it off | `/flowkit:implement next N \| issues A,B \| epic N \| milestone "X" [max X]` | Autonomous run: Planner → Builder (TDD, isolated worktree) → fresh AC verifier → critic → PR deep review → auto squash-merge → post-merge smoke |
| Pick up stranded work | `/flowkit:implement resume [all]` | Re-opens `budget-exceeded` (with `all`: also `needs-human`) issues that have an open PR — the builder continues the existing branch instead of starting over; human commits on the branch are treated as ground truth |
| Standalone second opinion | `/flowkit:critic <PR>` | Cross-vendor review via Codex CLI; without Codex access a narrowly-scoped Claude fallback takes over (clearly marked) |

## Guardrails

- **Hard turn budget per issue** (by `size/S|M|L` label): overruns abort cleanly
  with a `budget-exceeded` label and a draft PR instead of burning tokens.
- **Issue-global fix-round state machine** (`maxFixRounds`): exactly one model
  escalation, then `needs-human` — the run moves on, never loops.
- **Auto-merge only with active branch protection**; post-merge smoke check with
  a configurable `onSmokeFailure` policy (`revert` by default).
- **GitHub-native issue dependencies are respected** (`blocked by`, set via
  `gh issue edit --add-blocked-by`): blockers run first, blocked issues never
  occupy a slot, and anything that stays blocked is reported instead of retried
  forever. Set `respectDependencies: false` to opt out.
- **Verification is enforced structurally, not requested politely:** blocking CI
  gates, a fresh-context AC verifier with a refutation mandate (including a
  mechanical test-gaming check and a proof that new tests actually fail on the
  merge base), a cross-vendor critic, an independent PR review pipeline and
  command-level PreToolUse hooks.
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
