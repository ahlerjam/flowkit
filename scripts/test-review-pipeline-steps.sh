#!/usr/bin/env bash
# Testet die kritischen Bash-Blöcke aus templates/ci/pr-deep-review.yml.template
# lokal, komplett ohne Netzzugriff und ohne echten GitHub-Actions-Lauf.
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
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
