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
- **Setup never silently downgrades the deep-review CI pin:** before
  overwriting an existing `pr-deep-review.yml`, it reads the target repo's
  currently installed `anthropics/claude-code-action` SHA pin, compares its
  version against the template's with `sort -V` (never a lexical guess —
  `v1.0.9` looks newer than `v1.0.183` but is not), and keeps whichever pin is
  actually newer, reporting the outcome.
- **Setup makes what it writes versionable:** step 7 runs a `.gitignore` guard
  that asks `git check-ignore` (never a grep over the file) whether the config,
  settings, hooks and version stamp it just wrote are ignored, frees exactly
  those in one marker-delimited, root-anchored block, and re-checks instead of
  claiming success. Without it, a repo ignoring `.claude/` keeps the install
  local: the PR carries none of those files and the template-drift warning
  stays silent in every fresh clone. Lines are need-driven — nothing that was
  visible before gets hidden.
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
- **Open PRs do not rot behind the default branch:** an optional workflow
  (`templates/ci/pr-autoupdate.yml.template`, installed by step 6c of
  `/flowkit:setup`) merges the default branch into every open, non-draft,
  same-repo PR that has fallen behind it — the job a human otherwise does by
  hand after every merge so the required check stops hanging red or SKIPPED.
  It is plain `git`/`gh` on a GitHub-hosted runner, not a third-party
  container with write access to every branch. Three properties carry it:
  (1) **it does nothing without its own push credential** (deploy key or
  fine-grained PAT, both repo-scoped) — events from `GITHUB_TOKEN` do not
  create workflow runs, so a branch updated with it would carry a head with no
  checks at all and become permanently unmergeable; the token therefore keeps
  `contents: read` and the workflow declines rather than making things worse.
  (2) **It converges with the runner instead of locking against it:** both
  perform the same idempotent merge, never a rebase and never a force, so a
  rejected push is information — re-read, yield if the other actor already did
  the work, otherwise retry exactly once. The runner's gate stations carry the
  mirror rule. (3) **It never resolves a conflict:** `git merge --abort`, a
  `merge-conflict` label and one comment. The append rule of the gate hangs on
  an agent's judgement about what an accumulating file is; a shell step cannot
  make that call and is deliberately more conservative.
- **Worktree cleanup is deterministic:** a script
  (`scripts/cleanup-worktrees.sh`), not an LLM, decides what may be removed —
  only worktrees whose branch carries the issue number as its own segment;
  main tree, detached and foreign worktrees are structurally out of reach.

## Configuration

Everything lives in `.claude/workflow.config.json` per repository — commands
(test/lint/typecheck/smoke), protected areas, parallelism, budgets, models,
effort, auto-ready policy, markers and the merge check. See
`templates/workflow.config.json.template` and the JSON schema next to it.

The one thing that does *not* live there is the push credential for the PR
auto-update workflow: it is a repository secret, either
`FLOWKIT_AUTOUPDATE_SSH_KEY` (private half of a deploy key with write access —
one repo, git only, no API, no expiry, tied to no person) or
`FLOWKIT_AUTOUPDATE_TOKEN` (fine-grained PAT, Contents: read and write, this
repo only). Without one of them the workflow is inert by design. Its policy —
`autoUpdatePrBranches.enabled`, `skipLabels`, `maxPrs` — is read from the
config file at runtime, so changing it does not need another `/flowkit:setup`.

### Model tier vs. reasoning effort

`models` picks *which* model runs a station; `effort` picks *how much work* it
puts into the response. The two are independent — a station can run on a
cheaper model at high effort, or on a strong one at low effort — and the
escalation after a failed fix round raises both, from separate maps
(`models.escalation`, `effort.escalation`), so neither silently moves the
other.

Effort affects **all** tokens of a response, tool calls included: lower effort
means fewer and more consolidated tool calls and less preamble, higher effort
means more calls and more explanation. That is why the default is graded by
what a station actually does rather than by how important it is:

| Station | Default | Why |
|---|---|---|
| planner | `medium` (S/M), `high` (L) | Writes a plan, not code; the prompt supplies the structure. On L the plan carries the whole unit. |
| builder | `medium` (S/M), `high` (L) | The only station doing open-ended agentic coding. Anthropic's docs name `xhigh` as the starting point for that; this sits one step below on purpose — the same source calls `low`/`medium` the primary control for token cost and latency "wherever your evals show quality holds". Raise it if your own runs show headroom. |
| ac-verify | `high` | Works a fixed criteria list; thoroughness matters, exploration does not. |
| security | `high` | Same shape, but a missed blocker costs more than an extra round. |
| escalation | `xhigh` | A fix round that already stepped up a model tier gets more room too. |
| mechanical (haiku) | *unset* | Reads and writes state, no reasoning about code — and Haiku does not support the parameter at all. |

`max` is deliberately absent: per Anthropic's effort documentation it "adds
significant cost for relatively small quality gains" on most workloads and can
lead to overthinking on structured-output tasks. `high` equals omitting the
parameter — where it appears above it pins the value rather than raising it,
so a station no longer inherits whatever effort the operator's session had.

**Availability is handled for you, not left to you.** Not every model supports
every level, and the capability is *not* monotonic — Sonnet 4.6 and Opus 4.6
support `max` but not `xhigh` ("xhigh is a newer level; some models that
support max don't support xhigh"), while Sonnet 5 supports both. Haiku does not
support the parameter at all. The workflow therefore keeps a capability map and
resolves the value against the station's *effective* model: an unsupported
level falls back to the highest supported level below it (an escalation onto
Sonnet 4.6 sends `high`, not `xhigh`), and a station on Haiku gets no parameter.
Unknown model strings are assumed to support everything — a name the map does
not know is usually a newer model, and silently downgrading it would be worse
than the error the engine would raise. Source:
`platform.claude.com/docs/en/build-with-claude/effort`, retrieved 2026-08-06.

## License

MIT
