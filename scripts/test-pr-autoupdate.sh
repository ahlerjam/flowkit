#!/usr/bin/env bash
# Testet templates/ci/pr-autoupdate.yml.template lokal, ohne Netz und ohne
# echten GitHub-Actions-Lauf.
#
# EHRLICHER SCOPE: kein Actions-E2E. Nicht geprüft werden GitHub-Events, echte
# Secrets, das Verhalten von actions/checkout und die Frage, ob ein Push mit
# dem hinterlegten Credential tatsächlich neue Workflow-Läufe auslöst (das ist
# eine Eigenschaft von GitHub, keine dieses Skripts). Geprüft wird:
#
#   (a) STRUKTUR: Der Workflow bekommt für GITHUB_TOKEN bewusst nur
#       `contents: read`, pusht nie mit Gewalt und trägt im ausführbaren Block
#       keine GitHub-Ausdruckssyntax (die wäre in der Extraktion unausführbar
#       und im Runner ein Parse-Fehler).
#   (b) CONFIG-AUSWERTUNG: enabled/skipLabels/maxPrs aus
#       .claude/workflow.config.json — inklusive der jq-Falle, dass
#       `false // true` in jq `true` ergibt und ein explizites
#       `enabled: false` mit `//` still WIRKUNGSLOS wäre.
#   (c) AUSWAHL: Draft, Fork-PR, Skip-Label, Branch fehlt am Remote, Branch
#       schon aktuell, Branch vollständig in main enthalten, maxPrs-Deckel.
#   (d) UPDATE: der eigentliche Merge landet am Remote; ein Konflikt wird
#       abgebrochen, NICHT gepusht, und genau einmal gelabelt/kommentiert.
#   (e) KOLLISION: ein abgelehnter Push ist kein Fehler — hat ein anderer
#       Akteur denselben Merge schon erledigt, wird nachgegeben; sonst genau
#       EIN Wiederholungsversuch.
#
# Der Block wird WÖRTLICH aus dem Template extrahiert und ausgeführt — er kann
# also nicht wegdriften. Fremd sind nur `gh` (Stub) und das Remote (echtes
# bare-Repo, echte git-Pushes, echter pre-receive-Hook für die Ablehnung).
#
# Aufruf: bash scripts/test-pr-autoupdate.sh   (aus dem Plugin-Root)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/templates/ci/pr-autoupdate.yml.template"
[ -f "$TEMPLATE" ] || { echo "FAIL: Template nicht gefunden: $TEMPLATE"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq nicht im PATH — der Block braucht es"; exit 1; }

pass=0; fail=0
ok() { pass=$((pass+1)); }
ko() { echo "FAIL: $1"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Block wörtlich extrahieren: von der `set -euo pipefail`-Zeile unmittelbar vor
# dem Beginn-Marker bis zum Ende-Marker, dedentet um die 10 Spalten, die ein
# `run: |`-Block in diesem Template hat.
# ---------------------------------------------------------------------------
BEGIN_LINE="$(grep -nF '# flowkit:autoupdate (Beginn)' "$TEMPLATE" | cut -d: -f1)"
END_LINE="$(grep -nF '# flowkit:autoupdate (Ende)' "$TEMPLATE" | cut -d: -f1)"
if [ "$(printf '%s\n' "$BEGIN_LINE" | wc -l | tr -d ' ')" != "1" ] || [ -z "$BEGIN_LINE" ] || [ -z "$END_LINE" ]; then
  echo "FAIL: Marker '# flowkit:autoupdate (Beginn)/(Ende)' nicht eindeutig im Template"
  exit 1
fi
PREV="$(sed -n "$((BEGIN_LINE - 1))p" "$TEMPLATE" | sed 's/^ *//')"
if [ "$PREV" != "set -euo pipefail" ]; then
  ko "(a) vor dem Beginn-Marker steht kein 'set -euo pipefail' — der Block würde ungetestet ohne Fehlerabbruch laufen"
else
  ok
fi
BLOCK="$WORK/autoupdate.sh"
sed -n "$((BEGIN_LINE - 1)),${END_LINE}p" "$TEMPLATE" | cut -c11- > "$BLOCK"

echo "== (a) Struktur-Invarianten =="

if bash -n "$BLOCK" 2>"$WORK/synerr"; then ok; else ko "(a) extrahierter Block ist kein gültiges Bash: $(cat "$WORK/synerr")"; fi

# Der Block läuft im Test als reines Bash und im Runner als `run:`-Skript, in
# dem GitHub `${{ ... }}` VOR der Shell ersetzt. Beides verträgt sich nur,
# solange im Block gar keine Ausdruckssyntax steht — Eingaben kommen über env.
if grep -qF '${{' "$BLOCK"; then
  ko "(a) GitHub-Ausdruckssyntax im ausführbaren Block — Eingaben gehören über env: hinein"
else ok; fi

# Die Sicherheitszusage des Templates: GITHUB_TOKEN darf nicht schreiben. Ein
# Update mit ihm löste keine Checks aus und ließe den PR unmergebar zurück.
if grep -qE '^\s*contents:\s*read\b' "$TEMPLATE" && ! grep -qE '^\s*contents:\s*write\b' "$TEMPLATE"; then
  ok
else
  ko "(a) permissions.contents ist nicht 'read' — GITHUB_TOKEN darf hier nicht pushen können"
fi

if grep -qE 'git push[^|;&]*(--force|--force-with-lease| -f )' "$BLOCK"; then
  ko "(a) erzwungener Push im Block — verboten, der Workflow schreibt nur fast-forward-fähige Merges"
else ok; fi

if grep -qF -- '--no-verify' "$BLOCK"; then
  ko "(a) --no-verify im Block"
else ok; fi

# ---------------------------------------------------------------------------
# gh-Stub: liefert die PR-Liste aus einer Fixture und protokolliert Mutationen.
# ---------------------------------------------------------------------------
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then
  cat "$PRS_FIXTURE"
  exit 0
fi
exit 0
STUB
chmod +x "$BIN/gh"
export PATH="$BIN:$PATH"

# ---------------------------------------------------------------------------
# Fixture: bare-Remote + Klon. main und feature-Branches divergieren echt.
#   base            -> gemeinsamer Vorfahr
#   main            -> +main.txt
#   feat-behind     -> +feat.txt            (hinter main, konfliktfrei)
#   feat-conflict   -> ändert dieselbe Zeile wie main in shared.txt
#   feat-current    -> enthält main bereits
#   feat-contained  -> Vorfahr von main (nichts mehr zu mergen)
# ---------------------------------------------------------------------------
make_fixture() { # <zielverzeichnis> -> setzt BARE und CLONE
  local d="$1"
  rm -rf "$d"; mkdir -p "$d"
  BARE="$d/origin.git"; CLONE="$d/clone"
  git init -q --bare "$BARE"
  git init -q "$d/seed"
  (
    cd "$d/seed"
    git config user.email t@example.com; git config user.name t
    git checkout -q -b main
    printf 'line1\n' > shared.txt
    git add -A; git commit -qm base
    git checkout -q -b feat-behind
    printf 'x\n' > feat.txt; git add -A; git commit -qm feat
    git checkout -q -b feat-conflict main
    printf 'from-feat\n' > shared.txt; git add -A; git commit -qm "feat conflict"
    git checkout -q -b feat-contained main
    git checkout -q main
    printf 'y\n' > main.txt
    printf 'from-main\n' > shared.txt
    git add -A; git commit -qm main-moves
    git checkout -q -b feat-current main
    printf 'z\n' > cur.txt; git add -A; git commit -qm cur
    git remote add origin "$BARE"
    git push -q origin main feat-behind feat-conflict feat-current feat-contained
  ) >/dev/null 2>&1
  git clone -q "$BARE" "$CLONE"
  (cd "$CLONE" && git config user.email t@example.com && git config user.name t) >/dev/null 2>&1
}

remote_sha() { git --git-dir="$BARE" rev-parse "refs/heads/$1"; }
remote_has_main() { git --git-dir="$BARE" merge-base --is-ancestor refs/heads/main "refs/heads/$1"; }

# run_block <fixture-dir> <prs-json> [<config-json>] -> Ausgabe in $LAST_OUT,
# Exit-Code in $LAST_RC, gh-Aufrufe in $GH_LOG
run_block() {
  local d="$1" prs="$2" cfg="${3:-}"
  export GH_LOG="$d/gh.log"; : > "$GH_LOG"
  export PRS_FIXTURE="$d/prs.json"; printf '%s' "$prs" > "$PRS_FIXTURE"
  if [ -n "$cfg" ]; then
    mkdir -p "$CLONE/.claude"; printf '%s' "$cfg" > "$CLONE/.claude/workflow.config.json"
  fi
  export RUNNER_TEMP="$d/tmp"; mkdir -p "$RUNNER_TEMP"
  export GITHUB_STEP_SUMMARY="$d/summary.md"; : > "$GITHUB_STEP_SUMMARY"
  export REPO="acme/demo" DEFAULT_BRANCH="main" GH_TOKEN="stub"
  LAST_OUT="$( (cd "$CLONE" && bash "$BLOCK") 2>&1 )"
  LAST_RC=$?
}

PRS_ALL='[
  {"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[]},
  {"number":2,"headRefName":"feat-current","isDraft":false,"isCrossRepository":false,"labels":[]}
]'

echo "== (b) Config-Auswertung =="

make_fixture "$WORK/f-disabled"
before="$(remote_sha feat-behind)"
run_block "$WORK/f-disabled" "$PRS_ALL" '{"autoUpdatePrBranches":{"enabled":false}}'
if [ "$LAST_RC" = "0" ] && [ "$(remote_sha feat-behind)" = "$before" ] && printf '%s' "$LAST_OUT" | grep -q 'disabled via'; then
  ok
else
  ko "(b) enabled:false hat nicht abgeschaltet (rc=$LAST_RC): $LAST_OUT"
fi

make_fixture "$WORK/f-nocfg"
run_block "$WORK/f-nocfg" "$PRS_ALL"
if [ "$LAST_RC" = "0" ] && remote_has_main feat-behind; then ok
else ko "(b) ohne Config-Datei wurde nicht aktualisiert (rc=$LAST_RC): $LAST_OUT"; fi

make_fixture "$WORK/f-emptycfg"
run_block "$WORK/f-emptycfg" "$PRS_ALL" '{"repoSlug":"acme/demo"}'
if [ "$LAST_RC" = "0" ] && remote_has_main feat-behind; then ok
else ko "(b) Config ohne autoUpdatePrBranches-Sektion hat nicht aktualisiert: $LAST_OUT"; fi

make_fixture "$WORK/f-badcfg"
run_block "$WORK/f-badcfg" "$PRS_ALL" '{ kaputt'
if [ "$LAST_RC" = "0" ] && remote_has_main feat-behind && printf '%s' "$LAST_OUT" | grep -q 'not valid JSON'; then ok
else ko "(b) kaputte Config: erwartet Hinweis + Defaults, bekam rc=$LAST_RC: $LAST_OUT"; fi

make_fixture "$WORK/f-skip"
before="$(remote_sha feat-behind)"
run_block "$WORK/f-skip" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[{"name":"needs-human"}]}]'
if [ "$(remote_sha feat-behind)" = "$before" ]; then ok
else ko "(c) PR mit Default-Skip-Label needs-human wurde trotzdem aktualisiert"; fi

make_fixture "$WORK/f-skip2"
before="$(remote_sha feat-behind)"
run_block "$WORK/f-skip2" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[{"name":"wip"}]}]' \
  '{"autoUpdatePrBranches":{"skipLabels":["wip"]}}'
if [ "$(remote_sha feat-behind)" = "$before" ]; then ok
else ko "(b) eigene skipLabels wurden ignoriert"; fi

# merge-blocked ist BEWUSST kein Default-Skip: das ist der Zustand „grün und
# fertig, wartet auf einen Menschen" — genau der PR, der aktuell bleiben muss.
make_fixture "$WORK/f-mergeblocked"
run_block "$WORK/f-mergeblocked" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[{"name":"merge-blocked"}]}]'
if remote_has_main feat-behind; then ok
else ko "(b) merge-blocked-PR wurde übersprungen — er gehört zu den aktuell zu haltenden"; fi

make_fixture "$WORK/f-max"
before="$(remote_sha feat-behind)"
run_block "$WORK/f-max" "$PRS_ALL" '{"autoUpdatePrBranches":{"maxPrs":0}}'
if [ "$(remote_sha feat-behind)" = "$before" ] && printf '%s' "$LAST_OUT" | grep -q 'maxPrs'; then ok
else ko "(b) maxPrs-Deckel greift nicht: $LAST_OUT"; fi

echo "== (c) Auswahl =="

make_fixture "$WORK/f-draft"
before="$(remote_sha feat-behind)"
run_block "$WORK/f-draft" '[{"number":1,"headRefName":"feat-behind","isDraft":true,"isCrossRepository":false,"labels":[]}]'
if [ "$(remote_sha feat-behind)" = "$before" ]; then ok
else ko "(c) Draft-PR wurde aktualisiert"; fi

make_fixture "$WORK/f-fork"
before="$(remote_sha feat-behind)"
run_block "$WORK/f-fork" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":true,"labels":[]}]'
if [ "$(remote_sha feat-behind)" = "$before" ]; then ok
else ko "(c) Fork-PR wurde angefasst — das Credential reicht dort nicht hin"; fi

make_fixture "$WORK/f-current"
before="$(remote_sha feat-current)"
run_block "$WORK/f-current" '[{"number":2,"headRefName":"feat-current","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$(remote_sha feat-current)" = "$before" ]; then ok
else ko "(c) bereits aktueller Branch wurde unnötig neu gepusst — jeder Push kostet einen CI-Lauf"; fi

make_fixture "$WORK/f-contained"
before="$(remote_sha feat-contained)"
run_block "$WORK/f-contained" '[{"number":3,"headRefName":"feat-contained","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$(remote_sha feat-contained)" = "$before" ] && printf '%s' "$LAST_OUT" | grep -q 'fully contained'; then ok
else ko "(c) Branch, der komplett in main liegt, wurde auf main vorgespult — der PR wäre leer: $LAST_OUT"; fi

make_fixture "$WORK/f-gone"
run_block "$WORK/f-gone" '[{"number":4,"headRefName":"weg","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$LAST_RC" = "0" ] && printf '%s' "$LAST_OUT" | grep -q 'not on the remote'; then ok
else ko "(c) fehlender Remote-Branch bricht den Lauf ab statt ihn zu überspringen: $LAST_OUT"; fi

make_fixture "$WORK/f-selfmain"
before="$(remote_sha main)"
run_block "$WORK/f-selfmain" '[{"number":5,"headRefName":"main","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$(remote_sha main)" = "$before" ] && printf '%s' "$LAST_OUT" | grep -q 'malformed listing'; then ok
else ko "(c) ein PR mit head==main wurde nicht abgewehrt — der Workflow darf den Default-Branch nie beschreiben"; fi

echo "== (d) Update und Konflikt =="

make_fixture "$WORK/f-ok"
run_block "$WORK/f-ok" "$PRS_ALL"
if remote_has_main feat-behind && printf '%s' "$LAST_OUT" | grep -q 'updated=1'; then ok
else ko "(d) konfliktfreies Update kam nicht am Remote an: $LAST_OUT"; fi
if git --git-dir="$BARE" log -1 --format=%s refs/heads/feat-behind | grep -q 'flowkit auto-update'; then ok
else ko "(d) Merge-Commit trägt keine erkennbare Herkunft"; fi

make_fixture "$WORK/f-conflict"
before="$(remote_sha feat-conflict)"
run_block "$WORK/f-conflict" '[{"number":7,"headRefName":"feat-conflict","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$LAST_RC" = "0" ] && [ "$(remote_sha feat-conflict)" = "$before" ]; then ok
else ko "(d) Konflikt: es wurde gepusst oder der Job ist rot geworden (rc=$LAST_RC): $LAST_OUT"; fi
if grep -q 'add-label merge-conflict' "$GH_LOG" && grep -q '^pr comment 7' "$GH_LOG"; then ok
else ko "(d) Konflikt wurde nicht sichtbar gemacht (Label/Kommentar fehlen): $(cat "$GH_LOG")"; fi
if grep -q 'flowkit-autoupdate-conflict:v1' "$GH_LOG" && grep -q 'shared.txt' "$GH_LOG"; then ok
else ko "(d) Konflikt-Kommentar ohne Marker oder ohne Konfliktdateien"; fi
# Kein halb gemergter Zustand im Arbeitsbaum:
if [ -z "$(cd "$CLONE" && git status --porcelain)" ]; then ok
else ko "(d) Arbeitsbaum nach dem Konflikt nicht sauber — git merge --abort hat nicht gegriffen"; fi

make_fixture "$WORK/f-conflict2"
run_block "$WORK/f-conflict2" '[{"number":7,"headRefName":"feat-conflict","isDraft":false,"isCrossRepository":false,"labels":[{"name":"merge-conflict"}]}]'
if ! grep -q 'pr comment' "$GH_LOG"; then ok
else ko "(d) bereits gelabelter Konflikt wurde erneut kommentiert — jeder Merge auf main erzeugte einen neuen Kommentar"; fi

make_fixture "$WORK/f-clears"
run_block "$WORK/f-clears" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[{"name":"merge-conflict"}]}]'
if grep -q 'remove-label merge-conflict' "$GH_LOG"; then ok
else ko "(d) nach erfolgreichem Update blieb das merge-conflict-Label stehen"; fi

echo "== (e) Kollision mit einem zweiten Akteur =="

# Ein pre-receive-Hook im bare-Repo lehnt den ersten Push ab. Fall 1: der
# andere Akteur hat denselben Merge inzwischen erledigt -> nachgeben.
make_fixture "$WORK/f-yield"
(
  cd "$WORK/f-yield" && git clone -q "$BARE" scratch &&
  cd scratch && git config user.email t@example.com && git config user.name t &&
  git checkout -q feat-behind && git merge -q --no-ff -m "other actor" origin/main &&
  git push -q origin HEAD:refs/heads/feat-behind
) >/dev/null 2>&1
OTHER_SHA="$(remote_sha feat-behind)"
OLD_SHA="$(cd "$WORK/f-yield/scratch" && git rev-parse HEAD^1)"
git --git-dir="$BARE" update-ref refs/heads/feat-behind "$OLD_SHA"
# `git update-ref` im Hook läuft in der Push-Quarantäne und wäre dort
# verboten — die Quarantäne-Variablen deshalb für diesen einen Aufruf
# entfernen. Das Objekt OTHER_SHA liegt bereits im echten Objektspeicher.
cat > "$BARE/hooks/pre-receive" <<HOOK
#!/usr/bin/env bash
if [ ! -f "$BARE/rejected-once" ]; then
  : > "$BARE/rejected-once"
  env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    git --git-dir="$BARE" update-ref refs/heads/feat-behind "$OTHER_SHA"
  echo "simulierte Ablehnung" >&2
  exit 1
fi
exit 0
HOOK
chmod +x "$BARE/hooks/pre-receive"
run_block "$WORK/f-yield" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$LAST_RC" = "0" ] && printf '%s' "$LAST_OUT" | grep -q 'yielded=1' && [ "$(remote_sha feat-behind)" = "$OTHER_SHA" ]; then ok
else ko "(e) abgelehnter Push mit bereits erledigter Arbeit: erwartet Nachgeben, bekam rc=$LAST_RC: $LAST_OUT"; fi

# Fall 2: Ablehnung ohne fremde Arbeit -> genau EIN Wiederholungsversuch, der
# durchgeht.
make_fixture "$WORK/f-retry"
cat > "$BARE/hooks/pre-receive" <<HOOK
#!/usr/bin/env bash
if [ ! -f "$BARE/rejected-once" ]; then
  : > "$BARE/rejected-once"
  echo "simulierte Ablehnung" >&2
  exit 1
fi
exit 0
HOOK
chmod +x "$BARE/hooks/pre-receive"
run_block "$WORK/f-retry" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$LAST_RC" = "0" ] && remote_has_main feat-behind && printf '%s' "$LAST_OUT" | grep -q 'updated=1'; then ok
else ko "(e) einmalige Ablehnung ohne fremde Arbeit: erwartet ein Wiederholungsversuch, bekam rc=$LAST_RC: $LAST_OUT"; fi

# Fall 3: dauerhafte Ablehnung -> aufgeben, aber nicht rot werden.
make_fixture "$WORK/f-reject"
before="$(remote_sha feat-behind)"
cat > "$BARE/hooks/pre-receive" <<'HOOK'
#!/usr/bin/env bash
echo "dauerhafte Ablehnung" >&2
exit 1
HOOK
chmod +x "$BARE/hooks/pre-receive"
run_block "$WORK/f-reject" '[{"number":1,"headRefName":"feat-behind","isDraft":false,"isCrossRepository":false,"labels":[]}]'
if [ "$LAST_RC" = "0" ] && [ "$(remote_sha feat-behind)" = "$before" ] && printf '%s' "$LAST_OUT" | grep -q 'rejected twice'; then ok
else ko "(e) dauerhaft abgelehnter Push: erwartet stilles Aufgeben, bekam rc=$LAST_RC: $LAST_OUT"; fi

echo ""
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
