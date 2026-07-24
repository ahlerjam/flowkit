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
     `superpowers:verification-before-completion` → fehlen sie, degradieren
     Builder/Fix-Runden/PR-Vorbereitung auf die Inline-Disziplin der Prompts.
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
   `templates/AGENTS.md.template` interaktiv erzeugen — Platzhalter mit dem Operator
   klären, EIN AskUserQuestion-Block). `gh auth status` ok. REPO_SLUG via
   `gh repo view --json nameWithOwner -q .nameWithOwner`.
2. **Config:** `.claude/workflow.config.json` aus `templates/workflow.config.json.template`
   anlegen (existiert sie: nur fehlende Felder ergänzen). Werte aus AGENTS.md/README
   ableiten, Unklares im selben AskUserQuestion-Block wie oben klären. Gegen
   `templates/workflow.config.schema.json` validieren (python3 + json, ohne
   Fremdpakete: Pflichtfelder und Typen manuell prüfen).
3. **Labels** (idempotent, `gh label create … || true`):
   size/S size/M size/L (Farbe ededed), needs-triage (fbca04), agent-ready (0e8a16),
   budget-exceeded (d93f0b), needs-human (d876e3), flow/quick (c2e0c6) sowie fehlende
   type/*, priority/P0..P3, area/* aus CONFIG.areas.
4. **Board (optional, Stufe-1-Delta §13):** Labels sind in Stufe 1 die einzige
   Pflicht-Übersicht. Auf Operator-Wunsch: `gh project create --owner <owner>
   --title "flowkit — <repo>"` anlegen und dem Operator sagen, dass die
   Status-Spalten (Triage / Ready / In Arbeit / PR offen / Fertig) einmalig von
   Hand in der Projects-UI angelegt werden müssen (die Spalten-Anlage per CLI
   bräuchte GraphQL-Mutationen — rote Linie). Kein Runner-Board-Sync in Stufe 1.
5. **Hooks + Settings:** `templates/hooks/*.sh` nach `.claude/hooks/` kopieren,
   `chmod +x`. `templates/settings.json.template` nach `.claude/settings.json`
   (existiert eine: hooks/permissions-Blöcke mergen, nichts löschen). Platzhalter
   ersetzen: {{PROTECTED_BRANCHES}} aus CONFIG.defaultBranch (+ master), {{OVERRIDE_LABEL}}
   aus CONFIG.overrideLabel, {{STACK_ALLOW}} = Allow-Zeilen für die Kommandopräfixe
   aus CONFIG.commands/extraGates (z. B. "Bash(uv run *)"), {{FORMAT_CMD_PY}} = Format-
   Kommando des Repos oder `true` wenn keins. Danach validieren:
   `python3 -m json.tool .claude/settings.json >/dev/null` (das Template selbst ist
   wegen {{STACK_ALLOW}} kein valides JSON — das installierte Ergebnis MUSS es sein)
   und `bash templates/hooks/test-pretooluse-blocker.sh` gegen die installierte Fassung.
5b. **Branch-Protection (Merge-Voraussetzung, Spec §6):** read-only prüfen:
   `gh api repos/$REPO_SLUG/branches/<defaultBranch>/protection` (GET ist erlaubt).
   Bei 404: dem Operator die Einrichtung anleiten (GitHub → Settings → Branches →
   Add branch ruleset: require status checks = CONFIG.mergeCheck bzw. CI-Gates,
   require PR before merging) — gh-api-Mutationen sind per Hook verboten, das ist
   ein bewusster manueller Einmal-Schritt. Ohne aktive Protection verweigert der
   Runner-Pre-Flight den Start (kein Auto-Merge ohne serverseitiges Gate).
6. **CI-Gate (optional, Operator fragen):** `templates/ci/pr-deep-review.yml.template`
   nach `.github/workflows/pr-deep-review.yml`, `templates/ci/tools/pr_review/*` nach
   `.github/scripts/flowkit_review/`, beide setup-Actions nach `.github/actions/`.
   Platzhalter aus `.github/flowkit-review.json` (aus Template anlegen) ersetzen.
   Secrets-Check: `gh secret list` muss CLAUDE_CODE_OAUTH_TOKEN enthalten, sonst
   Operator-Hinweis. Danach `actionlint` auf die erzeugte Datei, falls installiert.
6b. **Blockierende Gates (nur wenn das Zielrepo KEINE eigene CI mit Test/Lint/Build
   hat — Repos mit bestehender CI überspringen diesen Punkt):**
   `templates/ci/gates.yml.template` nach `.github/workflows/gates.yml`; Platzhalter
   ersetzen: {{SETUP_CMD}} = Setup-Kommando aus CONFIG (z. B. "uv sync --extra dev"),
   {{TEST_CMD}}/{{LINT_CMD}}/{{TYPECHECK_CMD}} aus CONFIG.commands,
   {{DEFAULT_BRANCH}} aus CONFIG.defaultBranch. Danach `actionlint`, falls installiert.
7. **.gitignore:** Zeile `.flowkit/` ergänzen.
8. **Abschlussbericht:** was angelegt/geändert/übersprungen wurde, als Chat-Ausgabe;
   Änderungen im Zielrepo als Branch + PR (Titel "chore: install flowkit"), NICHT
   direkt auf den Default-Branch.
