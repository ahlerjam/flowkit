#!/usr/bin/env bash
# flowkit SessionStart hook: dynamic context only (no doc duplication).
set -u
PROJ="${CLAUDE_PROJECT_DIR:-.}"
NAME="$(basename "$PROJ")"
BRANCH="$(git -C "$PROJ" branch --show-current 2>/dev/null || echo '?')"
DIRTY="$(git -C "$PROJ" status --porcelain 2>/dev/null | grep -c . || true)"
echo "[$NAME] branch=${BRANCH} dirty-files=${DIRTY}"
