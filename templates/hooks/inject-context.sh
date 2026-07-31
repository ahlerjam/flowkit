#!/usr/bin/env bash
# flowkit SessionStart hook: dynamic context only (no doc duplication).
#
# Basis-Ausgabe: [repo] branch=X dirty-files=N
# Zusatz (best effort): liegengebliebene flowkit-Arbeit — offene Issues mit
# Label budget-exceeded oder needs-human, je Treffer mit zugehörigem offenem
# PR (Body-Match "Closes #N"), plus einmalig der passende resume-Hinweis.
#
# Harte Regeln: SessionStart darf NIE blocken und NIE einen Fehler ausgeben.
# Jeder Fehlerpfad (kein gh, keine Auth, kein Netz, kein Repo-Slug, Timeout)
# degradiert lautlos auf die Basis-Ausgabe; exit 0 immer.
set -u
PROJ="${CLAUDE_PROJECT_DIR:-.}"
NAME="$(basename "$PROJ")"
BRANCH="$(git -C "$PROJ" branch --show-current 2>/dev/null || echo '?')"
DIRTY="$(git -C "$PROJ" status --porcelain 2>/dev/null | grep -c . || true)"
echo "[$NAME] branch=${BRANCH} dirty-files=${DIRTY}"

# --- Gestrandete flowkit-Arbeit -------------------------------------------
# Kostenbudget: HÖCHSTENS zwei gh-Aufrufe, zusammen ~2s.
# Entscheidung "ein Aufruf + lokaler Filter" statt zwei Label-Listen:
# `--label a --label b` ist UND-verknüpft (liefert also NICHT a ODER b),
# und zwei getrennte `gh issue list --label ...`-Aufrufe würden das ganze
# Zeitbudget allein für Issues verbrauchen. Daher EIN ungelabelter
# `gh issue list --json ... --jq ...` mit ODER-Filter lokal (gh bringt gojq
# mit — kein separates jq nötig) und der zweite Aufruf bleibt für die PRs.
# Grenze: --limit 100; bei >100 offenen Issues können Treffer fehlen (ok).
stranded_work() {
  command -v gh >/dev/null 2>&1 || return 0
  # Timeout wo verfügbar: macOS hat KEIN `timeout`; coreutils liefert dort
  # `gtimeout`. Fehlt beides: ohne Timeout, aber weiterhin fail-silent.
  TMO=""
  if command -v timeout >/dev/null 2>&1; then TMO="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then TMO="gtimeout"; fi
  gh_call() {
    if [ -n "$TMO" ]; then "$TMO" 2 gh "$@" 2>/dev/null
    else gh "$@" 2>/dev/null; fi
  }
  # gh leitet den Repo-Slug aus dem Remote im Arbeitsverzeichnis ab.
  cd "$PROJ" 2>/dev/null || return 0

  # Aufruf 1/2: offene Issues, lokal auf budget-exceeded ODER needs-human
  # gefiltert; Ausgabe als TSV: nummer<TAB>labels<TAB>titel
  ISSUES="$(gh_call issue list --state open --limit 100 --json number,title,labels \
    --jq '.[] | [.labels[].name] as $l
      | select(any($l[]; . == "budget-exceeded" or . == "needs-human"))
      | [(.number|tostring),
         ($l | map(select(. == "budget-exceeded" or . == "needs-human")) | join("+")),
         .title] | @tsv')" || return 0
  [ -n "$ISSUES" ] || return 0

  # Aufruf 2/2: offene PRs als TSV (nummer<TAB>isDraft<TAB>titel+body in einer
  # Zeile) — nur nötig, wenn es überhaupt Treffer gibt. Schlägt er fehl,
  # listen wir die Issues trotzdem (dann ohne PR-Angabe).
  PRS="$(gh_call pr list --state open --limit 100 --json number,title,body,isDraft \
    --jq '.[] | [(.number|tostring), (.isDraft|tostring),
      ((.title + " " + (.body // "")) | gsub("[\\r\\n\\t]"; " "))] | @tsv')" || PRS=""

  TAB="$(printf '\t')"
  found_budget=0
  while IFS="$TAB" read -r inum ilabels ititle; do
    [ -n "$inum" ] || continue
    case "$ilabels" in *budget-exceeded*) found_budget=1 ;; esac
    # Zugehörigen PR lokal matchen: "Closes #N" (auch close/closed) im
    # PR-Text, mit Wortgrenze, damit #12 nicht #123 trifft.
    prinfo=""
    prline="$(printf '%s\n' "$PRS" | grep -iE "close[sd]?[[:space:]]+#${inum}([^0-9]|\$)" | head -n 1 || true)"
    if [ -n "$prline" ]; then
      prnum="${prline%%"$TAB"*}"
      rest="${prline#*"$TAB"}"
      prdraft="${rest%%"$TAB"*}"
      if [ "$prdraft" = "true" ]; then prinfo=", PR #${prnum} draft"
      else prinfo=", PR #${prnum}"; fi
    fi
    # Titel kompakt halten (eine Zeile pro Issue)
    if [ "${#ititle}" -gt 60 ]; then ititle="${ititle:0:57}..."; fi
    echo "[flowkit] gestrandet: #${inum} (${ilabels}${prinfo}) ${ititle}"
  done <<EOF
$ISSUES
EOF
  # Einmaliger resume-Hinweis: `resume` deckt budget-exceeded ab; sind NUR
  # needs-human-Treffer da, braucht es `resume all` (vgl. skills/implement).
  if [ "$found_budget" = 1 ]; then
    echo "[flowkit] -> /flowkit:implement resume"
  else
    echo "[flowkit] -> /flowkit:implement resume all"
  fi
}
# Subshell + doppelte Absicherung: kein Fehlertext, kein Nicht-Null-Exit.
( stranded_work ) 2>/dev/null || true
exit 0
