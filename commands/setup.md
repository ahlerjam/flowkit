---
description: Install or update flowkit in the current repository (config, labels, board, hooks, CI gate).
---

# /flowkit:setup

Installiere flowkit im aktuellen Repo. Schritte in dieser Reihenfolge; bei jedem
Schritt zuerst prüfen, ob er schon erledigt ist (idempotent).

0. **Umgebungs-Check (Begleit-Plugins — meldepflichtig, nie blockierend):** Prüfe,
   ob die Werkzeuge vorhanden sind, die die Runner-Stationen aufwerten. Erkennung:
   in der eigenen Skill-Liste dieser Session nachsehen; steht sie nicht zur
   Verfügung, Verzeichnis-Check unter `~/.claude/plugins/` (Glob/ls); context7
   per `ToolSearch("context7")`.
   - `superpowers:test-driven-development`, `superpowers:systematic-debugging`,
     `superpowers:verification-before-completion` → superpowers ist seit 0.7.0
     als Plugin-Dependency deklariert und wird bei der flowkit-Installation
     automatisch mitinstalliert; dieser Check bleibt als Fallback (z. B. wenn
     der Marketplace claude-plugins-official nicht konfiguriert ist). Fehlen
     die Skills, degradieren Builder/Fix-Runden/PR-Vorbereitung auf die
     Inline-Disziplin der Prompts.
   - `browser-use` → fehlt er, entfällt der Verhaltens-Beweis im Browser für
     `area/frontend`-Issues (Config-Schalter `browserProof` bleibt wirkungslos).
   - context7 (MCP) → fehlt es, raten Planner/Builder Framework-APIs aus
     Trainingswissen (höheres „fast richtig"-Risiko).
   Für JEDES fehlende Werkzeug einen klar markierten Hinweis-Block in den
   Abschlussbericht (Schritt 8) aufnehmen: was fehlt, welche Station wie
   degradiert, Installations-Hinweis (Superpowers: `/plugin install
   superpowers@claude-plugins-official`; browser-use/context7: über
   Plugin-Marketplace bzw. MCP-Konfiguration des Harness). Die Installation
   NICHT selbst versuchen (Plugin-Installation ist Nutzer-Ebene); Setup läuft
   vollständig weiter — flowkit funktioniert ohne diese Plugins, nur schwächer.
1. **Vorbedingungen:** `AGENTS.md` existiert im Root (sonst aus dem Plugin-Template
   `${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.md.template` interaktiv erzeugen — Platzhalter
   mit dem Operator klären, EIN AskUserQuestion-Block). `gh auth status` ok. REPO_SLUG via
   `gh repo view --json nameWithOwner -q .nameWithOwner`.
2. **Config:** `.claude/workflow.config.json` aus
   `${CLAUDE_PLUGIN_ROOT}/templates/workflow.config.json.template`
   anlegen (existiert sie: nur fehlende Felder ergänzen). Werte aus AGENTS.md/README
   ableiten, Unklares im selben AskUserQuestion-Block wie oben klären. Gegen
   `${CLAUDE_PLUGIN_ROOT}/templates/workflow.config.schema.json` validieren (python3 + json,
   ohne Fremdpakete: Pflichtfelder und Typen manuell prüfen). Bei einem Update einer
   bestehenden Config die Migrationsliste
   `${CLAUDE_PLUGIN_ROOT}/templates/config-migrations.json` laden (geordnete
   Liste von `{version, field, default, note}`) und der Reihe nach anwenden:
   jedes dort gelistete Feld, das in der Config FEHLT, mit seinem `default`
   ergänzen (Punkt-Pfade wie `commands.setup` bezeichnen verschachtelte
   Felder; vom Operator gesetzte Werte NIE überschreiben — nur fehlende Felder
   ergänzen, wie bisher). Die `note` je Migration beachten (sie kann
   Versions-Checks oder abweichende Defaults verlangen) und jede angewandte
   Migration (version + field) im Abschlussbericht (Schritt 8) ausweisen.
3. **Labels** (idempotent, `gh label create … || true`):
   size/S size/M size/L (Farbe ededed), needs-triage (fbca04), agent-ready (0e8a16),
   budget-exceeded (d93f0b), needs-human (d876e3), merge-blocked (0052cc, der PR
   ist grün und fertig, der Merge wurde extern angehalten — ein Mensch mergt nach
   Freigabe von Hand), flow/quick (c2e0c6),
   seed/gap-scan (c5def5, Marker für Gap-Scan-Issues — Zählbasis des
   Grooming-Wochendeckels) sowie fehlende
   type/*, priority/P0..P3, area/* aus CONFIG.areas.
   `needs-human`, `budget-exceeded` und `merge-blocked` setzt der Runner seit
   0.8.0 zusätzlich am zugehörigen PR — das ist dort das Signal „nicht mergen"
   bzw. „von Hand mergen" und ersetzt das frühere Draft-Setzen. Repo-Labels
   gelten für Issues und PRs gleichermaßen; ein zweites Label ist NICHT
   anzulegen. Fehlt `merge-blocked` im Zielrepo (Installation vor 0.8.0),
   scheitert das `--add-label` des Runners still: der Zustand steht dann nur im
   Lauf-Bericht, nicht auf GitHub.
4. **Board (optional, Stufe-1-Delta §13):** Labels sind in Stufe 1 die einzige
   Pflicht-Übersicht. Auf Operator-Wunsch: `gh project create --owner <owner>
   --title "flowkit — <repo>"` anlegen und dem Operator sagen, dass die
   Status-Spalten (Triage / Ready / In Arbeit / PR offen / Fertig) einmalig von
   Hand in der Projects-UI angelegt werden müssen (die Spalten-Anlage per CLI
   bräuchte GraphQL-Mutationen — rote Linie). Kein Runner-Board-Sync in Stufe 1.
5. **Hooks + Settings:** `${CLAUDE_PLUGIN_ROOT}/templates/hooks/*.sh` nach `.claude/hooks/`
   kopieren, `chmod +x`. `${CLAUDE_PLUGIN_ROOT}/templates/settings.json.template` nach
   `.claude/settings.json` (existiert eine: hooks/permissions-Blöcke mergen, nichts löschen —
   EINE Ausnahme: Allow-Einträge, die auf `…/scripts/*` bzw. `…/templates/hooks/*` matchen
   und NICHT dem aktuellen `${CLAUDE_PLUGIN_ROOT}` entsprechen, werden ERSETZT statt behalten;
   sonst wächst bei jedem Plugin-Update eine tote Zeile mit altem Pfad dazu).
   Platzhalter ersetzen: {{PROTECTED_BRANCHES}} aus CONFIG.defaultBranch (+ master),
   {{OVERRIDE_LABEL}} aus CONFIG.overrideLabel, {{STACK_ALLOW}} = Allow-Zeilen für die
   Kommandopräfixe aus CONFIG.commands/extraGates (z. B. "Bash(uv run *)"), {{FORMAT_CMD_PY}}
   = Format-Kommando des Repos oder `true` wenn keins.
   {{PLUGIN_ROOT}} = der ABSOLUTE Pfad aus `${CLAUDE_PLUGIN_ROOT}`, ohne Trailing-Slash
   und ohne Anführungszeichen wörtlich in die Muster eingesetzt. Er gibt den
   Plugin-eigenen Skripten (Worktree-Cleanup, `budget_report.py`, Hook-Tests) eine
   Allowlist-Regel; ohne sie fällt jeder dieser Aufrufe an den Permission-Classifier
   zurück, dessen Ausfall einen kompletten Lauf gekippt hat (Issue #31). ACHTUNG: der
   Pfad ändert sich bei Neuinstallation oder Update des Plugins — danach `/flowkit:setup`
   erneut laufen lassen (der Drift-Hinweis des SessionStart-Hooks erinnert daran).
   Danach validieren:
   `python3 -m json.tool .claude/settings.json >/dev/null` (das Template selbst ist
   wegen {{STACK_ALLOW}} kein valides JSON — das installierte Ergebnis MUSS es sein),
   `! grep -q '{{' .claude/settings.json` (kein unsubstituierter Platzhalter; bewusst
   als negiertes `grep -q`, weil `grep -c` im Gutfall mit Exit-Code 1 endet)
   und gegen die INSTALLIERTE Fassung testen:
   `bash ${CLAUDE_PLUGIN_ROOT}/templates/hooks/test-pretooluse-blocker.sh .claude/hooks/pretooluse-blocker.sh`.
   Danach **Versions-Stempel:** `PLUGIN_VERSION` aus
   `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` lesen (jq `-r .version`
   oder python3 `json.load`). In JEDE gerade nach `.claude/hooks/` kopierte
   `.sh`-Datei nahe dem Dateianfang (nach der Shebang-Zeile) eine Zeile
   `# flowkit-template-version: <PLUGIN_VERSION>` einfügen — existiert die
   Zeile schon (Re-Setup), ERSETZEN statt duplizieren. Zusätzlich die
   zentrale Stempel-Datei `.claude/flowkit-version` anlegen bzw.
   überschreiben, Inhalt NUR `<PLUGIN_VERSION>` (eine Zeile, sonst nichts) —
   sie ist die primäre Drift-Quelle für den SessionStart-Hook
   (`inject-context.sh`), der sie mit der jeweils installierten
   Plugin-Version vergleicht. Diese Datei ist nur etwas wert, wenn sie im Repo
   LANDET: ignoriert die .gitignore des Zielrepos `.claude/`, fehlt sie in jedem
   frischen Clone, in CI und in jedem Runner-Worktree — die Drift-Warnung bleibt
   dort dauerhaft still. Das Freistellen erledigt Schritt 7; hier die .gitignore
   NICHT anfassen.
5b. **Branch-Protection (Merge-Voraussetzung, Spec §6):** read-only prüfen:
   `gh api repos/$REPO_SLUG/branches/<defaultBranch>/protection` (GET ist erlaubt).
   Bei 404: dem Operator die Einrichtung anleiten (GitHub → Settings → Branches →
   Add branch ruleset: require status checks = CONFIG.mergeCheck bzw. CI-Gates,
   require PR before merging) — gh-api-Mutationen sind per Hook verboten, das ist
   ein bewusster manueller Einmal-Schritt. Ohne aktive Protection verweigert der
   Runner-Pre-Flight den Start (kein Auto-Merge ohne serverseitiges Gate).
6. **CI-Gate (optional, Operator fragen):** `${CLAUDE_PLUGIN_ROOT}/templates/ci/pr-deep-review.yml.template`
   nach `.github/workflows/pr-deep-review.yml`, `${CLAUDE_PLUGIN_ROOT}/templates/ci/tools/pr_review/*`
   nach `.github/scripts/flowkit_review/`, beide setup-Actions
   (`${CLAUDE_PLUGIN_ROOT}/templates/ci/setup-claude-action`,
   `${CLAUDE_PLUGIN_ROOT}/templates/ci/setup-python-uv`) nach `.github/actions/`.

   **Downgrade-Schutz für den `anthropics/claude-code-action`-Pin:** läuft in
   zwei Teilen um das Kopieren herum, weil Teil 1 den ALTEN Stand lesen muss,
   BEVOR er überschrieben wird. Die beiden Versionen NICHT selbst vergleichen
   (`v1.0.9` sieht lexikalisch neuer aus als `v1.0.183`, ist es aber nicht) —
   die folgenden Blöcke WÖRTLICH ausführen, nicht paraphrasieren.

   TEIL 1 — VOR dem Überschreiben von `.github/workflows/pr-deep-review.yml`:
   `PIN_TEMPLATE="${CLAUDE_PLUGIN_ROOT}/templates/ci/pr-deep-review.yml.template"`
   und `PIN_INSTALLED=".github/workflows/pr-deep-review.yml"` setzen, dann:

   ```bash
   # flowkit:action-pin-guard (Beginn)
   # Eingaben: PIN_TEMPLATE (Pflicht), PIN_INSTALLED (Default unten, Datei darf fehlen).
   # Ausgabe: vier key=value-Zeilen auf stdout. Exit 2 nur, wenn das TEMPLATE
   # selbst keinen Pin hat — dann Schritt 6 abbrechen und im Bericht melden.
   : "${PIN_TEMPLATE:?PIN_TEMPLATE (Pfad zum pr-deep-review.yml.template) muss gesetzt sein}"
   PIN_INSTALLED="${PIN_INSTALLED:-.github/workflows/pr-deep-review.yml}"
   PIN_RE='anthropics/claude-code-action@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+'
   tpl_pin="$(grep -m1 -oE "$PIN_RE" "$PIN_TEMPLATE" 2>/dev/null || true)"
   if [ -z "$tpl_pin" ]; then echo "pin_decision=error-no-template-pin"; exit 2; fi
   tpl_ver="${tpl_pin##*# }"
   cur_pin=""
   if [ -f "$PIN_INSTALLED" ]; then
     cur_pin="$(grep -m1 -oE "$PIN_RE" "$PIN_INSTALLED" 2>/dev/null || true)"
   fi
   if [ -z "$cur_pin" ]; then
     printf 'pin_decision=no-installed-pin\npin_template=%s\npin_installed=-\npin_keep_sha=-\n' "$tpl_ver"
     exit 0
   fi
   cur_sha="${cur_pin#*@}"; cur_sha="${cur_sha%% *}"; cur_ver="${cur_pin##*# }"
   newest="$(printf '%s\n%s\n' "$tpl_ver" "$cur_ver" | sort -V | tail -1)"
   if [ "$newest" = "$cur_ver" ] && [ "$cur_ver" != "$tpl_ver" ]; then
     printf 'pin_decision=keep-installed\npin_template=%s\npin_installed=%s\npin_keep_sha=%s\n' "$tpl_ver" "$cur_ver" "$cur_sha"
   else
     printf 'pin_decision=template\npin_template=%s\npin_installed=%s\npin_keep_sha=-\n' "$tpl_ver" "$cur_ver"
   fi
   # flowkit:action-pin-guard (Ende)
   ```

   Die vier Ausgabezeilen (`pin_decision`, `pin_template`, `pin_installed`,
   `pin_keep_sha`) für den Abschlussbericht (Schritt 8) merken. Bei
   `pin_decision=error-no-template-pin` Schritt 6 abbrechen und im Bericht
   melden — das Template selbst hat keinen gültigen Pin, das kommt nur bei
   einem kaputten Plugin-Stand vor.

   TEIL 2 — NACH dem Kopieren, NUR bei `pin_decision=keep-installed`: die
   beiden erhaltenswerten Werte aus Teil 1 in Variablen übernehmen
   (`PIN_KEEP_SHA=<pin_keep_sha aus Teil 1>`,
   `PIN_KEEP_VER=<pin_installed aus Teil 1>` — Werte einsetzen, nicht als Text
   im Befehl stehen lassen) und dann WÖRTLICH:

   ```bash
   # flowkit:action-pin-restore (Beginn)
   : "${PIN_KEEP_SHA:?PIN_KEEP_SHA (der zu erhaltende SHA aus Teil 1, Feld pin_keep_sha) muss gesetzt sein}"
   : "${PIN_KEEP_VER:?PIN_KEEP_VER (der zugehörige Versionskommentar aus Teil 1, Feld pin_installed) muss gesetzt sein}"
   PIN_INSTALLED="${PIN_INSTALLED:-.github/workflows/pr-deep-review.yml}"
   sed -E -i.flowkitbak \
     "s|anthropics/claude-code-action@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+|anthropics/claude-code-action@${PIN_KEEP_SHA} # ${PIN_KEEP_VER}|g" \
     "$PIN_INSTALLED"
   rm -f "${PIN_INSTALLED}.flowkitbak"
   # flowkit:action-pin-restore (Ende)
   ```

   Bei `pin_decision=template` (auch bei Gleichstand) bleibt der Template-Pin
   stehen, Teil 2 entfällt. Bei `pin_decision=no-installed-pin` — bestehende
   Datei ohne SHA-Pin, z. B. ein beweglicher `@v1`-Tag — gewinnt ebenfalls das
   Template; das ist eine Härtung, kein Downgrade. In jedem Fall eine Zeile
   für den Abschlussbericht merken.

   Platzhalter aus `.github/flowkit-review.json` (aus Template anlegen) ersetzen.
   Neue Config-Keys mit dem Operator klären: `criticalPaths` (Array von
   Pfad-Präfixen, deren Änderungen die Reviewer auf P1 eskalieren — z. B.
   Produktions-Endpunkte oder Datenmodelle; leeres Array = keine pfadbasierte
   Eskalation) und `deadCode` (`"auto"` = Default, dead-code-Job läuft nur bei
   Python-Markern im Repo-Root (pyproject.toml/setup.py/setup.cfg); `"on"` /
   `"off"` erzwingen bzw. deaktivieren ihn — für Nicht-Python-Repos `"auto"`
   oder `"off"`).
   Secrets-Check: `gh secret list` muss CLAUDE_CODE_OAUTH_TOKEN enthalten, sonst
   Operator-Hinweis. Danach `actionlint` auf die erzeugte Datei, falls installiert.
   **Versions-Stempel:** wie in Schritt 5 `PLUGIN_VERSION` aus
   `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` lesen und in JEDE gerade
   kopierte `.yml`-Datei (`.github/workflows/pr-deep-review.yml` sowie die
   beiden Actions `.github/actions/setup-claude-action/action.yml` und
   `.github/actions/setup-python-uv/action.yml`) nahe dem Dateianfang die
   Zeile `# flowkit-template-version: <PLUGIN_VERSION>` einfügen bzw. bei
   Re-Setup ersetzen. Keine erneute `.claude/flowkit-version` schreiben — die
   zentrale Stempel-Datei aus Schritt 5 bleibt die einzige.
6b. **Blockierende Gates (nur wenn das Zielrepo KEINE eigene CI mit Test/Lint/Build
   hat — Repos mit bestehender CI überspringen diesen Punkt):**
   `${CLAUDE_PLUGIN_ROOT}/templates/ci/gates.yml.template` nach `.github/workflows/gates.yml`;
   Platzhalter ersetzen: {{SETUP_CMD}} = CONFIG.commands.setup (z. B. "uv sync --extra dev"),
   {{TEST_CMD}}/{{LINT_CMD}}/{{TYPECHECK_CMD}} aus CONFIG.commands,
   {{DEFAULT_BRANCH}} aus CONFIG.defaultBranch. Ist CONFIG.commands.typecheck
   leer, den Typecheck-Step (`- name: Typecheck (blocking)` samt `run:`-Zeile)
   ersatzlos ENTFERNEN — ein leerer `run:` wäre ein kaputter Pflicht-Step, der
   jeden Merge blockiert. Danach `actionlint`, falls installiert.
7. **.gitignore-Guard (versionierbar machen, idempotent):**
   `bash ${CLAUDE_PLUGIN_ROOT}/scripts/gitignore-guard.sh .` ausführen. Das
   Script ignoriert die Laufzeit-Artefakte des Runners (`.flowkit/`,
   `.claude/worktrees/`), soweit sie es nicht schon sind, und stellt die in
   Schritt 5 erzeugten Dateien frei, falls ein Ignore-Muster greift:
   `.claude/flowkit-version`, `.claude/settings.json`,
   `.claude/workflow.config.json`, `.claude/hooks/*.sh`. Jede Zeile hängt an
   einer eigenen Bedarfsprüfung (`git check-ignore`) — was vorher sichtbar war,
   bleibt sichtbar. Es schreibt genau EINEN markierten Block
   (`# >>> flowkit` … `# <<< flowkit`) und baut ihn bei jedem Lauf neu; ein
   zweites `/flowkit:setup` erzeugt keine doppelten Zeilen. Die .gitignore
   darüber hinaus NICHT von Hand ändern und keine Negation selbst anhängen:
   eine nackte `!.claude/flowkit-version`-Zeile ist wirkungslos, weil Git in ein
   ausgeschlossenes Elternverzeichnis nicht absteigt.
   Ausgabe UND Exit-Code auswerten:
   - `gitignore-guard: ok …` bzw. `gitignore-guard: fixed <pfade>` (Exit 0) →
     im Abschlussbericht nennen, was ergänzt wurde.
   - `gitignore-guard: BLOCKIERT trotz Ergänzung: <pfade>` (Exit 3) → die Pfade
     bleiben ignoriert (typisch: eine eigene `.gitignore` INNERHALB von
     `.claude/`). NICHT mit `git add -f` erzwingen. Stattdessen wörtlich in den
     Abschlussbericht: „Drift-Warnung inaktiv: <pfade> lassen sich in diesem
     Repo nicht versionieren — die Templates-veraltet-Meldung des
     SessionStart-Hooks löst in frischen Clones nie aus."
   - Exit 1 (kein Git-Work-Tree bzw. .gitignore nicht schreibbar) → ebenfalls in
     den Bericht; Setup läuft weiter.
8. **Abschlussbericht:** was angelegt/geändert/übersprungen wurde, als Chat-Ausgabe;
   bei installiertem CI-Gate ZWINGEND eine Zeile zum `claude-code-action`-Pin —
   welche Version jetzt in `.github/workflows/pr-deep-review.yml` steht,
   welche das Template mitbringt, und bei `pin_decision=keep-installed`
   ausdrücklich „neuerer Pin im Zielrepo beibehalten, Template-Pin
   `<pin_template>` ist älter"; Änderungen im Zielrepo als Branch + PR (Titel
   "chore: install flowkit"), NICHT direkt auf den Default-Branch.
   Vor dem Commit die von Schritt 7 freigestellten Pfade explizit stagen —
   ZUSÄTZLICH zu allem, was Schritt 1, 6 und 6b erzeugt haben:
   `git add .gitignore .claude/flowkit-version .claude/settings.json .claude/workflow.config.json .claude/hooks`
   plus, soweit in diesem Lauf angelegt oder geändert, `AGENTS.md`,
   `.github/workflows/pr-deep-review.yml`, `.github/flowkit-review.json`,
   `.github/scripts/flowkit_review`, `.github/actions/setup-claude-action`,
   `.github/actions/setup-python-uv` und `.github/workflows/gates.yml`.
   Der Installations-PR MUSS die `.claude/`-Dateien enthalten, sonst ist die
   Installation rein lokal und in jedem Clone wirkungslos; er MUSS ebenso das
   CI-Gate enthalten, sonst installiert er eine Konfiguration ohne den Prüfpfad,
   den sie voraussetzt. Kein blankes `git add -A`: es verschluckt ein Scheitern
   von Schritt 7 still und sammelt lokalen Claude-Zustand mit ein. Meldete
   Schritt 7 `BLOCKIERT`, die betroffenen Pfade NICHT erzwingen — weglassen und
   den dortigen Hinweis-Satz in den Bericht übernehmen.
