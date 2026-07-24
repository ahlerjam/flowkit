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
