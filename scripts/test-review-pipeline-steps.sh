#!/usr/bin/env bash
# Testet die kritischen Bash-Blöcke aus templates/ci/pr-deep-review.yml.template
# und commands/setup.md lokal, komplett ohne Netzzugriff und ohne echten
# GitHub-Actions-Lauf.
#
# EHRLICHER SCOPE: Dies ersetzt KEIN echtes Actions-E2E (das steht noch aus —
# Artifact-Up-/Downloads, echte GitHub-Events, Merge-/Race-Verhalten und die
# LLM-Reviewer-Schritte selbst werden hier NICHT geprüft). Getestet wird
# ausschließlich die SHELL-LOGIK der folgenden Steps:
#
#   (a) dead-code-Gating (Job "prep", Step "Detect change categories"):
#       deadCode-Konfig on/off/auto × Python-Projektmarker vorhanden/fehlt.
#       Der Block ist reines Bash (keine GH-Actions-Ausdruckssyntax) — wir
#       extrahieren ihn WÖRTLICH aus dem Template und FÜHREN ihn aus. Das ist
#       stärker als eine Nachbau-Funktion: es kann gar nicht wegdriften, weil
#       exakt der Template-Text läuft.
#   (b) Label-Event-Skip-Bedingung von "prep" (`if: >-` auf Job-Ebene): das
#       ist GH-Actions-Ausdruckssyntax, keine Bash — die können wir nicht
#       ausführen. Wir bauen die Logik als Bash-Funktion nach UND verifizieren
#       per exaktem Text-Vergleich (diff), dass der Ausdruck im Template noch
#       genau der ist, den die Funktion abbildet — bei Abweichung FAIL, statt
#       stillem Wegdriften.
#   (c) "Enforce gate policy" (Job "coordinator"): Override-Label-Live-Query
#       + Actor-Fallback. Block wörtlich extrahiert, mit gestubbtem `gh` und
#       dem echten gate.py ausgeführt.
#   (d) Review-Cache-Check (Job "prep", Step "id: cache"): Block wörtlich
#       extrahiert, mit gestubbtem `gh` (liefert eine Sticky-Comment-Fixture)
#       und dem echten cache_check.py ausgeführt.
#   (e) Action-Pin-Registry: jede echte `- uses: anthropics/claude-code-
#       action@<SHA>`-Zeile im Template muss ZEICHENGLEICH dem kanonischen
#       Pin entsprechen — SHA UND Versionskommentar, reiner Textvergleich,
#       kein Netz. Ein zweiter, unabhängiger Grep prüft zusätzlich auf
#       beweglich gepinnte Referenzen (`@v1`, `@main`, …); er verankert
#       genauso wenig auf dem Wartungs-Kommentar am Dateianfang wie die
#       Registry-Prüfung selbst, weil beide ein Muster suchen, das eine reine
#       Prosa-Erwähnung nicht erfüllt.
#   (f) Downgrade-Schutz aus commands/setup.md: die beiden Blöcke zwischen
#       den Markern `# flowkit:action-pin-guard` (Entscheidung) und
#       `# flowkit:action-pin-restore` (Reparatur) werden WÖRTLICH
#       extrahiert und gegen Fixtures ausgeführt — sowohl die Entscheidung
#       (fehlende Datei / kein SHA-Pin / älter / gleich / neuer) als auch,
#       im "neuer"-Fall, der tatsächliche Rückschreib-`sed`. Gleiche Logik
#       wie (a): es kann nicht wegdriften, weil exakt der ausgelieferte Text
#       läuft.
#
# Aufruf: bash scripts/test-review-pipeline-steps.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/templates/ci/pr-deep-review.yml.template"
GATE_PY="$ROOT/templates/ci/tools/pr_review/gate.py"
CACHE_CHECK_PY="$ROOT/templates/ci/tools/pr_review/cache_check.py"
[ -f "$TEMPLATE" ] || { echo "FAIL: Template nicht gefunden: $TEMPLATE"; exit 1; }
[ -f "$GATE_PY" ] || { echo "FAIL: gate.py nicht gefunden: $GATE_PY"; exit 1; }
[ -f "$CACHE_CHECK_PY" ] || { echo "FAIL: cache_check.py nicht gefunden: $CACHE_CHECK_PY"; exit 1; }
JQ_BIN="$(command -v jq 2>/dev/null || true)"
[ -n "$JQ_BIN" ] || { echo "FAIL: jq nicht im PATH — für die gh-Stubs erforderlich"; exit 1; }

pass=0; fail=0
ok() { pass=$((pass+1)); }
ko() { echo "FAIL: $1"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Hilfsfunktionen: Step-Blöcke wörtlich aus dem Template ziehen.
# ---------------------------------------------------------------------------

# find_unique_line <fixed-string> — Zeilennummer des EINEN Treffers im
# Template; FAIL (leere Ausgabe + Fehlermeldung auf stderr), wenn der Anker
# nicht existiert oder mehrfach vorkommt (sonst wäre die Extraktion zufällig).
find_unique_line() {
  local pattern="$1" n
  n="$(grep -nF -- "$pattern" "$TEMPLATE" | wc -l | tr -d ' ')"
  if [ "$n" != "1" ]; then
    echo "FAIL: Anker nicht eindeutig (${n}x) im Template: $pattern" >&2
    return 1
  fi
  grep -nF -- "$pattern" "$TEMPLATE" | cut -d: -f1
}

# find_block_start <end-line> — nächstgelegene 'set -euo pipefail'-Zeile davor.
# Jeder `run:`-Block in diesem Template beginnt damit; das grenzt einen Step
# sauber vom vorigen ab, ohne auf Step-Namen angewiesen zu sein.
find_block_start() {
  local end="$1"
  awk -v end="$end" '
    NR<=end && $0 ~ /^ *set -euo pipefail$/ { start=NR }
    END { print start+0 }
  ' "$TEMPLATE"
}

# extract_lines <start> <end> <outfile> — Zeilen dedenten (10 Spalten, die
# Einrücktiefe von `run: |`-Blöcken in diesem Template) und wegschreiben.
extract_lines() {
  local start="$1" end="$2" out="$3"
  sed -n "${start},${end}p" "$TEMPLATE" | cut -c11- > "$out"
}

# extract_step <end-pattern> <outfile> — kompletter run:-Block eines Steps,
# gefunden über die eindeutige Endzeile + die 'set -euo pipefail'-Startzeile.
extract_step() {
  local end_pattern="$1" out="$2" end start
  end="$(find_unique_line "$end_pattern")" || return 1
  start="$(find_block_start "$end")"
  if [ "$start" -le 0 ]; then
    echo "FAIL: kein 'set -euo pipefail' vor Zeile $end gefunden" >&2
    return 1
  fi
  extract_lines "$start" "$end" "$out"
}

fails_before_extraction=0

echo "== (a) dead-code Gating =="
# Block ist reines Bash — wörtlich extrahieren und direkt ausführen.
DEAD_START="$(find_unique_line 'DEAD_MODE="$(jq -r')" || fails_before_extraction=1
DEAD_END="$(find_unique_line 'echo "run_dead_code=$RUN_DEAD"')" || fails_before_extraction=1
if [ "$fails_before_extraction" = "1" ]; then
  ko "(a) Anker für dead-code-Block nicht gefunden — Template hat sich strukturell geändert"
else
  extract_lines "$DEAD_START" "$DEAD_END" "$WORK/dead-code-block.sh"

  run_dead_code_case() { # <deadMode> <marker: yes|no> -> stdout: true|false
    local dead_mode="$1" marker="$2" d
    d="$WORK/dead-$dead_mode-$marker"
    mkdir -p "$d"
    printf '{"deadCode": "%s"}\n' "$dead_mode" > "$d/flowkit-review.json"
    [ "$marker" = "yes" ] && : > "$d/pyproject.toml"
    (
      cd "$d" || exit 1
      # Der Template-Block liest ".github/flowkit-review.json" relativ zum
      # Repo-Root — hier simuliert durch das Test-Arbeitsverzeichnis selbst.
      mkdir -p .github
      cp flowkit-review.json .github/flowkit-review.json
      export GITHUB_OUTPUT="$d/out.txt"
      : > "$GITHUB_OUTPUT"
      bash "$WORK/dead-code-block.sh"
    ) >/dev/null 2>&1
    grep -oE 'run_dead_code=(true|false)' "$d/out.txt" | cut -d= -f2
  }

  check_dead() { # <deadMode> <marker> <erwartet>
    local mode="$1" marker="$2" expected="$3" got
    got="$(run_dead_code_case "$mode" "$marker")"
    if [ "$got" = "$expected" ]; then ok
    else ko "dead-code Modus=$mode Marker=$marker: erwartet $expected, bekam '$got'"; fi
  }

  check_dead on  yes true
  check_dead on  no  true
  check_dead off yes false
  check_dead off no  false
  check_dead auto yes true
  check_dead auto no  false
fi

echo "== (b) Label-Event-Skip-Bedingung von prep =="
# `if: >-` ist GH-Actions-Ausdruckssyntax, kein Bash — daher nachgebaut UND
# per exaktem Textvergleich gegen das Template verifiziert.
IF_START="$(find_unique_line 'if: >-')" || true
if [ -z "${IF_START:-}" ]; then
  ko "(b) Anker 'if: >-' nicht gefunden — Template hat sich strukturell geändert"
else
  IF_END=$((IF_START + 3))
  ACTUAL_IF="$WORK/actual-if.txt"
  sed -n "${IF_START},${IF_END}p" "$TEMPLATE" > "$ACTUAL_IF"

  EXPECTED_IF="$WORK/expected-if.txt"
  cat > "$EXPECTED_IF" <<'EOF'
    if: >-
      github.event.pull_request.draft == false &&
      (github.event.action != 'labeled' && github.event.action != 'unlabeled' ||
       github.event.label.name == '{{OVERRIDE_LABEL}}')
EOF

  if diff -u "$EXPECTED_IF" "$ACTUAL_IF" >"$WORK/if-diff.txt" 2>&1; then
    ok
  else
    ko "(b) prep's if-Ausdruck im Template weicht von der nachgebauten Logik ab — Test UND Template abgleichen:"
    cat "$WORK/if-diff.txt" >&2
  fi

  # Nachbau der Bedingung als Bash-Funktion (spiegelt exakt den obigen Text).
  prep_should_run() { # <draft:true|false> <action> <label_name> <override_label> -> 0=run 1=skip
    local draft="$1" action="$2" label_name="$3" override_label="$4"
    [ "$draft" = "false" ] || return 1
    if [ "$action" != "labeled" ] && [ "$action" != "unlabeled" ]; then
      return 0
    fi
    [ "$label_name" = "$override_label" ]
  }

  check_prep() { # <desc> <draft> <action> <label> <override> <erwartet: run|skip>
    local desc="$1" draft="$2" action="$3" label="$4" override="$5" expected="$6"
    if prep_should_run "$draft" "$action" "$label" "$override"; then got=run; else got=skip; fi
    if [ "$got" = "$expected" ]; then ok
    else ko "$desc: erwartet $expected, bekam $got"; fi
  }

  check_prep "labeled mit fremdem Label -> skip" \
    false labeled size-M override-claude-review skip
  check_prep "labeled mit Override-Label -> läuft" \
    false labeled override-claude-review override-claude-review run
  check_prep "unlabeled mit fremdem Label -> skip" \
    false unlabeled size-M override-claude-review skip
  check_prep "unlabeled mit Override-Label -> läuft" \
    false unlabeled override-claude-review override-claude-review run
  check_prep "synchronize -> läuft (kein Label-Event)" \
    false synchronize "" override-claude-review run
  check_prep "opened -> läuft (kein Label-Event)" \
    false opened "" override-claude-review run
  check_prep "Draft-PR -> skip unabhängig vom Event" \
    true synchronize "" override-claude-review skip
fi

# ---------------------------------------------------------------------------
# Generischer gh-Stub für (c)/(d): --jq-Programm extrahieren, per echtem jq
# über eine Fixture-Datei laufen lassen (wie templates/hooks/test-inject-context.sh).
# ---------------------------------------------------------------------------
STUB="$WORK/bin-stub"
mkdir -p "$STUB"
cat > "$STUB/gh" <<'EOSTUB'
#!/usr/bin/env bash
set -u
jqprog=""; prev=""
for a in "$@"; do
  [ "$prev" = "--jq" ] && jqprog="$a"
  prev="$a"
done
case "${1:-}" in
  pr) f="$GH_STUB_FIX/pr.json" ;;
  api)
    case "${2:-}" in
      *"/events") f="$GH_STUB_FIX/events.json" ;;
      *"/comments") f="$GH_STUB_FIX/comments.json" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
if [ -n "$jqprog" ]; then "$GH_STUB_JQ" -r "$jqprog" < "$f"; else cat "$f"; fi
EOSTUB
chmod +x "$STUB/gh"

echo "== (c) Override-Label-Live-Query + Actor-Fallback (Enforce gate policy) =="
GATE_END="$(find_unique_line '--labels "$PR_LABELS"')" || true
if [ -z "${GATE_END:-}" ]; then
  ko "(c) Anker für Enforce-gate-Block nicht gefunden — Template hat sich strukturell geändert"
else
  GATE_START="$(find_block_start "$GATE_END")"
  if [ "$GATE_START" -le 0 ]; then
    ko "(c) kein 'set -euo pipefail' vor dem Enforce-gate-Block gefunden"
  else
    extract_lines "$GATE_START" "$GATE_END" "$WORK/gate-block-raw.sh"
    # Der Template-Pfad .github/scripts/flowkit_review/ existiert nur im
    # Ziel-Repo NACH /flowkit:setup (der Installer kopiert
    # templates/ci/tools/pr_review/ dorthin, siehe commands/setup.md). Für den
    # Test zeigen wir auf die tatsächliche Quelle in DIESEM Repo — sonst
    # nichts an der extrahierten Logik verändert.
    sed "s#\.github/scripts/flowkit_review/gate\.py#$GATE_PY#" \
      "$WORK/gate-block-raw.sh" > "$WORK/gate-block-subst.sh"
    # Test-Instrumentierung: PR_LABELS/GITHUB_ACTOR nach der Override-Logik,
    # aber VOR dem gate.py-Aufruf sichtbar machen — ändert keine Logikzeile,
    # ergänzt nur zwei Beobachtungspunkte. Splicing per Python (nicht sed -i):
    # der substituierte GATE_PY-Pfad enthält Slashes, die als sed-Adress-
    # Trennzeichen kollidieren würden — und BSD-/GNU-sed -i sind ohnehin nicht
    # portabel kompatibel.
    python3 - "$WORK/gate-block-subst.sh" "$WORK/gate-block.sh" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
lines = open(src).read().splitlines(keepends=True)
out = []
spliced = False
for line in lines:
    if line.lstrip().startswith("python3 ") and not spliced:
        out.append("printf 'PR_LABELS=%s\\n' \"$PR_LABELS\" > \"$RUNNER_TEMP/test-pr-labels.txt\"\n")
        out.append("printf 'GITHUB_ACTOR=%s\\n' \"$GITHUB_ACTOR\" > \"$RUNNER_TEMP/test-github-actor.txt\"\n")
        spliced = True
    out.append(line)
if not spliced:
    raise SystemExit("FAIL: keine 'python3 ...'-Zeile zum Splicen gefunden")
open(dst, "w").writelines(out)
PY

    mk_findings() { # <severity> -> findings.json mit einem Finding dieser Severity
      printf '{"findings":[{"severity":"%s","category":"regression","title":"t","evidence":"e"}]}\n' "$1"
    }

    run_gate_block() { # <PR_LABELS-fixture json> <events-fixture json|""> <initial actor> -> setzt RC/PR_LABELS/GITHUB_ACTOR/STDERR global
      local pr_json="$1" events_json="$2" initial_actor="$3"
      local d="$WORK/gate-run-$RANDOM"
      mkdir -p "$d/fix" "$d/runner_temp"
      printf '%s' "$pr_json" > "$d/fix/pr.json"
      printf '%s' "${events_json:-[]}" > "$d/fix/events.json"
      mk_findings P1 > "$d/runner_temp/findings.json"
      GATE_RC=0
      GATE_OUT="$(
        PATH="$STUB:$PATH" \
        GH_STUB_FIX="$d/fix" GH_STUB_JQ="$JQ_BIN" \
        GH_TOKEN=dummy PR=5 REPO=o/r \
        RUNNER_TEMP="$d/runner_temp" \
        GITHUB_ACTOR="$initial_actor" \
        FLOWKIT_OVERRIDE_LABEL="override-claude-review" \
        bash "$WORK/gate-block.sh" 2>&1
      )" || GATE_RC=$?
      GATE_LABELS="$(cut -d= -f2- "$d/runner_temp/test-pr-labels.txt" 2>/dev/null)"
      GATE_ACTOR="$(cut -d= -f2- "$d/runner_temp/test-github-actor.txt" 2>/dev/null)"
    }

    # Szenario A: Override-Label gesetzt, Timeline hat den labelnden Actor.
    run_gate_block \
      '{"labels":[{"name":"size-M"},{"name":"override-claude-review"}]}' \
      '[{"event":"labeled","label":{"name":"size-M"},"actor":{"login":"bot1"}},{"event":"labeled","label":{"name":"override-claude-review"},"actor":{"login":"alice"}}]' \
      "triggering-user"
    if [ "$GATE_LABELS" = "size-M,override-claude-review" ]; then ok
    else ko "(c-A) PR_LABELS: erwartet 'size-M,override-claude-review', bekam '$GATE_LABELS'"; fi
    if [ "$GATE_ACTOR" = "alice" ]; then ok
    else ko "(c-A) GITHUB_ACTOR: erwartet 'alice' (aus Timeline übernommen), bekam '$GATE_ACTOR'"; fi
    if [ "$GATE_RC" = "0" ] && printf '%s' "$GATE_OUT" | grep -qF "alice"; then ok
    else ko "(c-A) gate.py: erwartet exit 0 + Warnung mit 'alice', bekam rc=$GATE_RC out='$GATE_OUT'"; fi

    # Szenario B: Override-Label gesetzt, aber KEIN passendes Timeline-Event
    # -> Fallback bleibt der ursprüngliche (Trigger-)Actor.
    run_gate_block \
      '{"labels":[{"name":"override-claude-review"}]}' \
      '[{"event":"labeled","label":{"name":"size-M"},"actor":{"login":"bot1"}}]' \
      "triggering-user"
    if [ "$GATE_ACTOR" = "triggering-user" ]; then ok
    else ko "(c-B) GITHUB_ACTOR-Fallback: erwartet 'triggering-user', bekam '$GATE_ACTOR'"; fi
    if [ "$GATE_RC" = "0" ] && printf '%s' "$GATE_OUT" | grep -qF "triggering-user"; then ok
    else ko "(c-B) gate.py: erwartet exit 0 + Warnung mit Fallback-Actor, bekam rc=$GATE_RC out='$GATE_OUT'"; fi

    # Szenario C: kein Override-Label -> Timeline-Query läuft gar nicht erst,
    # gate.py blockt (P1 vorhanden, kein Override).
    run_gate_block '{"labels":[{"name":"size-M"}]}' '[]' "triggering-user"
    if [ "$GATE_LABELS" = "size-M" ]; then ok
    else ko "(c-C) PR_LABELS: erwartet 'size-M', bekam '$GATE_LABELS'"; fi
    if [ "$GATE_ACTOR" = "triggering-user" ]; then ok
    else ko "(c-C) GITHUB_ACTOR darf ohne Override-Label nicht verändert werden, bekam '$GATE_ACTOR'"; fi
    if [ "$GATE_RC" = "1" ]; then ok
    else ko "(c-C) gate.py: erwartet exit 1 (blockierend, kein Override), bekam rc=$GATE_RC out='$GATE_OUT'"; fi
  fi
fi

echo "== (d) Cache-Check-Integration (prep, id: cache) =="
CACHE_END="$(find_unique_line '--findings-out "$RUNNER_TEMP/cached-findings.json" >> "$GITHUB_OUTPUT"')" || true
if [ -z "${CACHE_END:-}" ]; then
  ko "(d) Anker für Cache-Check-Block nicht gefunden — Template hat sich strukturell geändert"
else
  CACHE_START="$(find_block_start "$CACHE_END")"
  if [ "$CACHE_START" -le 0 ]; then
    ko "(d) kein 'set -euo pipefail' vor dem Cache-Check-Block gefunden"
  else
    extract_lines "$CACHE_START" "$CACHE_END" "$WORK/cache-block-raw.sh"
    sed "s#\.github/scripts/flowkit_review/cache_check\.py#$CACHE_CHECK_PY#" \
      "$WORK/cache-block-raw.sh" > "$WORK/cache-block.sh"

    run_cache_block() { # <comments-fixture json> -> setzt CACHE_RC/CACHE_OUT global
      local comments_json="$1"
      local d="$WORK/cache-run-$RANDOM"
      mkdir -p "$d/fix" "$d/runner_temp"
      printf '%s' "$comments_json" > "$d/fix/comments.json"
      # Bounded diff: beliebiger, aber stabiler Inhalt — sein sha256 ist der
      # diffHash, den cache_check.py mit dem in der Sticky-Comment
      # eingebetteten JSON vergleicht.
      printf 'diff --git a/x b/x\n+demo\n' > "$d/runner_temp/diff.bounded.patch"
      CACHE_RC=0
      CACHE_OUT="$(
        PATH="$STUB:$PATH" \
        GH_STUB_FIX="$d/fix" GH_STUB_JQ="$JQ_BIN" \
        GH_TOKEN=dummy PR=5 REPO=o/r \
        RUNNER_TEMP="$d/runner_temp" \
        GITHUB_OUTPUT="$d/runner_temp/github_output.txt" \
        bash "$WORK/cache-block.sh" 2>&1
      )" || CACHE_RC=$?
      CACHE_GITHUB_OUTPUT="$(cat "$d/runner_temp/github_output.txt" 2>/dev/null)"
      CACHE_DIFF_PATCH="$d/runner_temp/diff.bounded.patch"
    }

    # Szenario HIT: vorherige Sticky-Comment mit passendem diffHash + gültigen
    # Findings -> cache_hit=true.
    d="$WORK/cache-run-$RANDOM"; mkdir -p "$d/runner_temp"
    printf 'diff --git a/x b/x\n+demo\n' > "$d/runner_temp/diff.bounded.patch"
    DIFF_HASH="$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$d/runner_temp/diff.bounded.patch")"
    HIT_PAYLOAD="$(python3 -c "import json,sys; print(json.dumps({'diffHash': sys.argv[1], 'findings': [{'severity':'P2','category':'style','title':'t','evidence':'e'}]}))" "$DIFF_HASH")"
    HIT_COMMENTS_JSON="$(python3 -c "
import json, sys
payload = sys.argv[1]
body = '<!-- flowkit-review:v1 -->\n## flowkit PR Deep Review\n\n<!-- flowkit-review-json:v1 ' + payload + ' -->'
print(json.dumps([{'body': body}]))
" "$HIT_PAYLOAD")"
    rm -rf "$d"

    run_cache_block "$HIT_COMMENTS_JSON"
    if printf '%s' "$CACHE_GITHUB_OUTPUT" | grep -qF "cache_hit=true"; then ok
    else ko "(d-HIT) erwartet cache_hit=true, bekam GITHUB_OUTPUT='$CACHE_GITHUB_OUTPUT' (stderr: $CACHE_OUT)"; fi

    # Szenario MISS: keine passende Sticky-Comment (leere Kommentarliste) ->
    # cache_hit=false, volle Review läuft.
    run_cache_block '[]'
    if printf '%s' "$CACHE_GITHUB_OUTPUT" | grep -qF "cache_hit=false"; then ok
    else ko "(d-MISS) erwartet cache_hit=false, bekam GITHUB_OUTPUT='$CACHE_GITHUB_OUTPUT' (stderr: $CACHE_OUT)"; fi

    # Szenario MISS (Hash-Mismatch): Sticky-Comment vorhanden, aber diffHash
    # passt nicht zum aktuellen bounded diff -> cache_hit=false.
    STALE_PAYLOAD="$(python3 -c "import json; print(json.dumps({'diffHash': 'deadbeef', 'findings': [{'severity':'P1','category':'style','title':'t','evidence':'e'}]}))")"
    STALE_COMMENTS_JSON="$(python3 -c "
import json, sys
payload = sys.argv[1]
body = '<!-- flowkit-review:v1 -->\n## flowkit PR Deep Review\n\n<!-- flowkit-review-json:v1 ' + payload + ' -->'
print(json.dumps([{'body': body}]))
" "$STALE_PAYLOAD")"
    run_cache_block "$STALE_COMMENTS_JSON"
    if printf '%s' "$CACHE_GITHUB_OUTPUT" | grep -qF "cache_hit=false"; then ok
    else ko "(d-STALE) Hash-Mismatch muss cache_hit=false ergeben, bekam GITHUB_OUTPUT='$CACHE_GITHUB_OUTPUT'"; fi
  fi
fi

echo
echo "== (e) claude-code-action-Pin (Registry) =="
# Kanonischer Soll-Pin. Zusammen mit den uses:-Zeilen im Template die
# einzigen Stellen, an denen die Version steht — zwei Stellen sind Absicht:
# ein halbfertiger Bump fällt hier auf, statt 46 Patch-Versionen lang
# unbemerkt zu bleiben (#38).
#
# BUMP-ANLEITUNG (immer BEIDE Schritte, sonst färbt CI rot):
#   1. Neuesten Tag ermitteln und auf einen Commit-SHA auflösen:
#        gh api --paginate repos/anthropics/claude-code-action/tags --jq '.[].name' \
#          | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
#        gh api repos/anthropics/claude-code-action/commits/<vX.Y.Z> --jq .sha
#      (Die GitHub-"latest release" ist der bewegliche v1-Zeiger, keine
#      Patch-Version — immer die Tag-Liste nutzen.)
#   2. ALLE FÜNF `uses: anthropics/claude-code-action@…`-Zeilen in
#      templates/ci/pr-deep-review.yml.template UND die beiden Konstanten
#      unten (EXPECTED_PIN_SHA / EXPECTED_PIN_VERSION) ersetzen — beide,
#      sonst wird genau dieser Test rot statt still zu verrotten.
#   3. Schnittstelle prüfen, bevor gemergt wird:
#        gh api "repos/anthropics/claude-code-action/contents/action.yml?ref=<vX.Y.Z>" \
#          --jq .content | base64 -d
#      Diese Datei nutzt die Inputs claude_code_oauth_token,
#      path_to_bun_executable, track_progress, prompt, claude_args sowie den
#      Output structured_output — Änderungen dort brauchen mehr als einen
#      Pin-Bump.
EXPECTED_PIN_SHA="be7b93b1907a4abad570368f3c74b6fe3807510b"
EXPECTED_PIN_VERSION="v1.0.183"
EXPECTED_PIN_LINE="- uses: anthropics/claude-code-action@${EXPECTED_PIN_SHA} # ${EXPECTED_PIN_VERSION}"

# Erste Prüfung: nur echte SHA-Pins zählen (40-stelliges Hex direkt nach dem
# @). Ein Wartungs-Kommentar, der das WORT "claude-code-action" nennt, aber
# keinen SHA dahinter hat, kann dieses Muster nicht treffen — ein früherer
# Entwurf dieses Tests grep'te ohne SHA-Anforderung und wurde dadurch selbst
# nach einem korrekten Bump dauerhaft rot (#38-Kritik).
pin_hits="$(grep -nE 'anthropics/claude-code-action@[0-9a-f]{40}' "$TEMPLATE" || true)"
if [ -z "$pin_hits" ]; then
  ko "(e) keine einzige SHA-gepinnte 'anthropics/claude-code-action@'-Zeile im Template gefunden — die Prüfung wäre gegenstandslos (umbenannt? entfernt?)"
else
  # WICHTIG: heredoc statt Pipe — in einer Pipe liefe die Schleife in einer
  # Subshell und pass/fail gingen verloren.
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    pin_lineno="${hit%%:*}"
    pin_text="$(printf '%s' "${hit#*:}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ "$pin_text" = "$EXPECTED_PIN_LINE" ]; then ok
    else ko "(e) Zeile $pin_lineno weicht ab: '$pin_text' != Soll '$EXPECTED_PIN_LINE'"; fi
  done <<PINS
$pin_hits
PINS
fi

# Zweite, unabhängige Prüfung: ein beweglich gepinntes Tag (@v1, @main, …)
# würde das SHA-Muster oben nie treffen und liefe deshalb unbemerkt durch,
# säße es an einer der fünf Stellen. Eigener Grep, damit (e) beide im Issue
# #38 genannten Fehlerbilder fängt — auseinanderlaufende SHA-Pins UND einen
# Rückfall auf ein bewegliches Tag — ohne wieder den Wartungs-Kommentar am
# Dateianfang mitzuerfassen (der nennt weder "@v1" noch "@main" o. Ä.).
moving_hits="$(grep -nE 'anthropics/claude-code-action@(v[0-9]|main|master|latest)' "$TEMPLATE" || true)"
if [ -n "$moving_hits" ]; then
  ko "(e) bewegliches claude-code-action-Tag gefunden (SHA-Pin gefordert): $(printf '%s' "$moving_hits" | tr '\n' ';')"
else
  ok
fi

echo
echo "== (f) Downgrade-Schutz für den claude-code-action-Pin (commands/setup.md) =="
SETUP_MD="$ROOT/commands/setup.md"
if [ ! -f "$SETUP_MD" ]; then
  ko "(f) commands/setup.md nicht gefunden: $SETUP_MD"
else
  GUARD="$WORK/action-pin-guard.sh"
  RESTORE="$WORK/action-pin-restore.sh"
  awk '/# flowkit:action-pin-guard \(Beginn\)/{f=1} f{print} f && /# flowkit:action-pin-guard \(Ende\)/{exit}' "$SETUP_MD" > "$GUARD" 2>/dev/null
  awk '/# flowkit:action-pin-restore \(Beginn\)/{f=1} f{print} f && /# flowkit:action-pin-restore \(Ende\)/{exit}' "$SETUP_MD" > "$RESTORE" 2>/dev/null

  if ! grep -q 'flowkit:action-pin-guard (Ende)' "$GUARD" 2>/dev/null; then
    ko "(f) Guard-Block (Entscheidung) in commands/setup.md nicht gefunden (Marker fehlen) — der Downgrade-Schutz ist nicht ausgeliefert"
  elif ! grep -q 'flowkit:action-pin-restore (Ende)' "$RESTORE" 2>/dev/null; then
    ko "(f) Restore-Block (Reparatur) in commands/setup.md nicht gefunden (Marker fehlen) — Teil 2 des Downgrade-Schutzes ist nicht ausgeliefert"
  else
    mk_wf() { printf '      - uses: anthropics/claude-code-action@%s # %s\n' "$2" "$3" > "$1"; }
    run_guard() {
      PIN_TEMPLATE="$TEMPLATE" PIN_INSTALLED="${1:-$WORK/gibt-es-nicht.yml}" bash "$GUARD" 2>/dev/null
    }
    check_guard() { # <label> <installed|""> <erwartete decision> [erwartetes keep_sha]
      local label="$1" file="$2" want="$3" want_sha="${4:-}" out got sha
      out="$(run_guard "$file")"
      got="$(printf '%s\n' "$out" | grep -m1 '^pin_decision=' | cut -d= -f2)"
      if [ "$got" != "$want" ]; then ko "(f-$label) erwartet pin_decision=$want, bekam '$got' (Ausgabe: $(printf '%s' "$out" | tr '\n' ' '))"; return; fi
      if [ -n "$want_sha" ]; then
        sha="$(printf '%s\n' "$out" | grep -m1 '^pin_keep_sha=' | cut -d= -f2)"
        if [ "$sha" != "$want_sha" ]; then ko "(f-$label) erwartet pin_keep_sha=$want_sha, bekam '$sha'"; return; fi
      fi
      ok
    }

    GUARD_NEW_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    GUARD_NEW_VER="v1.0.190"
    GUARD_OLD_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    mk_wf "$WORK/wf-neuer.yml" "$GUARD_NEW_SHA" "$GUARD_NEW_VER"
    # v1.0.9 ist NUMERISCH älter, aber LEXIKALISCH neuer als v1.0.183 — genau
    # die Falle, in die ein „im Kopf" vergleichender Agent tappt.
    mk_wf "$WORK/wf-aelter.yml" "$GUARD_OLD_SHA" "v1.0.9"
    printf '      - uses: anthropics/claude-code-action@v1\n' > "$WORK/wf-beweglich.yml"
    GUARD_TPL_VER="$(grep -m1 -oE 'anthropics/claude-code-action@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+' "$TEMPLATE" | sed -E 's/.*# //')"
    GUARD_TPL_SHA="$(grep -m1 -oE 'anthropics/claude-code-action@[0-9a-f]{40}' "$TEMPLATE" | cut -d@ -f2)"
    mk_wf "$WORK/wf-gleich.yml" "$GUARD_TPL_SHA" "$GUARD_TPL_VER"

    check_guard "keine-datei"  ""                       no-installed-pin
    check_guard "kein-sha-pin" "$WORK/wf-beweglich.yml" no-installed-pin
    check_guard "aelter"       "$WORK/wf-aelter.yml"    template
    check_guard "gleich"       "$WORK/wf-gleich.yml"    template
    check_guard "neuer"        "$WORK/wf-neuer.yml"     keep-installed "$GUARD_NEW_SHA"

    # Reparatur (Teil 2): nicht nur die ENTSCHEIDUNG prüfen, sondern dass der
    # Rückschreib-sed die installierte Datei tatsächlich auf den "neuer"-Pin
    # zurücksetzt — genau das Schutzziel, das eine reine Entscheidungsprüfung
    # nicht abdeckt (#38-Kritik: "prüft nur die Entscheidung, nie die
    # Reparatur"). RESTORE_TARGET startet als Kopie des TEMPLATE, simuliert
    # also die Datei direkt NACH dem Kopieren in Schritt 6, bevor Teil 2 sie
    # zurückschreibt.
    RESTORE_TARGET="$WORK/wf-restore-target.yml"
    cp "$TEMPLATE" "$RESTORE_TARGET"
    restore_out="$(PIN_KEEP_SHA="$GUARD_NEW_SHA" PIN_KEEP_VER="$GUARD_NEW_VER" PIN_INSTALLED="$RESTORE_TARGET" bash "$RESTORE" 2>&1)"
    restore_rc=$?
    if [ "$restore_rc" != "0" ]; then
      ko "(f-reparatur) Restore-Block brach ab (rc=$restore_rc): $restore_out"
    else
      restored_lines="$(grep -cF "anthropics/claude-code-action@${GUARD_NEW_SHA} # ${GUARD_NEW_VER}" "$RESTORE_TARGET" || true)"
      stale_lines="$(grep -cF "anthropics/claude-code-action@${EXPECTED_PIN_SHA}" "$RESTORE_TARGET" || true)"
      if [ "${restored_lines:-0}" -eq 5 ] && [ "${stale_lines:-0}" -eq 0 ]; then ok
      else ko "(f-reparatur) erwartet alle 5 Pin-Zeilen auf ${GUARD_NEW_VER}/${GUARD_NEW_SHA} umgeschrieben, gefunden: restored=$restored_lines stale=$stale_lines"; fi
    fi
  fi
fi

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
