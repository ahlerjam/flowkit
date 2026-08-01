---
description: Set up an unattended nightly flowkit run: hard guardrail gate, schedule wiring, morning checklist.
---

# /flowkit:nightly

Richtet einen nächtlichen autonomen Lauf ein — genauer: prüft erst hart, ob dieses
Repo unbeaufsichtigt laufen DARF, und verdrahtet den Schedule dann harness-abhängig.
Der Befehl selbst startet keinen Lauf und schreibt keinen Code.

Rote Linien wie überall: nie `gh api POST/PATCH/PUT/DELETE` (die Prüfungen unten
sind reine GET-Aufrufe), nie Issues löschen, immer `-R "$REPO_SLUG"`. flowkit
schreibt außerdem NIE selbst in `crontab`, `launchd` oder fremde Scheduler-Configs —
entweder der Harness bietet einen Schedule-Mechanismus an, oder der Operator richtet
ihn selbst ein (Schritt 3b).

## 1. Vorbedingungen — HART prüfen, bei Verstoß abbrechen

Jede Verletzung beendet den Befehl mit Begründung und dem konkreten nächsten
Schritt. Kein „richte ich trotzdem ein, prüf du morgen": ein unbeaufsichtigter Lauf
ohne Gate ist genau der Fall, für den es keine zweite Chance gibt.

1. **CONFIG vollständig:** `.claude/workflow.config.json` existiert und trägt
   Werte für `repoSlug`, `defaultBranch`, `commands.test`, `commands.lint`,
   `budgets.S/M/L` (turns + tokens), `caps.issuesPerRun`, `maxFixRounds`,
   `mergeCheck`, `onSmokeFailure`:

       CFG=.claude/workflow.config.json
       jq -r '[.repoSlug, .defaultBranch, .commands.test, .commands.lint,
               (.budgets.S.tokens|tostring), (.budgets.M.tokens|tostring),
               (.budgets.L.tokens|tostring), (.caps.issuesPerRun|tostring),
               (.maxFixRounds|tostring), .mergeCheck, .onSmokeFailure]
              | map(select(. == null or . == "")) | length' "$CFG"

   Ergebnis > 0 (oder `jq` scheitert) → STOPP mit Verweis auf `/flowkit:setup`.
   Fehlende Felder namentlich nennen, nicht nur zählen.
2. **Branch-Protection aktiv** (Merge-Voraussetzung, read-only):

       REPO_SLUG=$(jq -r .repoSlug "$CFG"); BR=$(jq -r .defaultBranch "$CFG")
       gh api "repos/$REPO_SLUG/branches/$BR/protection" --jq '.required_status_checks.contexts'
       gh api "repos/$REPO_SLUG/rulesets" --jq '.[] | select(.enforcement == "active") | .name'

   Beides sind GET-Aufrufe und damit erlaubt. Der erste Endpunkt antwortet mit
   404 „Branch not protected", wenn der Schutz über ein **Ruleset** statt über die
   klassische Branch-Protection läuft — deshalb der zweite Aufruf. Liefert KEINER
   der beiden einen aktiven Schutz für den Default-Branch → STOPP: ohne
   serverseitiges Gate verweigert schon der Runner-Pre-Flight den Start, und ein
   nächtlicher Auto-Merge wäre ein Merge ohne Gegenprüfung. Einrichtung anleiten wie
   in `/flowkit:setup` Schritt 5b (GitHub → Settings → Branches → Ruleset:
   required status checks = CONFIG.mergeCheck, require PR before merging).
3. **gh-Auth und sauberer Ausgangszustand:** `gh auth status` ok; der
   Default-Branch ist ohne uncommittete Änderungen ausgecheckt
   (`git status --porcelain`). Beides prüft der Runner-Pre-Flight nachts erneut —
   ein dirty Arbeitsverzeichnis heißt dann: Lauf startet gar nicht und die Nacht
   ist verschenkt. Verstoß → STOPP mit Hinweis, was aufzuräumen ist.
4. **Futter vorhanden** (ein gh-Aufruf): Anzahl offener `agent-ready`-Issues ohne
   offene Blocker — das jq-Muster steht in `skills/implement` unter `next <N>`.
   Null → STOPP: nichts zu tun, erst `/flowkit:issue` (impuls/gaps/prd) füttern
   oder `needs-triage` durchgehen.

**Empfohlen, aber nicht blockierend** (jeweils als Hinweis in den Bericht):
- `notify: true` in der CONFIG — sonst landet der Kurzbericht nur im Lauf-Bericht
  unter `.flowkit/runs/` und der Operator erfährt morgens von sich aus nichts.
- `autoReady.gapScan: "off"` (Default) — sonst können nachts KI-gesäte Issues
  entstehen UND im selben Zug abgearbeitet werden, ohne dass ein Mensch den Scope
  je gesehen hat.
- `parallelism: 1` für die ersten Nächte: langsamer, aber die Lauf-Berichte tragen
  dann `tokenMode: "delta"` und liefern die Datenbasis für die Budget-Kalibrierung
  (`/flowkit:status`, Abschnitt Budget-Kalibrierung).

## 2. Operator-Entscheidungen — EIN AskUserQuestion-Block

Genau ein Block mit drei Fragen, danach keine Rückfrage mehr:
- **Uhrzeit** (lokale Zeitzone) — z. B. 02:00 / 03:00 / eigene Angabe.
- **Anzahl Issues je Nacht** (`next <N>`) — z. B. 2 / 3 / 5. Größer als
  `caps.issuesPerRun` ist wirkungslos; in dem Fall den Cap nennen und auf ihn
  deckeln.
- **Harter Deckel** (`max <X>`) für den Lauf — Default = Anzahl Issues. Er begrenzt
  die Einheiten des Laufs zusätzlich zur Queue-Länge.

Daraus entsteht genau ein Prompt, wörtlich:

    /flowkit:implement next <N> max <X>

## 3. Schedule verdrahten (harness-abhängig)

**3a. Wenn die Session einen Schedule-/Cron-Mechanismus anbietet** (z. B. der
`schedule`-Skill von Claude Code; Erkennung: eigene Skill-Liste dieser Session,
sonst `ToolSearch("schedule")`), damit eine tägliche Routine anlegen: Prompt = der
Befehl aus Schritt 2, Zeitpunkt = gewählte Uhrzeit, Arbeitsverzeichnis = dieses
Repo. Anschließend die angelegte Routine (Name/ID und nächste Ausführung) im
Bericht nennen, damit der Operator sie wiederfindet und abschalten kann.

**3b. Sonst: manuelle Einrichtung zeigen**, nicht selbst ausführen. Beispiel für
einen Cron-Eintrag (`crontab -e`), Uhrzeit/Pfad/Werte aus Schritt 2 einsetzen:

    0 2 * * * cd /pfad/zum/repo && /usr/local/bin/claude -p "/flowkit:implement next 3 max 3" \
      --permission-mode acceptEdits >> /pfad/zum/repo/.flowkit/nightly.log 2>&1

Dazu ehrlich dazusagen, statt es zu verschweigen:
- Der Pfad zur `claude`-Binary ist maschinenabhängig (`command -v claude`), und
  Cron erbt die Login-Shell-Umgebung NICHT — `PATH` und die gh-Auth müssen im
  Cron-Kontext verfügbar sein. Einmal von Hand mit `env -i` gegenprobieren.
- `--permission-mode` steuert nur die Rückfragen. Ob der Runner unbeaufsichtigt
  ohne Prompt durchläuft, hängt an den `permissions.allow`-Regeln aus
  `/flowkit:setup`; welcher Modus dafür reicht, VOR der ersten unbeaufsichtigten
  Nacht einmal wach durchspielen, statt es anzunehmen.
- Die PreToolUse-Hooks aus `/flowkit:setup` sind kein Permission-Prompt, sondern
  ein eigenes Gate (sie blocken u. a. `gh api`-Mutationen und Pushes auf geschützte
  Branches). Auch das einmal aktiv verifizieren
  (`bash ${CLAUDE_PLUGIN_ROOT}/templates/hooks/test-pretooluse-blocker.sh
  .claude/hooks/pretooluse-blocker.sh`), bevor der erste Lauf ohne Zuschauer läuft.

## 4. Warum die Guardrails den unbeaufsichtigten Betrieb tragen

Diesen Abschnitt in den Bericht übernehmen — er ist die Begründung, warum hier
niemand wach bleiben muss:
- **Hartes Budget je Issue** (`budgets` nach `size/S|M|L`): Überschreitung bricht
  die Einheit sauber ab — Kommentar, Label `budget-exceeded`, PR als Draft,
  Worktree-Cleanup — statt die Nacht durchzubrennen. Der Lauf macht weiter.
- **Issue-globale Fix-Runden** (`maxFixRounds`) mit genau EINER Modell-Eskalation,
  danach `needs-human`: keine Endlosschleife, der Lauf geht zum nächsten Issue.
- **Fortschritts-Circuit-Breaker** (`progressStopAfter`, Default 3): enden drei
  Einheiten in Folge ohne Merge, hält der Lauf an und meldet es — eine Nacht,
  in der nichts mehr gelingt (ausgefallener Permission-Classifier, gh-Ausfall,
  kaputte CI), wird nicht in voller Länge durchgebrannt.
- **CI-Infrastruktur wird wiederholt, nicht gefixt:** scheitert ein Job vor dem
  eigentlichen Testaufruf (Paketdownload, Runner-Provisionierung, Checkout) oder
  trägt sein Log eine bekannte Infrastruktur-Signatur (erweiterbar über
  `ciInfraSignatures`), antwortet die Gate-Wait-Station mit `gh run rerun
  --failed` statt mit einer Fix-Runde — ein Re-Run je rotem Lauf, höchstens zwei.
  Er zählt nicht auf `maxFixRounds`: ein PyPI-Ausrutscher um drei Uhr kostet
  nachts keine Einheit mehr. Scheitert derselbe Step erneut, ist er
  reproduzierbar und wird wieder inhaltlich behandelt.
- **Merge nur über das serverseitige Gate:** `mergeCheck` muss grün sein, die
  Branch-Protection aus Schritt 1.2 erzwingt es unabhängig vom Agenten; gemergt
  wird ausschließlich im Merge-Lock, semantische Konflikte brechen ab
  (`needs-human`) statt geraten zu werden.
- **`onSmokeFailure: "revert"`:** ein BELEGT roter Post-Merge-Lauf (abgeschlossener
  CI-Lauf auf dem eigenen Merge-Commit mit `conclusion` `failure`/`timed_out` oder
  roter Smoke) rollt den Merge zurück und stoppt weitere Merges — der
  Default-Branch bleibt über Nacht grün. Ein abgebrochener Lauf (`cancelled`,
  typisch bei `concurrency: cancel-in-progress` auf dem Default-Branch) ist keine
  Messung: er wird über den jüngsten abgeschlossenen Lauf, der den eigenen
  Merge-Commit enthält, neu bestimmt — und weil dieser Lauf auch fremde Commits
  testet, bestätigt er nur Grün. Bleibt es unbestimmt, rollt nichts zurück und der
  Lauf fährt fort (`done[].postMerge == "unmeasured"`).
- **Pre-Flight:** dirty Default-Branch, fehlende Branch-Protection oder
  gh-Auth-Problem → der Lauf startet erst gar nicht, statt halb zu laufen.
- **`caps.issuesPerRun` und `max <X>`** deckeln die Nacht doppelt; GitHub-native
  Dependencies (`blocked by`) halten blockierte Issues zurück, statt sie in falscher
  Reihenfolge zu greifen.
- **Rote Linien technisch durchgesetzt:** keine `gh api`-Mutationen, kein
  Issue-Löschen, kein Push auf geschützte Branches — die Hooks entscheiden das,
  nicht der Prompt.

Was die Guardrails NICHT abdecken (auch das in den Bericht): fachliche
Fehlentscheidungen innerhalb korrekt erfüllter Akzeptanzkriterien, ein schlecht
geschriebenes Issue, und alles, was `agent-ready` gesetzt bekam, ohne dass ein
Mensch den Scope gelesen hat. Die Qualität der Nacht ist die Qualität der Queue.

## 5. Morgens prüfen

Erster Griff: `/flowkit:status`. In dieser Reihenfolge lesen:
1. **needs-human** — hier wartet eine Entscheidung; der Grund steht im letzten
   Issue-Kommentar bzw. im Draft-PR.
2. **Gestrandete Arbeit** — `budget-exceeded` mit offenem PR wird mit
   `/flowkit:implement resume` fortgesetzt (Budget zählt frisch), `needs-human`
   nur bewusst mit `resume all`.
3. **Letzte Läufe** — erledigt/needs-human/blocked und der Stop-Grund des
   Nachtlaufs.
4. **Budget-Kalibrierung** — nach einigen Delta-Läufen die Vorschläge für
   `budgets.<size>.tokens` sichten; Übernahme bleibt Operator-Entscheidung.
5. Die über Nacht gemergten PRs quer lesen. Auto-Merge heißt geprüft, nicht
   ungesehen.

## 6. Abschlussbericht

Als Chat-Ausgabe: welche Vorbedingung wie geprüft wurde (mit Befund), welche
Empfehlung offen blieb, was eingerichtet wurde (Routine samt Zeitpunkt — oder das
manuelle Kommando zum Kopieren), und der Morgen-Check aus Abschnitt 5. Bei Abbruch:
die verletzte Bedingung, der Grund und der konkrete nächste Schritt — nichts
Halbfertiges zurücklassen.
