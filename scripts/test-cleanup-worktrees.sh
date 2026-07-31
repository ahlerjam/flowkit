#!/usr/bin/env bash
# Testet scripts/cleanup-worktrees.sh gegen ein temporäres Git-Repo mit echten
# Worktrees. Aufruf: bash scripts/test-cleanup-worktrees.sh [pfad-zum-script]
set -euo pipefail

SCRIPT="${1:-$(cd "$(dirname "$0")" && pwd)/cleanup-worktrees.sh}"
[ -f "$SCRIPT" ] || { echo "FAIL: Script nicht gefunden: $SCRIPT" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

git init -q -b main repo
cd repo
git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

git worktree add -q -b feat/450-alpha ../wt-450 >/dev/null
git worktree add -q -b feat/4501-beta ../wt-4501 >/dev/null
git worktree add -q -b fix/issue-450-gamma ../wt-450b >/dev/null
git worktree add -q -b other/123 ../wt-123 >/dev/null
git worktree add -q --detach ../wt-detached >/dev/null

fails=0
check() { # check <beschreibung> <bedingung...>
  local desc="$1"; shift
  if "$@"; then echo "ok:   $desc"; else echo "FAIL: $desc"; fails=$((fails + 1)); fi
}
has_wt() { git worktree list --porcelain | grep -qx "worktree $(cd "$1" 2>/dev/null && pwd -P)"; }

# --issue 450: trifft 450-alpha und issue-450-gamma, NICHT 4501, NICHT 123.
bash "$SCRIPT" --issue 450
check "wt-450 entfernt"            bash -c '! [ -d ../wt-450 ]'
check "wt-450b entfernt"           bash -c '! [ -d ../wt-450b ]'
check "wt-4501 unangetastet"       has_wt ../wt-4501
check "wt-123 unangetastet"        has_wt ../wt-123
check "detached unangetastet"      bash -c '[ -d ../wt-detached ]'
check "Haupt-Tree unangetastet"    bash -c '[ -d .git ]'

# --branch: exakter Match, kein Präfix-Match.
bash "$SCRIPT" --branch other/12 >/dev/null
check "kein Präfix-Match bei --branch" has_wt ../wt-123
bash "$SCRIPT" --branch other/123
check "wt-123 via --branch entfernt" bash -c '! [ -d ../wt-123 ]'

# Idempotenz / leerer Treffer → Exit 0.
check "leerer Treffer ist Erfolg"  bash "$SCRIPT" --issue 450

# Fehlbedienung → Exit != 0.
check "kaputte Issue-Nr lehnt ab"  bash -c "! bash '$SCRIPT' --issue 45x 2>/dev/null"
check "ohne Argumente lehnt ab"    bash -c "! bash '$SCRIPT' 2>/dev/null"

echo
if [ "$fails" -eq 0 ]; then echo "ALLE TESTS GRÜN"; else echo "$fails TEST(S) ROT"; exit 1; fi
