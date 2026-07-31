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
  nur `101`). `gh sub-issue list` kennt kein `blockedBy` — die Dependencies der
  Kinder kommen aus der Karte unter „Dependencies" (ein `gh issue list`, lokal
  über die Issue-Nummer verknüpft).
- `milestone "<Name>"` → offene Issues des Milestones.
- `issues <N,N,...>` → genau diese, in dieser Reihenfolge.
- `next <N>` → die nächsten N offenen `agent-ready`-Issues nach Priorität, ohne
  blockierte (siehe „Dependencies" unten). Lauffähiges Muster (gh liefert JSON, die
  Filterung macht ein separater jq-Aufruf mit sauber gebundenen Variablen —
  gh-eigenes `--jq` kann keine `--argjson`):

      N=5   # gewünschte Anzahl
      CFG=.claude/workflow.config.json
      EXCL_JSON=$(jq -c '.excludeLabels // []' "$CFG")
      RE=$(jq -r '.milestoneExcludeRegex // ""' "$CFG")
      LIMIT=$(jq -r '.issueLimit // 300' "$CFG")
      DEPS=$(jq -r 'if has("respectDependencies") then .respectDependencies else true end' "$CFG")
      gh issue list -R "$REPO_SLUG" --state open --label agent-ready \
        --limit "$LIMIT" --json number,labels,milestone,blockedBy \
      | jq --argjson excl "$EXCL_JSON" --arg re "$RE" --argjson n "$N" --argjson deps "$DEPS" '
          map(select($re == "" or (((.milestone // {title:""}).title | test($re)) | not)))
        | map(select((.labels | map(.name)) as $l
            | ([$l[] | select(. as $x | $excl | index($x))] | length) == 0))
        | map(select(($deps | not)
            or (([(.blockedBy.nodes // [])[] | select(.state == "OPEN")] | length) == 0)))
        | sort_by(((.labels | map(.name) | map(select(startswith("priority/"))) | first) // "priority/P9"))
        | .[:$n] | map(.number)'

  Der Dependency-Filter steht mit Absicht VOR `.[:$n]` — sonst belegen blockierte
  Issues Slots, die in diesem Lauf nie starten könnten. `respectDependencies: false`
  in der CONFIG schaltet ihn ab (`$deps | not`; `// true` wäre hier falsch, weil jq
  auch `false` als leer behandelt).
  Vor dem ersten Lauf einmal read-only gegen das Repo testen (gefahrlos, nur Lesen).
- `resume [all] [max X]` → Wiederaufnahme liegengebliebener Arbeit statt Neuanfang:
  offene Issues mit Label `budget-exceeded` (mit `all` zusätzlich `needs-human`),
  zu denen ein OFFENER PR existiert (`gh pr list -R "$REPO_SLUG" --search
  "Closes #<N>" --state open`, Treffer gegen den PR-Body verifizieren — die
  Volltextsuche kann auch `#<N>XX` liefern). Je Treffer VOR dem Lauf:
  `gh issue edit <N> -R "$REPO_SLUG" --remove-label budget-exceeded
  --remove-label needs-human --add-label agent-ready`. Der Builder übernimmt den
  bestehenden PR über seinen Idempotenz-Schritt (Branch weiterführen, Draft
  wieder ready setzen) — Code und bereits gefundene Fehler werden nicht ein
  zweites Mal erarbeitet. Das Budget zählt im Resume-Lauf frisch. Ohne `all`
  bleiben `needs-human`-Issues bewusst liegen: dieses Label heißt, ein Mensch
  muss erst den gemeldeten Blocker (letzter Issue-Kommentar) entscheiden;
  `resume all` ist die explizite Operator-Zustimmung, es trotzdem erneut zu
  versuchen. Issues mit diesen Labels, aber OHNE offenen PR, gehören nicht in
  den Resume-Scope (nichts zum Aufsetzen) — sie im Abschlussbericht ausweisen.
- `max <X>` → harte Obergrenze der Einheiten für diesen Lauf.
- `gaps <Bereich> [max X]` → flowkit:issue im gaps-Modus aufrufen, dann die neu
  angelegten `agent-ready`-Issues abarbeiten. Mit explizitem `max` vollautonom;
  ohne `max` einmalige Freigabe der Liste via AskUserQuestion.

## Dependencies (GitHub-nativ, „blocked by")

GitHub kennt neben der Sub-Issue-Hierarchie eigene Issue-Dependencies (`blocked by` /
`blocks`) — ein anderes Konzept mit eigener API, siehe `hierarchy.md` im issue-Skill.
`gh` ab 2.94 liest sie über `--json blockedBy`; `gh api` ist dafür NICHT nötig (rote
Linie). Genau EIN Aufruf je Lauf, alles Weitere ist lokal:

    CFG=.claude/workflow.config.json
    LIMIT=$(jq -r '.issueLimit // 300' "$CFG")
    DEPS=$(jq -r 'if has("respectDependencies") then .respectDependencies else true end' "$CFG")
    gh issue list -R "$REPO_SLUG" --state open --limit "$LIMIT" --json number,blockedBy \
    | jq --argjson deps "$DEPS" '
        map({ (.number|tostring):
              (if $deps
               then [(.blockedBy.nodes // [])[] | select(.state == "OPEN") | .number]
               else [] end) })
      | add // {}'

Das Ergebnis ist die Karte `issue → offene Blocker`. Geschlossene Blocker fallen
hier schon raus (ein geschlossenes Issue blockiert nichts) — der Runner sieht nur
noch offene und muss den Zustand nie selbst nachschlagen.

- `epic` / `milestone` / `issues`: blockierte Issues NICHT aussortieren, sondern die
  Karte als `blockedBy: [<nummern>]` an die jeweilige Einheit hängen. Der Runner
  sortiert den Lauf danach (Blocker zuerst) und meldet am Ende, was dauerhaft
  blockiert blieb.
- `next <N>`: blockierte Issues fallen komplett raus (jq oben) — sie sind nicht „das
  Nächste" und kommen im Folgelauf dran, sobald ihr Blocker geschlossen ist.
- `respectDependencies: false` in der CONFIG schaltet beides ab (Default: `true`).

Pro Issue bestimmen: `lane` = "quick" wenn Label `flow/quick` UND kein `area/*` in
CONFIG.protectedAreas, sonst "full" · `size` aus dem `size/*`-Label (fehlt es: "M"
annehmen und im Issue nachlabeln) · `area` = erstes `area/*`-Label · `blockedBy` =
offene Blocker aus der Karte oben (leeres Array, wenn keine).

## Start

    Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/implement.workflow.js",
               args: { config: <CONFIG als Objekt>,
                       pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
                       units: [{ n: 123, lane: "full", size: "M", area: "backend",
                                 blockedBy: [] }, ...] } })

`pluginRoot` schaltet das deterministische Worktree-Cleanup frei
(`scripts/cleanup-worktrees.sh` im Plugin — die Auswahl, was entfernt werden
darf, trifft ein Script statt eines Agenten); fehlt es, fallen die
Cleanup-Stationen auf die Prompt-Regel zurück.

`blockedBy` darf fehlen (dann gilt die Einheit als unblockiert) und enthält
ausschließlich Issue-Nummern (Integer) — ein anderer Typ bricht den Lauf sofort ab,
statt still ewig zu blockieren.

## Stationen pro Issue (führt der Workflow aus)

1. **Planner** (nur full): frisch, read-only, postet Plan als Issue-Kommentar `<!-- plan:v1 -->`.
2. **Builder:** eigener Worktree, TDD (Skill superpowers:test-driven-development),
   lokale Gates aus CONFIG.commands + CONFIG.extraGates, Push via CONFIG.pushCommand,
   PR mit `Closes #N` und der Task-Checkliste des Plans als `### Tasks` im PR-Body
   (erledigt = abgehakt; ohne Plan entfällt der Abschnitt; Fix-Runden hängen ihre
   Punkte abgehakt an, die Liste wird nie gekürzt). Merged nie selbst.
3. **AC-Verifier:** frisch, Input nur Issue-Body + PR-Diff, Widerlegungsauftrag,
   Urteil als PR-Kommentar `<!-- ac-verify:v2 -->` — Tabelle plus maschinenlesbarer
   JSON-Block `{"verdicts":[{"ac","met","evidence"}]}`, ein Eintrag je AC.
   Folgerunden lesen den vorherigen Block, die Fix-Runde erhält das vorherige
   Verdict, und jede Regression (met → unmet) wird explizit ausgewiesen.
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
- **Dauerhaft blockiert** (Blocker außerhalb des Laufs und offen, oder Blocker im
  Lauf gescheitert/abgebrochen, oder Dependency-Zyklus): die Einheit wird EINMAL aus
  der Queue genommen — kein Requeue — und im Lauf-Bericht unter `blocked`
  ausgewiesen (`{ n, by: [<blocker>] }`). Kein Fehler, kein Stop: der Lauf macht mit
  den lauffähigen Einheiten weiter.
- `max X` erreicht oder Queue leer → regulärer Stop mit Bericht;
  CONFIG.caps.issuesPerRun deckelt jeden Lauf zusätzlich hart. Schneidet der Cap
  einen Blocker weg, wird sein Abhängiger mit zurückgestellt (sonst wäre er im
  ganzen Lauf garantiert blockiert).
- **Pre-Flight** (führt der Workflow aus): dirty Default-Branch, fehlende
  Branch-Protection oder gh-Auth-Problem → der Lauf startet gar nicht erst.

## Ground Truth und Resume

„gemergt/grün/erledigt" gilt nur nach gh-Verifikation, nie aus Agent-JSON. Nach
Abbruch in derselben Session: denselben Workflow mit `resumeFromRunId` starten —
erledigte Einheiten kommen aus dem Cache. Über Session-Grenzen hinweg ist der
Scope-Modus `resume` der Weg zurück zu liegengebliebener Arbeit.
Nach JEDEM Lauf-Ende den Lauf-Bericht persistieren:
`.flowkit/runs/<YYYY-MM-DDTHH-MM>-<scope>.json` — Inhalt: das Return-Objekt des
Workflows plus `scope` (der aufgelöste Auftrag) und `startedAt`. `.flowkit/` ist
gitignored; diese Dateien sind die dauerhafte Datenbasis für die
Budget-Kalibrierung (Token je size-Label, nur Läufe mit `tokenMode: "delta"`)
und das Aufwärm-Material für spätere Sessions. Der Lauf-Bericht enthält
Token-Verbrauch je Issue (Datenbasis für die Budget-Kalibrierung in Stufe 2). Wenn CONFIG.notify true ist: nach Lauf-Ende
den Kurzbericht (erledigt/offen/Stop-Grund) zusätzlich als Push-Benachrichtigung
senden (PushNotification-Tool, falls in der Session verfügbar; sonst überspringen).
