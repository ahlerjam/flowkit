---
name: critic
description: Use when a pull request needs the cross-vendor critic pass (Codex reviews the diff against the issue spec and AGENTS.md, including test-manipulation checks) — normally invoked by the implement runner, usable standalone with a PR number.
---

# flowkit:critic — Cross-Vendor-Zweitgutachter

> Voraussetzung: OpenAI Codex CLI, Login-Befund siehe flowkit `docs/verifikation/annahmen.md`
> (A1). Läuft A1 auf „nein": vor dem Aufruf `OPENAI_API_KEY` exportieren; der Aufruf
> selbst ist identisch. CONFIG = `.claude/workflow.config.json`.

## Schritt 0 — Verfügbarkeits-Check (Auto-Skip statt Fehlversuch)

Prüfe ZUERST, ob Codex überhaupt nutzbar ist:

    codex login status >/dev/null 2>&1 || test -n "$OPENAI_API_KEY"

Schlägt BEIDES fehl (kein Login, kein Key — z. B. Operator hat derzeit kein
OpenAI-Abo), entscheidet `CONFIG.critic.fallback` (Default: `"claude"`):

**`"claude"` — Same-Family-Ersatz-Review (Default):** Führe das Review SELBST
durch, ohne codex: Material wie in Schritt 1 sammeln, dann die Regeln aus
Schritt 2 wörtlich auf dich selbst anwenden — aber mit ENGEM Fokus, um das
pr-deep-review-Gate nicht zu doppeln: NUR (a) Spec-Compliance (verletzt der Diff
ein Akzeptanzkriterium oder AGENTS.md-Konventionen?) und (b) die PFLICHTPRÜFUNG
Test-Manipulation. KEINE Stil-, Struktur- oder Performance-Findings (dafür ist
pr-deep-review zuständig). Severity-Regeln und Ausgabeformat wie in Schritt 3-4;
der PR-Kommentar beginnt mit dem Marker und kennzeichnet in der zweiten Zeile:
`**Claude-Fallback** (same-family — Cross-Vendor-Effekt entfällt, bis codex
verfügbar ist).`

**`"skip"`:** poste als PR-Kommentar (erste Zeile exakt der Critic-Marker aus
CONFIG.markers.critic):

    <marker>
    **Critic übersprungen** — Codex nicht konfiguriert (kein Login, kein OPENAI_API_KEY).
    Die übrigen Verifikations-Schichten (deterministische Gates, AC-Verifier,
    pr-deep-review, Post-Merge-Smoke) tragen das Gate. Aktivierung: `codex login`
    oder OPENAI_API_KEY setzen — keine Config-Änderung nötig.

und beende mit `{ "blockers": [] }` (Skip blockt nie).

In beiden Fällen: NICHT versuchen, codex trotzdem aufzurufen. Ist Codex
verfügbar → weiter mit Schritt 1 (der Fallback greift dann nie).

## Auftrag

Ein unabhängiges Modell einer ANDEREN Familie prüft den Diff — nicht zur Doppelung
des AC-Verifiers, sondern gegen korrelierte Fehler der Claude-Familie und gegen
Test-Manipulation.

## Ablauf (Input: PR-Nummer $PR; REPO_SLUG aus CONFIG)

1. Material sammeln (read-only):

       TMP=$(mktemp -d)
       gh issue view $(gh pr view $PR -R "$REPO_SLUG" --json body -q '.body' | grep -oE 'Closes #[0-9]+' | grep -oE '[0-9]+' | head -1) \
         -R "$REPO_SLUG" --json title,body -q '"# " + .title + "\n\n" + .body' > "$TMP/issue.md" || echo "(kein verknüpftes Issue)" > "$TMP/issue.md"
       gh pr diff $PR -R "$REPO_SLUG" > "$TMP/diff.patch"
       head -c 204800 "$TMP/diff.patch" > "$TMP/diff.bounded.patch"
       cp AGENTS.md "$TMP/AGENTS.md" 2>/dev/null || echo "(kein AGENTS.md)" > "$TMP/AGENTS.md"

2. Critic-Prompt bauen (`$TMP/prompt.txt`):

       Du bist ein adversarialer Code-Reviewer. Prüfe den Diff (diff.bounded.patch)
       gegen die Spec (issue.md) und die Konventionen (AGENTS.md). Regeln:
       - NUR geänderte Zeilen bewerten; jedes Finding braucht file:line aus dem Diff
         plus ein konkretes Fehlerszenario. Kannst du beides nicht liefern, lass es weg.
       - PFLICHTPRÜFUNG Test-Manipulation: gelöschte Tests, Assertions entfernt oder
         aufgeweicht, Tests die nicht fehlschlagen können (assert True, leerer Body,
         unconditional skip/xfail), verschluckte Exceptions auf Produktionspfaden.
         Jeder Treffer ist P1, Kategorie "test-gaming".
       - Severity: P0 = im Diff beobachtbar UND exploitable/datenverlustträchtig.
         P1 = neuer nutzersichtbarer Bug, Spec-Verletzung eines Akzeptanzkriteriums,
         Test-Gaming. P2 = alles Weitere. Bei Unsicherheit über P0/P1: weglassen.
       - Antworte NUR mit JSON: {"findings":[{"severity":"P0|P1|P2","title":"...",
         "file":"...","line":0,"evidence":"..."}]}

3. Ausführen:

       cd "$TMP" && codex exec --sandbox read-only "$(cat prompt.txt)

       Dateien liegen im aktuellen Verzeichnis: issue.md, diff.bounded.patch, AGENTS.md" > raw.out 2>&1
       # JSON extrahieren — robust: Kandidaten von hinten durchprobieren, nie crashen
       # (greedy r'\{.*\}' würde bei Log-Zeilen mit Braces json.loads werfen):
       python3 - <<'PY'
       import json, re
       raw = open('raw.out').read()
       data = {"findings": []}
       for m in reversed(re.findall(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw, re.S)):
           try:
               cand = json.loads(m)
           except Exception:
               continue
           if isinstance(cand, dict) and 'findings' in cand:
               data = cand
               break
       json.dump(data, open('findings.json', 'w'))
       print(f"{len(data.get('findings', []))} findings")
       PY

   Schlägt `codex exec` selbst fehl (Binary fehlt, Auth): NICHT stumm weiter —
   Kommentar posten „Critic-Station übersprungen: <Grund>" und { blockers: [] }
   mit note zurückgeben; der Runner behandelt das nicht als grün geprüft, sondern
   der Operator sieht es im PR.

4. Als PR-Kommentar posten, erste Zeile exakt der CONFIG.markers.critic-Marker
   (Default `<!-- critic:v1 -->`), danach je Finding eine Zeile
   `- **P0|P1|P2** file:line — title — evidence`, P2 gesammelt unter `<details>`.
5. Rückgabe an den Aufrufer: `blockers` = Titel aller P0/P1-Findings (leer, wenn keine).
