---
name: implement
description: Use when a defined scope of this repository should be built autonomously — an epic number, a milestone, an issue list, "the next N issues", or "find gaps in area X" — and the operator wants no further interaction until done or stopped.
---

# flowkit:implement — autonomer Runner

> Konventionen und rote Linien: `AGENTS.md` im Repo-Root (IMMER zuerst lesen).
> Repo-Spezifika: `.claude/workflow.config.json` (CONFIG — zuerst laden und gegen
> das Schema des Plugins plausibilisieren; fehlt sie oder fehlt CONFIG.repoSlug:
> STOPP mit Hinweis auf /flowkit:setup. Keine stillen Defaults für repoSlug).
> Orchestrierung: `${CLAUDE_PLUGIN_ROOT}/workflows/implement.workflow.js`
> (`CLAUDE_PLUGIN_ROOT` = von Claude Code gesetzte Env-Var mit dem absoluten
> Pfad zur Wurzel dieses Plugins).

## Zusage an den Operator

Ein Aufruf, danach keine Rückfrage bis fertig oder Stop. Qualität kommt aus den
Stationen (frischer AC-Verifier, Critic, Review-Gate), nicht aus Zwischenfragen.
Jedes Issue hat ein hartes Budget (CONFIG.budgets je size-Label) — Überschreitung
bricht sauber ab statt weiterzubrennen.

## Scope auflösen (im Hauptkontext, via gh; REPO_SLUG=CONFIG.repoSlug)

- `epic <N>` → offene Sub-Issues des Epic, gefiltert um `CONFIG.excludeLabels`
  (gleiche Filterlogik wie bei `next <N>` unten, angewandt auf `gh sub-issue list`):

      CFG=.claude/workflow.config.json
      EXCL_JSON=$(jq -c '.excludeLabels // []' "$CFG")
      gh sub-issue list <N> -R "$REPO_SLUG" --json number,state,labels \
      | jq --argjson excl "$EXCL_JSON" '
          .subIssues[] | select(.state=="OPEN")
          | select((.labels | map(.name)) as $l
              | ([$l[] | select(. as $x | $excl | index($x))] | length) == 0)
          | .number'

  Getestet gegen Beispiel-JSON (`{"subIssues":[{"number":101,"state":"OPEN",
  "labels":[{"name":"area/backend"}]},{"number":102,"state":"OPEN","labels":
  [{"name":"type/operator"}]},{"number":104,"state":"OPEN","labels":
  [{"name":"type/epic"}]}]}` mit `excl=["type/operator","type/epic"]` → liefert
  nur `101`).
- `milestone "<Name>"` → offene Issues des Milestones.
- `issues <N,N,...>` → genau diese, in dieser Reihenfolge.
- `next <N>` → die nächsten N offenen `agent-ready`-Issues nach Priorität. Lauffähiges
  Muster (gh liefert JSON, die Filterung macht ein separater jq-Aufruf mit sauber
  gebundenen Variablen — gh-eigenes `--jq` kann keine `--argjson`):

      N=5   # gewünschte Anzahl
      CFG=.claude/workflow.config.json
      EXCL_JSON=$(jq -c '.excludeLabels // []' "$CFG")
      RE=$(jq -r '.milestoneExcludeRegex // ""' "$CFG")
      LIMIT=$(jq -r '.issueLimit // 300' "$CFG")
      gh issue list -R "$REPO_SLUG" --state open --label agent-ready \
        --limit "$LIMIT" --json number,labels,milestone \
      | jq --argjson excl "$EXCL_JSON" --arg re "$RE" --argjson n "$N" '
          map(select($re == "" or (((.milestone // {title:""}).title | test($re)) | not)))
        | map(select((.labels | map(.name)) as $l
            | ([$l[] | select(. as $x | $excl | index($x))] | length) == 0))
        | sort_by(((.labels | map(.name) | map(select(startswith("priority/"))) | first) // "priority/P9"))
        | .[:$n] | map(.number)'

  Vor dem ersten Lauf einmal read-only gegen das Repo testen (gefahrlos, nur Lesen).
- `max <X>` → harte Obergrenze der Einheiten für diesen Lauf.
- `gaps <Bereich> [max X]` → flowkit:issue im gaps-Modus aufrufen, dann die neu
  angelegten `agent-ready`-Issues abarbeiten. Mit explizitem `max` vollautonom;
  ohne `max` einmalige Freigabe der Liste via AskUserQuestion.

Pro Issue bestimmen: `lane` = "quick" wenn Label `flow/quick` UND kein `area/*` in
CONFIG.protectedAreas, sonst "full" · `size` aus dem `size/*`-Label (fehlt es: "M"
annehmen und im Issue nachlabeln) · `area` = erstes `area/*`-Label.

## Start

    Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/implement.workflow.js",
               args: { config: <CONFIG als Objekt>,
                       units: [{ n: 123, lane: "full", size: "M", area: "backend" }, ...] } })

## Stationen pro Issue (führt der Workflow aus)

1. **Planner** (nur full): frisch, read-only, postet Plan als Issue-Kommentar `<!-- plan:v1 -->`.
2. **Builder:** eigener Worktree, TDD (Skill superpowers:test-driven-development),
   lokale Gates aus CONFIG.commands + CONFIG.extraGates, Push via CONFIG.pushCommand,
   PR mit `Closes #N`. Merged nie selbst.
3. **AC-Verifier:** frisch, Input nur Issue-Body + PR-Diff, Widerlegungsauftrag,
   Urteil als PR-Kommentar `<!-- ac-verify:v1 -->`.
4. **Critic** (wenn CONFIG.critic.enabled): Cross-Vendor-Review via flowkit:critic,
   P0/P1 blocken.
5. **Security-Pass** (nur wenn ein `area/*` in CONFIG.protectedAreas liegt): eigener
   frischer Agent VOR dem Merge (Injection, AuthZ, Secrets, Test-Gaming-Querblick).
6. **Gate + Merge:** CONFIG.mergeCheck abwarten, P0/P1 adressieren, Merge-Checks,
   Squash-Merge, unabhängige gh-Verifikation, Post-Merge-CI + CONFIG.commands.smoke
   (falls gesetzt; rot → onSmokeFailure-Policy + keine weiteren Merges).
   Alle Fix-Runden aus 3.-6. zählen zusammen auf das EINE issue-globale
   CONFIG.maxFixRounds.
7. **Post-Merge-Cleanup** (best-effort): Builder-Worktree entfernen und den
   lokalen Feature-Branch löschen — der Erfolgspfad hinterlässt sonst
   Worktree-Drift (Erstlauf-Befund 2026-07-26).

## Stop-Regeln (Zustandsautomat, Spec §6)

- **Inhaltlicher Gate-Fail** (AC-Verifier/Critic/Security/Review-Gate nach
  erschöpftem maxFixRounds nicht grün): die EINHEIT stoppt — Label `needs-human`,
  PR bleibt als Draft mit Kommentar; der LAUF fährt mit dem nächsten Issue fort.
  Eskalation passiert INNERHALB der Einheit: ab Fix-Runde 2 laufen Fixes genau
  eine Modellstufe höher (CONFIG.models.escalation).
- **Technischer Fehler** (Crash, Infra, gh-Ausfall): erster Fehler → Cleanup +
  Queue-Ende (transient); zweiter technischer Fehler derselben Einheit → Lauf
  stoppt mit Bericht.
- **Budget-Überschreitung** → Einheit sauber abgebrochen (Kommentar, Label
  `budget-exceeded`, PR auf Draft, Worktree-Cleanup), zählt NICHT als Fehler,
  Lauf geht weiter.
- `max X` erreicht oder Queue leer → regulärer Stop mit Bericht;
  CONFIG.caps.issuesPerRun deckelt jeden Lauf zusätzlich hart.
- **Pre-Flight** (führt der Workflow aus): dirty Default-Branch, fehlende
  Branch-Protection oder gh-Auth-Problem → der Lauf startet gar nicht erst.

## Ground Truth und Resume

„gemergt/grün/erledigt" gilt nur nach gh-Verifikation, nie aus Agent-JSON. Nach
Abbruch: denselben Workflow mit `resumeFromRunId` starten — erledigte Einheiten
kommen aus dem Cache. Der Lauf-Bericht enthält Token-Verbrauch je Issue (Datenbasis
für die Budget-Kalibrierung in Stufe 2). Wenn CONFIG.notify true ist: nach Lauf-Ende
den Kurzbericht (erledigt/offen/Stop-Grund) zusätzlich als Push-Benachrichtigung
senden (PushNotification-Tool, falls in der Session verfügbar; sonst überspringen).
