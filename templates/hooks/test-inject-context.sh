#!/usr/bin/env bash
# flowkit inject-context Tests. Zwei Modi:
#   kein Argument     — run from the plugin root against the TEMPLATE
#                       (templates/hooks/inject-context.sh; keine Platzhalter,
#                       daher keine Substitution nötig).
#   $1 = path to script — run against an ALREADY INSTALLED hook
#                       (z. B. .claude/hooks/inject-context.sh im Zielrepo).
# Usage: test-inject-context.sh [path-to-installed-script]
#
# Testfälle:
#   (a) ohne gh im PATH            → exakt die Basis-Ausgabe, exit 0
#   (b) gh-Stub mit festem JSON    → gestrandet-Zeilen inkl. PR-Zuordnung
#                                    und resume-Hinweis
#   (c) gh-Stub, der hängt         → Hook kehrt in <5s zurück (nur wenn
#                                    timeout/gtimeout verfügbar, sonst Skip)
#   (d) Issue ohne offenen PR      → wird trotzdem gelistet, ohne PR-Angabe
#   (e) nur needs-human-Treffer    → Hinweis lautet `resume all`
#   (f) Versionen gleich           → keine Drift-Zeile
#   (g) Versionen ungleich         → genau eine Drift-Zeile mit beiden Versionen
#   (h) Stempel-Datei fehlt bzw. CLAUDE_PLUGIN_ROOT ungesetzt → keine
#                                    Drift-Zeile, keine Fehler
set -u
SCRIPT_ARG="${1:-}"
if [ -n "$SCRIPT_ARG" ]; then
  HOOK="$(cd "$(dirname "$SCRIPT_ARG")" && pwd)/$(basename "$SCRIPT_ARG")"
else
  HOOK="$(pwd)/templates/hooks/inject-context.sh"
fi
[ -f "$HOOK" ] || { echo "FAIL: Hook nicht gefunden: $HOOK"; exit 1; }

pass=0; fail=0
ok() { pass=$((pass+1)); }
ko() { echo "FAIL: $1"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Test-Repo: deterministischer Branch, keine Commits nötig, nichts dirty.
REPO="$WORK/repo"
git init -q "$REPO"
git -C "$REPO" symbolic-ref HEAD refs/heads/main
BASE="[repo] branch=main dirty-files=0"

# --- (a) ohne gh im PATH: exakt Basis-Ausgabe, exit 0 ---------------------
# Minimal-PATH nur mit den Tools, die der Hook wirklich braucht — gh fehlt.
MINBIN="$WORK/bin-min"
mkdir -p "$MINBIN"
for t in bash git grep basename head; do
  p="$(command -v "$t" 2>/dev/null || true)"
  [ -n "$p" ] && ln -s "$p" "$MINBIN/$t"
done
OUT="$(env PATH="$MINBIN" CLAUDE_PROJECT_DIR="$REPO" bash "$HOOK" </dev/null 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = "$BASE" ]; then ok
else ko "(a) ohne gh: erwartet exakt '$BASE' + exit 0, bekam rc=$RC: '$OUT'"; fi

# --- Stub-Vorbereitung für (b)/(d)/(e) ------------------------------------
# gh-Stub liefert festes JSON aus Fixture-Dateien; das --jq-Flag des echten
# gh (eingebettetes gojq) wird über das System-jq emuliert.
JQ_BIN="$(command -v jq 2>/dev/null || true)"
STUB="$WORK/bin-stub"
mkdir -p "$STUB"
cat > "$STUB/gh" <<'EOSTUB'
#!/usr/bin/env bash
# gh-Stub: `gh issue list`/`gh pr list` → festes JSON, --jq via echtem jq.
set -u
jqprog=""; prev=""
for a in "$@"; do
  [ "$prev" = "--jq" ] && jqprog="$a"
  prev="$a"
done
case "${1:-}" in
  issue) f="$GH_STUB_FIX/issues.json" ;;
  pr)    f="$GH_STUB_FIX/prs.json" ;;
  *)     exit 1 ;;
esac
if [ -n "$jqprog" ]; then "$GH_STUB_JQ" -r "$jqprog" < "$f"; else cat "$f"; fi
EOSTUB
chmod +x "$STUB/gh"

FIX1="$WORK/fix1"; mkdir -p "$FIX1"
cat > "$FIX1/issues.json" <<'EOF'
[
  {"number": 12, "title": "Implement feature X", "labels": [{"name": "budget-exceeded"}, {"name": "size-M"}]},
  {"number": 13, "title": "Fix flaky auth test", "labels": [{"name": "needs-human"}]},
  {"number": 14, "title": "Unrelated enhancement", "labels": [{"name": "enhancement"}]}
]
EOF
cat > "$FIX1/prs.json" <<'EOF'
[
  {"number": 34, "title": "feat: feature X", "body": "Erster Wurf.\n\nCloses #12", "isDraft": true},
  {"number": 35, "title": "chore: other", "body": "Closes #123", "isDraft": false},
  {"number": 36, "title": "fix: misc", "body": "Closes #99", "isDraft": false}
]
EOF

if [ -z "$JQ_BIN" ]; then
  echo "SKIP (b)/(d)/(e): jq nicht verfügbar — der Stub kann gh --jq nicht emulieren"
else
  OUT="$(env PATH="$STUB:$PATH" GH_STUB_FIX="$FIX1" GH_STUB_JQ="$JQ_BIN" \
    CLAUDE_PROJECT_DIR="$REPO" bash "$HOOK" </dev/null 2>&1)"; RC=$?

  # (b) Basis-Zeile bleibt die erste Zeile, exit 0
  if [ "$RC" -eq 0 ] && [ "$(printf '%s\n' "$OUT" | head -n 1)" = "$BASE" ]; then ok
  else ko "(b) Basis-Zeile/exit: rc=$RC: '$OUT'"; fi
  # (b) budget-exceeded-Issue mit zugeordnetem Draft-PR
  if printf '%s\n' "$OUT" | grep -qF "[flowkit] gestrandet: #12 (budget-exceeded, PR #34 draft) Implement feature X"; then ok
  else ko "(b) Zeile für #12 mit PR #34 draft fehlt: '$OUT'"; fi
  # (b) Wortgrenze: "Closes #123" darf #12 nicht zugeordnet werden
  if printf '%s\n' "$OUT" | grep -q "#12 .*PR #35"; then ko "(b) #12 fälschlich PR #35 (Closes #123) zugeordnet"
  else ok; fi
  # (b) Issue ohne Stranded-Label taucht nicht auf
  if printf '%s\n' "$OUT" | grep -q "#14"; then ko "(b) ungelabeltes Issue #14 gelistet: '$OUT'"
  else ok; fi
  # (b) resume-Hinweis genau einmal; budget-exceeded vorhanden → `resume`
  if [ "$(printf '%s\n' "$OUT" | grep -c '^\[flowkit\] -> /flowkit:implement resume$')" = "1" ]; then ok
  else ko "(b) resume-Hinweis fehlt oder mehrfach: '$OUT'"; fi
  # (d) Issue ohne offenen PR wird trotzdem gelistet, ohne PR-Angabe
  if printf '%s\n' "$OUT" | grep -qF "[flowkit] gestrandet: #13 (needs-human) Fix flaky auth test"; then ok
  else ko "(d) Zeile für #13 ohne PR-Angabe fehlt: '$OUT'"; fi

  # (e) nur needs-human-Treffer → Hinweis `resume all`
  FIX2="$WORK/fix2"; mkdir -p "$FIX2"
  cat > "$FIX2/issues.json" <<'EOF'
[
  {"number": 21, "title": "Needs a decision", "labels": [{"name": "needs-human"}]}
]
EOF
  printf '[]\n' > "$FIX2/prs.json"
  OUT="$(env PATH="$STUB:$PATH" GH_STUB_FIX="$FIX2" GH_STUB_JQ="$JQ_BIN" \
    CLAUDE_PROJECT_DIR="$REPO" bash "$HOOK" </dev/null 2>&1)"; RC=$?
  if [ "$RC" -eq 0 ] \
    && printf '%s\n' "$OUT" | grep -qF "[flowkit] gestrandet: #21 (needs-human) Needs a decision" \
    && printf '%s\n' "$OUT" | grep -q '^\[flowkit\] -> /flowkit:implement resume all$'; then ok
  else ko "(e) nur needs-human: erwartet 'resume all', bekam rc=$RC: '$OUT'"; fi
fi

# --- Fixtures für Template-Versions-Drift (f)/(g)/(h) ---------------------
# Eigener Minimal-PATH: bash/git/grep/basename/head/sed/tr sind Pflicht (der
# Fallback-Pfad des Hooks braucht sed/grep, falls jq fehlt); gh bleibt
# ABWESEND, damit stranded_work sofort abbricht und die Ausgabe für den
# Drift-Vergleich sauber bleibt. jq nur mit rein, wenn auf dem Testsystem
# vorhanden (deckt dann den bevorzugten jq-Pfad statt des Fallbacks ab).
MINBIN2="$WORK/bin-min2"
mkdir -p "$MINBIN2"
for t in bash git grep basename head sed tr; do
  p="$(command -v "$t" 2>/dev/null || true)"
  [ -n "$p" ] && ln -s "$p" "$MINBIN2/$t"
done
[ -n "$JQ_BIN" ] && ln -s "$JQ_BIN" "$MINBIN2/jq"

FAKE_PLUGIN="$WORK/fake-plugin"
mkdir -p "$FAKE_PLUGIN/.claude-plugin"
write_plugin_json() {
  printf '{"name": "flowkit", "version": "%s"}\n' "$1" > "$FAKE_PLUGIN/.claude-plugin/plugin.json"
}
mkdir -p "$REPO/.claude"
# Sobald .claude/flowkit-version im Test-Repo liegt, meldet git eine
# zusätzliche untracked-Zeile (die leere .claude/-Verzeichnis-Anlage allein
# zählt nicht) — dafür die Basis-Ausgabe mit dirty-files=1 als Vergleich.
BASE_DIRTY1="[repo] branch=main dirty-files=1"

# --- (f) Versionen gleich → keine Drift-Zeile -----------------------------
printf '0.6.0\n' > "$REPO/.claude/flowkit-version"
write_plugin_json "0.6.0"
OUT="$(env PATH="$MINBIN2" CLAUDE_PROJECT_DIR="$REPO" CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN" bash "$HOOK" </dev/null 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = "$BASE_DIRTY1" ]; then ok
else ko "(f) gleiche Versionen: erwartet Basis-Ausgabe ohne Drift-Zeile, bekam rc=$RC: '$OUT'"; fi

# --- (g) Versionen ungleich → genau eine Drift-Zeile mit beiden Versionen -
printf '0.2.1\n' > "$REPO/.claude/flowkit-version"
write_plugin_json "0.6.0"
OUT="$(env PATH="$MINBIN2" CLAUDE_PROJECT_DIR="$REPO" CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN" bash "$HOOK" </dev/null 2>&1)"; RC=$?
DRIFTLINES="$(printf '%s\n' "$OUT" | grep -c '^\[flowkit\] Templates veraltet:')"
if [ "$RC" -eq 0 ] && [ "$DRIFTLINES" = "1" ] \
  && printf '%s\n' "$OUT" | grep -qF "[flowkit] Templates veraltet: installiert 0.2.1, Plugin 0.6.0 -> /flowkit:setup ausführen"; then ok
else ko "(g) ungleiche Versionen: erwartet genau eine Drift-Zeile, bekam rc=$RC: '$OUT'"; fi

# --- (h) Stempel-Datei fehlt bzw. CLAUDE_PLUGIN_ROOT ungesetzt ------------
rm -f "$REPO/.claude/flowkit-version"
OUT="$(env PATH="$MINBIN2" CLAUDE_PROJECT_DIR="$REPO" CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN" bash "$HOOK" </dev/null 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = "$BASE" ]; then ok
else ko "(h1) fehlende Stempel-Datei: erwartet Basis-Ausgabe, bekam rc=$RC: '$OUT'"; fi

printf '0.2.1\n' > "$REPO/.claude/flowkit-version"
OUT="$(env PATH="$MINBIN2" CLAUDE_PROJECT_DIR="$REPO" CLAUDE_PLUGIN_ROOT="" bash "$HOOK" </dev/null 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = "$BASE_DIRTY1" ]; then ok
else ko "(h2) CLAUDE_PLUGIN_ROOT ungesetzt: erwartet Basis-Ausgabe, bekam rc=$RC: '$OUT'"; fi
rm -f "$REPO/.claude/flowkit-version"

# --- (c) hängender gh-Stub: Hook kehrt in <5s zurück ----------------------
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  HANG="$WORK/bin-hang"
  mkdir -p "$HANG"
  SLEEP_BIN="$(command -v sleep)"
  # WICHTIG: exec, damit der gh-Prozess selbst der sleep ist — nur so killt
  # `timeout` ihn direkt; ein überlebendes sleep-Kind würde die stdout-Pipe
  # offen halten und die Command-Substitution im Hook doch 10s blockieren.
  printf '#!/usr/bin/env bash\nexec "%s" 10\n' "$SLEEP_BIN" > "$HANG/gh"
  chmod +x "$HANG/gh"
  t0="$(date +%s)"
  OUT="$(env PATH="$HANG:$PATH" CLAUDE_PROJECT_DIR="$REPO" bash "$HOOK" </dev/null 2>&1)"; RC=$?
  t1="$(date +%s)"
  el=$((t1 - t0))
  if [ "$RC" -eq 0 ] && [ "$el" -lt 5 ] && [ "$OUT" = "$BASE" ]; then ok
  else ko "(c) hängender gh: rc=$RC dauer=${el}s ausgabe='$OUT' (erwartet Basis in <5s)"; fi
else
  echo "SKIP (c): weder timeout noch gtimeout verfügbar — Timeout-Testfall übersprungen"
fi

echo "pass=$pass fail=$fail"
rm -rf "$WORK"
trap - EXIT
[ "$fail" -eq 0 ]
