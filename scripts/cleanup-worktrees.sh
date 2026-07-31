#!/usr/bin/env bash
# cleanup-worktrees.sh — deterministisches Worktree-Cleanup für flowkit.
#
# Hintergrund (Erstlauf-Befund 2026-07-31): ein LLM-Cleanup-Agent hat per
# `git worktree remove --force` Worktrees LAUFENDER fremder Einheiten entfernt.
# Die Auswahl, WAS entfernt werden darf, ist rein mechanisch — sie gehört in
# ein Script, nicht in Prompt-Disziplin. Dieses Script entfernt ausschließlich
# Worktrees, deren ausgecheckter Branch eindeutig zum angegebenen Issue bzw.
# exakt zum angegebenen Branch gehört. Haupt-Tree und detached Worktrees werden
# nie angefasst. Branch-Löschung macht es bewusst NICHT (dafür braucht es
# gh-Kontext: offener PR ja/nein — das bleibt beim aufrufenden Agenten).
#
# Aufruf:
#   cleanup-worktrees.sh --issue <N>       Worktrees entfernen, deren Branch die
#                                          Issue-Nummer N als eigenes, durch
#                                          Nicht-Ziffern begrenztes Segment trägt
#                                          (feat/450-x ja, feat/4501-x nein)
#   cleanup-worktrees.sh --branch <NAME>   Worktrees mit exakt diesem Branch
#
# Exit 0 auch, wenn nichts zu entfernen war ("nichts übrig" ist ein korrektes
# Ergebnis). Exit != 0 nur bei Fehlbedienung oder git-Fehlern.
set -euo pipefail

usage() {
  echo "usage: $0 --issue <N> | --branch <NAME>" >&2
  exit 2
}

MODE="${1:-}"
ARG="${2:-}"
[ -n "$MODE" ] && [ -n "$ARG" ] || usage
case "$MODE" in
  --issue)
    case "$ARG" in (''|*[!0-9]*) echo "FEHLER: --issue erwartet eine Zahl, bekam: $ARG" >&2; exit 2;; esac
    ;;
  --branch) ;;
  *) usage ;;
esac

# `git worktree list --porcelain`: Blöcke pro Worktree, getrennt durch Leerzeile.
# Der ERSTE Block ist laut git-Doku immer der Haupt-Worktree — nie anfassen.
removed=0
main_seen=0
wt_path=""
wt_branch=""

flush() {
  [ -n "$wt_path" ] || return 0
  if [ "$main_seen" -eq 0 ]; then
    main_seen=1
    return 0
  fi
  # Detached (kein Branch) → nie anfassen.
  [ -n "$wt_branch" ] || return 0
  local match=0
  if [ "$MODE" = "--branch" ]; then
    [ "$wt_branch" = "$ARG" ] && match=1
  else
    # Issue-Nummer als eigenes Segment: links wie rechts keine weitere Ziffer.
    if printf '%s' "$wt_branch" | grep -Eq "(^|[^0-9])${ARG}([^0-9]|\$)"; then
      match=1
    fi
  fi
  if [ "$match" -eq 1 ]; then
    git worktree remove --force "$wt_path"
    echo "entfernt: $wt_path (Branch $wt_branch)"
    removed=$((removed + 1))
  fi
}

while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      flush
      wt_path="${line#worktree }"
      wt_branch=""
      ;;
    "branch refs/heads/"*)
      wt_branch="${line#branch refs/heads/}"
      ;;
  esac
done < <(git worktree list --porcelain)
flush

if [ "$removed" -eq 0 ]; then
  echo "nichts zu entfernen (korrektes Ergebnis, wenn kein Worktree zum Kriterium passt)"
fi
