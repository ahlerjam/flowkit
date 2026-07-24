#!/usr/bin/env bash
# flowkit pushci guard: if the repo has a local-CI push alias configured, insist on it.
set -u
PREFIX='[flowkit-hook]'
cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0
printf '%s' "$cmd" | grep -qE 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+([^|;&]*[[:space:]])?push([[:space:]]|$)' || exit 0
printf '%s' "$cmd" | grep -qE 'pushci' && exit 0
if git -C "${CLAUDE_PROJECT_DIR:-.}" config alias.pushci >/dev/null 2>&1; then
  echo "$PREFIX Plain 'git push' detected, but the pushci alias is set on this machine." >&2
  echo "$PREFIX Use 'git pushci' so the local CI gate runs." >&2
  exit 2
fi
exit 0
