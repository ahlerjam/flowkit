# gh-Hierarchie und Sub-Issues

> REPO_SLUG kommt aus `.claude/workflow.config.json` (CONFIG.repoSlug).

- **Milestone:** Namen immer live via `gh milestone list -R "$REPO_SLUG"` abfragen.
  Ein Issue hat genau einen. GitHub vererbt Milestones NICHT — Kinder bekommen ihren
  explizit (`--milestone` beim Anlegen, üblicherweise der des Epic).
- **Epic:** Titelpräfix `[EPIC]` + Label `type/epic`.
- **Story:** Sub-Issue des Epic, Pflicht-Template aus SKILL.md.

Die lokale gh hat kein natives `--parent`, und `gh api POST` ist per Hook geblockt.
Also die Extension:

    gh extension list | grep -q gh-sub-issue || gh extension install yahsan2/gh-sub-issue
    # neues Kind direkt unter einem Parent (Extension kennt nur --body, kein --body-file):
    gh sub-issue create -R "$REPO_SLUG" --parent <PARENT_N> --title "feat: ..." --body "$(cat <file>)"
    # bestehendes Issue einhängen:
    gh sub-issue add <PARENT_N> <CHILD_N> -R "$REPO_SLUG"
    # lesen (ACHTUNG: --json liefert .subIssues[], kein Top-Array):
    gh sub-issue list <PARENT_N> -R "$REPO_SLUG" --json number,state | jq '.subIssues[]'
    # umhängen (--force überspringt den y/N-Prompt):
    gh sub-issue remove <PARENT_N> <CHILD_N> -R "$REPO_SLUG" --force

Die native Sub-Issue-Beziehung ist die einzige Wahrheit der Epic-Kind-Verknüpfung.
Keine Task-Listen-Spiegel im Epic-Body pflegen (driftet nur).

## Sub-Issue ≠ Dependency

Zwei getrennte GitHub-Konzepte mit getrennten APIs — ein Sub-Issue ist NICHT
automatisch von seinem Parent blockiert, und eine Dependency erzeugt keine
Hierarchie:

- **Sub-Issue** = Zerlegung („Teil von"). Steuert die Epic-Übersicht.
- **Dependency** (`blocked by` / `blocks`) = Reihenfolge („kann erst danach").
  Steuert, was der Runner wann anfässt (`CONFIG.respectDependencies`).

Dependencies kann `gh` ab 2.94 selbst, ohne `gh api` (rote Linie):

    # beim Anlegen
    gh issue create -R "$REPO_SLUG" --title "..." --body-file <file> --blocked-by <BLOCKER_N>
    # nachträglich setzen / lösen
    gh issue edit <N> -R "$REPO_SLUG" --add-blocked-by <BLOCKER_N>
    gh issue edit <N> -R "$REPO_SLUG" --remove-blocked-by <BLOCKER_N>
    # lesen (Blocker samt Zustand; nur OPEN blockiert wirklich)
    gh issue list -R "$REPO_SLUG" --state open --json number,blockedBy \
    | jq '[.[] | select(.blockedBy.totalCount > 0)]'

Nur echte Reihenfolge-Zwänge verdrahten (B braucht das Schema/die API aus A),
nicht bloße Themennähe — jede Dependency hält den Runner an, bis ihr Blocker
gemergt ist.
