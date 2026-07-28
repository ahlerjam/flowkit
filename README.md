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
  gates, a fresh-context AC verifier with a refutation mandate, a cross-vendor
  critic, an independent PR review pipeline and command-level PreToolUse hooks.

## Configuration

Everything lives in `.claude/workflow.config.json` per repository — commands
(test/lint/typecheck/smoke), protected areas, parallelism, budgets, models,
auto-ready policy, markers and the merge check. See
`templates/workflow.config.json.template` and the JSON schema next to it.

## License

MIT
