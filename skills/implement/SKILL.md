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
Stationen (frischer AC-Verifier, Review-Gate, Deep-Review-Pipeline), nicht aus Zwischenfragen.
Jedes Issue hat ein Budget (CONFIG.budgets je size-Label) — Überschreitung bricht
sauber ab statt weiterzubrennen. Hart je Issue ist dieser Deckel bei
`parallelism: 1`; bei `parallelism > 1` tritt an seine Stelle ein
Lauf-Gesamtdeckel (siehe Stop-Regeln), weil der Token-Zähler dort keiner
einzelnen Einheit zurechenbar ist.

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
  bestehenden PR über seinen Idempotenz-Schritt (Branch weiterführen, einen
  Draft früherer Versionen wieder ready setzen, die Abbruch-Labels
  `needs-human`/`budget-exceeded` vom PR entfernen) — Code und bereits gefundene
  Fehler werden nicht ein zweites Mal erarbeitet. Das Budget zählt im
  Resume-Lauf frisch. Ohne `all`
  bleiben `needs-human`-Issues bewusst liegen: dieses Label heißt, ein Mensch
  muss erst den gemeldeten Blocker (letzter Issue-Kommentar) entscheiden;
  `resume all` ist die explizite Operator-Zustimmung, es trotzdem erneut zu
  versuchen. Issues mit diesen Labels, aber OHNE offenen PR, gehören nicht in
  den Resume-Scope (nichts zum Aufsetzen) — sie im Abschlussbericht ausweisen.
  `merge-blocked`-Issues erreicht KEIN resume-Modus, auch `all` nicht: sie tragen
  weder `budget-exceeded` noch `needs-human`, der Filter oben sieht sie also gar
  nicht. Das ist beabsichtigt — dort ist der PR fertig und grün, es fehlt nur die
  Merge-Freigabe, ein Resume-Lauf würde ihn nur neu bauen und neu verifizieren.
  Der Weg zurück führt über den Operator: von Hand mergen, oder das Label gegen
  `agent-ready` tauschen (dann läuft die Einheit im nächsten Lauf regulär als
  `next`-Kandidat mit). Im Abschlussbericht mit ihrer PR-Nummer ausweisen.
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
3. **PR-Check** (haiku, Weltzustand): `gh pr list --search "Closes #N" --state all`
   direkt nach dem Builder. Ab hier zählt ausschließlich, was gh sagt: PR-Nummer
   UND Branch der Folgestationen kommen aus diesem Befund, nicht aus dem
   Builder-Return (heilt ein gemeldetes `pr: 0`, Issue #33). Findet gh keinen
   PR mit `Closes #N` im Body, ist das ein TECHNISCHER Fehler der Bau-Station,
   kein `needs-human` — ein Agent, der wegen fehlender Tool-Rechte nichts
   ausrichten konnte, ist kein Erfolg (Issue #31). Ein vom Builder gemeldetes
   `skipped` wird nur akzeptiert, wenn gh dazu einen GEMERGTEN PR ausweist;
   meldet gh MERGED, obwohl der Builder gebaut hat, endet die Einheit als
   Erledigung ohne zweiten Merge-Versuch. Weist gh umgekehrt einen OFFENEN PR
   aus, während der Builder `skipped` meldet (Issue nach dem Merge wiedereröffnet,
   dazu ein offener PR aus einem früheren Lauf), gilt dieselbe Prioritätsregel
   wie in der Station selbst — OPEN schlägt MERGED: der offene PR wird übernommen
   und normal verifiziert, gegatet und gemergt, statt die Einheit zu werfen.
   Mehrere offene Treffer sind mehrdeutig: das ist KEIN technischer Fehler,
   sondern ein `needs-human` (Label und Kommentar am Issue, kein zweiter
   Builder-Lauf) — welcher PR gemergt werden soll, kann nur ein Mensch
   entscheiden, und die Abbruch-Stationen fassen bei mehr als einem verifizierten
   Treffer bewusst keinen der PRs an. CLOSED und ein leerer Branchname sind kein
   verwertbarer Befund. Die Station läuft NACH dem Budgetcheck: ein Builder, der
   sein Budget sprengt, hat meist noch keinen PR — sonst würde aus einem sauberen
   Budget-Abbruch ein technischer Fehler. Der Budgetcheck überholt dabei den
   `skipped`-Zweig NICHT: ein bereits erledigtes Issue bekäme sonst
   `budget-exceeded`, verlöre `agent-ready` und machte seine Abhängigen dauerhaft
   blockiert — für Arbeit, die längst gemergt ist.
4. **AC-Verifier:** frisch, Input nur Issue-Body + PR-Diff, Widerlegungsauftrag,
   Urteil als PR-Kommentar `<!-- ac-verify:v2 -->` — Tabelle plus maschinenlesbarer
   JSON-Block `{"verdicts":[{"ac","met","evidence"}]}`, ein Eintrag je AC.
   Folgerunden lesen den vorherigen Block, die Fix-Runde erhält das vorherige
   Verdict, und jede Regression (met → unmet) wird explizit ausgewiesen.
5. **Security-Pass** (nur wenn ein `area/*` in CONFIG.protectedAreas liegt): eigener
   frischer Agent VOR dem Merge (Injection, AuthZ, Secrets, Test-Gaming-Querblick).
6. **Gate-Wait** (OHNE Merge-Lock): zuerst den Draft-Zustand klären (`gh pr view
   --json isDraft,headRefOid`; Draft → `gh pr ready`, denn der prep-Job der
   Review-Pipeline ist auf `draft == false` gefiltert und der Pflicht-Check hängt
   an prep — an einem Draft wird er nie SUCCESS, sondern SKIPPED). Dann
   CONFIG.mergeCheck abwarten (45-Minuten-Cap); SKIPPED und NEUTRAL zählen nicht
   als grün (bewusste Verschärfung gegenüber der Branch-Protection, für die ein
   übersprungener Job den Required Check erfüllt). Meldet gh „no checks
   reported", zählt die Station die Workflow-Läufe auf dem **HEAD-SHA des PR**
   (`gh run list --branch`, gefiltert auf `headSha` — ungefiltert wäre die Zahl
   in jedem Multi-Workflow-Repo immer > 0) und löst GENAU EINEN Re-Trigger aus:
   ein **BEHIND-Update** (`git merge origin/<Default-Branch>` im eigenen
   Worktree, gepusht). Am Vorfall aus #34 wurde live gemessen, dass `gh pr ready`
   und ein leerer Commit KEINEN Actions-Lauf auslösen, das Update dagegen binnen
   Sekunden — Draft-Toggle und `git commit --allow-empty` sind deshalb
   ausgeschlossen, ebenso `gh run rerun` (es gibt keinen Lauf, den man
   wiederholen könnte). Enthält der Branch den Default-Branch schon, wäre der
   Merge ein No-op: dann wird nicht getriggert, sondern gemeldet. Nach dem Update
   zählt die Station gegen den NEUEN HEAD-SHA. Das Update läuft OHNE Merge-Lock;
   das ist tragbar, weil es auf den Feature-Branch schreibt, nie auf den
   Default-Branch, und die Merge-Station BEHIND später ohnehin erneut prüft. Es
   gilt aber dieselbe Konflikt-Regel wie dort: nur reine Append-Konflikte werden
   aufgelöst, alles andere `git merge --abort`, kein Push, Befund in die `note`.
   Danach wird nicht weiter getriggert, und der PR bleibt in jedem Ausgang
   `ready`. Bei FAILURE des Pflicht-Checks steht ZUERST die
   Diagnose, in welchem Step der Job gescheitert ist (`gh run view --json jobs`
   plus `--log-failed | tail`): liegt dieser Step VOR dem eigentlichen
   Test-/Lint-/Review-Aufruf (Checkout, Setup-Action, Dependency-Installation,
   Paketdownload, Runner-Provisionierung), ist das keine Aussage über den Code: `gh run rerun <RUN_ID> --failed`, dann
   neu werten — ein Re-Run je rotem Lauf, höchstens zwei je Station (`--failed`
   wirkt pro Lauf, eine Störung trifft meist mehrere Workflows). Die
   Infrastruktur-Signaturen (`operation timed out`, `Failed to download`,
   `error sending request for url`, `Could not resolve host`,
   `The runner has received a shutdown signal`, dazu CONFIG.ciInfraSignatures)
   sind dabei ein Beleg FÜR EINEN solchen Step, nie für sich allein: der
   `--log-failed`-Auszug enthält die Testausgabe im Volltext, und ein legitim
   fehlschlagender Timeout-Test bringt seine eigene `operation timed out`-Zeile
   mit — im Test-/Lint-/Review-Step ist der Fall deshalb inhaltlich, egal welche
   Signatur im Log steht. Einzige Ausnahme ist ein weggebrochener Runner. Dieser
   Re-Run zählt NICHT auf maxFixRounds und ist auch bei erschöpftem Fix-Budget
   erlaubt; die 45-Minuten-Grenze gilt unverändert. Scheitert derselbe Step
   erneut, ist er reproduzierbar und wird inhaltlich behandelt. Erst dann P0/P1
   adressieren (Restbudget aus maxFixRounds) — parallele Einheiten warten so nicht auf fremde
   CI, der Lock serialisiert nur noch das Mergen. Wird es nicht grün, meldet die
   Station `{ green: false, draftAtEntry, runsFound, retriggered, infraRerun,
   note }` statt zu werfen; der Workflow hängt diese Diagnose an die
   `GATE:`-Meldung und führt sie als `done[].gateDiag` mit — auch im grünen Fall,
   sonst hinterlässt ein still geheilter Draft keine Spur. Nur ein geworfener
   Fehler kommt ohne Diagnose an.
7. **Merge** (IM Merge-Lock, serialisiert): Override-Label-, Abbruch-Label-
   (`needs-human`/`budget-exceeded` am PR — Prompt-Guard gegen ein liegen
   gebliebenes Signal eines früheren Laufs, kein serverseitiges Hindernis wie
   der frühere Draft-Zustand; die Station meldet dafür `blocked: "abort-label"`
   bzw. `blocked: "conflict"` und der Workflow macht daraus den `GATE:`-Abbruch,
   damit ein bewusster Nicht-Merge nicht als „PR ist grün und fertig, es fehlt
   nur die Merge-Freigabe" beim Operator ankommt) und malformed-tree-Check,
   BEHIND-Update inkl. Append-Konflikt-Regel (alles andere → GATE-Stopp),
   erneutes Grün-Warten nach einem BEHIND-Update innerhalb des Locks
   (Zyklus-Cap bleibt), Squash-Merge, unabhängige gh-Verifikation,
   Post-Merge-Beweis am EIGENEN Merge-Commit (`gh pr view --json mergeCommit`),
   dreiwertig: `green` = abgeschlossener Lauf (`status: completed`) mit
   `conclusion: success` plus CONFIG.commands.smoke, falls gesetzt · `red` =
   `conclusion` `failure`/`timed_out` auf dem eigenen Merge-Commit oder roter
   Smoke → onSmokeFailure-Policy und keine weiteren Merges · `unmeasured` =
   jeder andere `conclusion`-Wert (`cancelled`, `skipped`, `neutral`, …) →
   KEINE Policy, kein Revert, kein Stop, nur Ausweis im Bericht
   (`done[].postMerge`). Neubestimmt wird über den jüngsten abgeschlossenen
   Default-Branch-Lauf, der den eigenen Merge-Commit enthält
   (`git merge-base --is-ancestor`) — dieser Obermengen-Lauf testet fremde
   Commits mit und darf deshalb NUR grün bestätigen; sein Rot bleibt
   `unmeasured`, sonst revertiert der Runner einen fehlerfreien eigenen Commit
   wegen eines fremden Fehlers. Das Warten (10-Minuten-Cap) liegt im Lock —
   solange niemand sonst mergt, kann `cancel-in-progress` den eigenen Lauf
   nicht abbrechen. Ein Merge passiert NIE außerhalb des Locks.
   Liefert die Merge-Station kein Ergebnis (die Harness kann sie anhalten —
   `agent()` gibt dann null zurück) oder meldet sie `merged != true`, läuft
   danach die **Merge-Diagnose**: eine read-only-Station (haiku), die den echten
   PR-Zustand liest (`state`, `mergedAt`, Zahl grüner/roter/laufender Checks,
   Zustand von CONFIG.mergeCheck) und NICHTS mergt — nur deshalb kann sie
   denselben Block nicht erneut auslösen. Ihr Befund entscheidet, und zwar
   deterministisch im Scheduler statt im Agenten: `mergedAt` gesetzt → die
   Einheit gilt als gemergt, der Post-Merge-Beweis lief dann aber NICHT
   (`postMerge: "unmeasured"` plus `postMergeUnverified: true` im Bericht — grün
   wird nicht behauptet, niemand hat den Default-Branch gelesen); PR offen, kein
   roter und kein laufender Check, Pflicht-Check grün → Zustand `merge-blocked`
   (siehe Stop-Regeln); alles andere → `needs-human` mit dem gelesenen Zustand
   als Grund. Fällt die Diagnose selbst aus, gilt `needs-human`. „kein Ergebnis"
   landet nie mehr in Issue oder Bericht.
   Alle Fix-Runden aus 4.-6. zählen zusammen auf das EINE issue-globale
   CONFIG.maxFixRounds. Einzige Ausnahme: der CI-Infrastruktur-Re-Run aus
   Station 6 — er ändert keine Zeile Code und misst nur neu, also wäre eine
   Fix-Runde dafür eine Strafe für fremde Infrastruktur.
8. **Post-Merge-Cleanup** (best-effort): Builder-Worktree entfernen und den
   lokalen Feature-Branch löschen — der Erfolgspfad hinterlässt sonst
   Worktree-Drift (Erstlauf-Befund 2026-07-26).
9. **Learnings** (best-effort, nur nach echtem Merge, `CONFIG.learnings` ≠ false):
   destilliert das ÜBERTRAGBARE Wissen der Einheit nach
   `.flowkit/learnings/<issue>-<slug>.md` — Frontmatter (issue, pr, area, date)
   plus „Was funktionierte" / „Fallen", zusammen höchstens ~15 Zeilen. Gemeint
   sind API-Fallen, Test-Ansätze und Eigenheiten dieses Repos, ausdrücklich
   KEINE Nacherzählung des Issues. Gegenstück: Planner und Builder lesen vorab
   die 10 jüngsten Dateien aus `.flowkit/learnings/` (`ls -t | head`), die zur
   eigenen Area zuerst; fehlt das Verzeichnis, laufen sie stillschweigend
   weiter. Wie der Cleanup läuft die Station in try/catch — ein Fehler beim
   Aufschreiben kippt einen gemergten Erfolg nie.

## Stop-Regeln (Zustandsautomat, Spec §6)

- **Inhaltlicher Gate-Fail** (AC-Verifier/Security/Gate-Wait nach
  erschöpftem maxFixRounds nicht grün; die Merge-Station findet im Lock rote
  Checks, ein Abbruch-Label eines früheren Laufs oder einen semantischen Konflikt
  vor — im Lock wird nicht gefixt; oder gh weist zum Issue mehr als einen offenen
  PR aus): die EINHEIT stoppt — Label `needs-human`, dazu am zugehörigen
  offenen PR dasselbe Label plus einen Abbruchkommentar (erste Zeile
  `<!-- flowkit-abort:v1 -->`). Der PR bleibt bewusst READY und wird NICHT auf
  Draft gesetzt: die Deep-Review-Pipeline überspringt Drafts, und genau ihr
  Urteil braucht der Mensch, der übernimmt (#35). Der LAUF fährt mit dem
  nächsten Issue fort. Eskalation passiert INNERHALB der Einheit: ab Fix-Runde 2
  laufen Fixes genau eine Modellstufe höher (CONFIG.models.escalation) UND mit
  dem Eskalations-Effort (CONFIG.effort.escalation). Beide Karten sind getrennt:
  Modellstufe und Denkaufwand eskalieren gemeinsam, aber unabhängig voneinander
  konfigurierbar.
- **Lauf bereits angehalten** (ein früherer Post-Merge war rot, die
  `onSmokeFailure`-Policy lief): Einheiten, die zu diesem Zeitpunkt schon im
  Merge-Lock warten, werden NICHT mehr gemergt — sie enden als `needs-human` mit
  dem Grund „Lauf angehalten". Das ist kein Urteil über ihre Qualität: ihr PR ist
  grün und fertig, es fehlt nur die Entscheidung des Operators, ob nach dem
  Revert weitergemergt werden darf. Ohne diese Sperre würden hinter einem roten
  Post-Merge aufgelaufene Einheiten weiter auf den Default-Branch mergen,
  während der Revert-PR noch offensteht.
- **Extern blockierter Merge** (die Merge-Station lief nicht durch, der PR ist
  laut gh aber offen, ohne roten und ohne laufenden Check und mit grünem
  CONFIG.mergeCheck — etwa weil das Sicherheitssystem der Harness einen
  unbeaufsichtigten Merge anhält): eigener Zustand, kein Fehlschlag. Label
  `merge-blocked` auf Issue UND PR, Kommentar mit dem gelesenen Zustand an
  beiden, der PR bleibt offen und ready (kein Draft, kein Schließen, kein
  Branch-Löschen), Worktree-Cleanup läuft. Im Bericht trägt der `done`-Eintrag
  `mergeBlocked: true`; die Einheit zählt NICHT als Erledigung, ihre Abhängigen
  laufen also nicht an. Der LAUF fährt fort, aber der Zustand zählt als KEIN
  Fortschritt für den Circuit-Breaker: eine Harness-seitige Blockade ist
  systemisch, nicht PR-spezifisch — sitzt sie einmal, endet jede weitere Einheit
  genauso, jede nach vollem Build und Gate. Ausweg für den Operator: den PR nach
  Freigabe von Hand mergen (`gh pr merge <PR> --squash --delete-branch`) ODER am
  Issue die Labels tauschen (`gh issue edit <N> --remove-label merge-blocked
  --add-label agent-ready`), damit ein späterer Lauf die Einheit erneut aufnimmt.
  Ein resume-Modus greift sie nicht (siehe Scope).
- **Technischer Fehler** (Crash, Infra, gh-Ausfall, ODER: nach dem Builder ist
  auf GitHub GAR KEIN verwertbarer PR zum Issue nachweisbar — siehe Station 3;
  ZWEI offene PRs sind dagegen ein `needs-human`, kein Requeue):
  erster Fehler → Cleanup + Queue-Ende (transient); zweiter technischer Fehler
  derselben Einheit → Lauf stoppt mit Bericht, und zwar mit dem konkreten
  Fehlertext als `stopped.reason`.
- **Kein Fortschritt im Lauf** (`CONFIG.progressStopAfter`, Default 3): enden so
  viele abgeschlossene Einheiten IN FOLGE ohne Merge — `needs-human`,
  Budget-Abbruch, extern blockierter Merge oder der ZWEITE technische Fehlversuch
  derselben Einheit —, hält der Lauf an und nennt den Grund im Bericht
  (`stopped.reason` beginnt mit „Fortschritts-Circuit-Breaker").
  Ein Merge oder eine gh-verifizierte Erledigung setzt den Zähler zurück;
  dauerhaft blockierte Einheiten zählen nicht mit (sie laufen nie an), und eine
  Einheit, die nach einem transienten technischen Fehler wieder in der Queue
  steht, ebenfalls nicht — sie hat noch gar keinen Ausgang, und der Breaker soll
  den Retry nicht totschlagen, den der Runner selbst anordnet. `0` schaltet den
  Breaker ab. Grund: ein Lauf, der 23 Einheiten ohne einen einzigen PR
  durchreicht, soll nicht bis zum Ende brennen (Issue #31).
- **Post-Merge rot** (`done[].postMerge == "red"`: abgeschlossener CI-Lauf auf
  dem eigenen Merge-Commit mit `conclusion` `failure`/`timed_out` oder roter
  Smoke): onSmokeFailure-Policy läuft, der LAUF stoppt — keine weiteren Merges
  auf einen belegt kaputten Default-Branch. Ein *unbestimmter* Post-Merge-Lauf
  (`"unmeasured"`, typisch ein von `cancel-in-progress` abgebrochener Lauf oder
  ein Rot, das nur auf einem Obermengen-Lauf sichtbar ist) stoppt NICHTS und
  löst keine Policy aus: eine fehlende Messung ist kein Fehlschlag, ein Revert
  ohne Beleg wäre der teurere Fehler. Er steht im Bericht und im Log.
- **Budget-Überschreitung je Issue** (nur bei `parallelism: 1` — nur dort ist das
  Delta von `budget.spent()` einer Einheit zurechenbar) → Einheit sauber
  abgebrochen (Issue-Kommentar, Label `budget-exceeded` am Issue UND am offenen
  PR, Abbruchkommentar am PR, Worktree-Cleanup; der PR bleibt ready, siehe
  oben), zählt NICHT als Fehler, Lauf geht weiter.
- **Lauf-Gesamtdeckel** (bei `parallelism > 1`, `tokenMode: "run"`): Deckel =
  Summe der Einheiten-Budgets dieses Laufs × `CONFIG.runBudgetFactor` (Default
  1.2). Ist er überschritten, wird KEINE neue Einheit mehr gestartet; laufende
  Einheiten laufen normal zu Ende und der Lauf endet regulär mit Bericht. Die
  nicht mehr gestarteten Einheiten stehen im Bericht unter `deferredByBudget`
  (nicht in `remaining`, nicht in `blocked`) — kein Fehler, kein Stop, kein
  Label auf GitHub; sie kommen im nächsten Lauf einfach wieder dran. Eine grobe
  Näherung mit Absicht: ein per-Issue-Deckel wäre bei parallelen Workern nicht
  attribuierbar, und laufende Einheiten mittendrin abzubrechen verbrennt mehr,
  als es spart.
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

„gemergt/grün/erledigt" gilt nur nach gh-Verifikation, nie aus Agent-JSON — und
seit 0.8.0 gilt dasselbe für „PR gebaut" und „war schon erledigt": die
PR-Check-Station (Station 3) holt Nummer, Branch und Zustand des PR bei gh; ein
Builder-Return ohne Entsprechung auf GitHub ist kein Ergebnis. Nach
Abbruch in derselben Session: denselben Workflow mit `resumeFromRunId` starten —
erledigte Einheiten kommen aus dem Cache. Über Session-Grenzen hinweg ist der
Scope-Modus `resume` der Weg zurück zu liegengebliebener Arbeit.
Beim Stop durch den Fortschritts-Circuit-Breaker steht die auslösende Einheit
NIE in `remaining`: gezählt wird ausschließlich ein abgeschlossener Ausgang
(siehe „Kein Fortschritt im Lauf" oben), nie ein transienter Retry, der noch in
der Queue wartet. Je nachdem, welcher der vier Zähler den Stop ausgelöst hat,
findet sich `stopped.issue` deshalb in einem von zwei anderen Feldern: bei
needs-human, Budget-Abbruch oder extern blockiertem Merge steht die Einheit —
mit dem passenden Flag (`needsHuman`/`budgetExceeded`/`mergeBlocked`) — in
`done`; beim zweiten, endgültigen technischen Fehlversuch steht sie in
`failed`. `failed` bleibt beim Breaker also NICHT zwangsläufig leer, sofern
gerade dieser vierte Zähler den Stop ausgelöst hat. In keinem der vier Fälle
kommt die auslösende Einheit „im nächsten Lauf unverändert wieder dran": needs-
human bleibt ohne `resume all` bewusst liegen (siehe Scope oben), Budget-
Abbruch und merge-blocked brauchen den dort beschriebenen Label-Tausch, und der
technische Fehler setzt kein Label — das Issue trägt weiter `agent-ready` und
läuft im nächsten regulären Lauf als normaler Kandidat wieder an, nicht über
einen Resume-Modus.
Nicht jede Nicht-Erledigung hinterlässt eine Spur auf GitHub: `needs-human`,
`budget-exceeded` und `merge-blocked` setzen Label und Kommentar an Issue und PR
— die dritte Klasse, „Einheit hat nichts geliefert" (technischer Fehler, allen
voran ein Builder ohne per gh nachweisbaren PR), setzt bewusst KEINS von beidem:
ein Label für einen Zustand, in dem gar kein PR existiert, hätte keinen Träger.
Diese Einheiten stehen ausschließlich im Lauf-Bericht (`failed` bzw.
`stopped.reason`, mit dem gh-Befund im Wortlaut) und im Log. Wer morgens nur auf
die GitHub-Queues schaut, sieht sie nicht — dafür ist der Bericht da.
Nach JEDEM Lauf-Ende den Lauf-Bericht persistieren:
`.flowkit/runs/<YYYY-MM-DDTHH-MM>-<scope>.json` — Inhalt: das Return-Objekt des
Workflows plus `scope` (der aufgelöste Auftrag) und `startedAt`. `.flowkit/` ist
gitignored; diese Dateien sind die dauerhafte Datenbasis für die
Budget-Kalibrierung (Token je size-Label, nur Läufe mit `tokenMode: "delta"`)
und das Aufwärm-Material für spätere Sessions. Die Kalibrier-Auswertung
liefert `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/budget_report.py .flowkit/runs`
(Median/p90 je size-Label plus Vorschlag für `budgets.<size>.tokens`); der
Vorschlag wird dem Operator präsentiert und NIE automatisch in die Config
geschrieben. Der Lauf-Bericht enthält
Token-Verbrauch je Issue (Datenbasis für die Budget-Kalibrierung in Stufe 2).
Verlässliche Kalibrier-Daten liefern NUR Läufe mit `parallelism: 1`
(`tokenMode: "delta"`); Läufe mit `tokenMode: "run"` haben statt eines
per-Issue-Deckels nur den Lauf-Gesamtdeckel, ihre `done[].tokens` sind `null`
und `budget_report.py` überspringt sie. Solange die Budgets nicht kalibriert
sind, ist auch der Lauf-Gesamtdeckel nur so gut wie sie — im Zweifel
`runBudgetFactor` großzügig lassen und `deferredByBudget` im Bericht beobachten.
Neben `runs/` liegt unter `.flowkit/learnings/` das Repo-Gedächtnis (ein
Destillat je gemergtem Issue, siehe Station 9). Auch dieses Verzeichnis ist über
`.flowkit/` gitignored und bleibt damit bewusst repo- und maschinenlokal: es
wird nie committet, nie in einen PR gezogen und nie zwischen Repos geteilt. Wenn CONFIG.notify true ist: nach Lauf-Ende
den Kurzbericht (erledigt/offen/Stop-Grund) zusätzlich als Push-Benachrichtigung
senden (PushNotification-Tool, falls in der Session verfügbar; sonst überspringen).
