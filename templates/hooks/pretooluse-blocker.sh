#!/usr/bin/env bash
# flowkit PreToolUse blocker — single source of truth for the dangerous-pattern regex.
# Installed per repo by /flowkit:setup; placeholders are substituted at install time.
set -u
PROTECTED_BRANCHES='{{PROTECTED_BRANCHES}}'   # e.g. main|master
OVERRIDE_LABEL='{{OVERRIDE_LABEL}}'           # e.g. override-claude-review
PREFIX='[flowkit-hook]'

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null) \
  || { echo "$PREFIX jq parse error - blocking as precaution" >&2; exit 2; }
[ -n "$cmd" ] || exit 0

# POSIX-portable ([[:space:]] not \s) so BSD grep (macOS) and GNU grep behave identically.
B="($PROTECTED_BRANCHES)"
REGEX="rm[[:space:]]+-rf[[:space:]]+/|chmod[[:space:]]+777|>[[:space:]]*\.env([[:space:]]|$)"
REGEX="$REGEX|git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]([^|;&]*[[:space:]])?push[^|;&]*([[:space:]]--force([[:space:]]|$|=)|[[:space:]]-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|[[:space:]]--force-with-lease|[[:space:]]--mirror|[[:space:]](--delete|-[a-zA-Z]*d[a-zA-Z]*)[[:space:]][^|;&]*${B}([^A-Za-z0-9_/:-]|$)|[[:space:]]:[^|;&]*${B}([^A-Za-z0-9_/:-]|$)|[[:space:]]\+[^|;&]*${B}([^A-Za-z0-9_/:-]|$))"
REGEX="$REGEX|git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]([^|;&]*[[:space:]])?push[^|;&]*([[:space:]]|:)${B}[[:space:]]([^|;&]*[[:space:]])?(--delete|-[a-zA-Z]*d[a-zA-Z]*)([[:space:]]|$)"
REGEX="$REGEX|git[^|;&]*commit[^|;&]*--no-verify"
REGEX="$REGEX|gh[^|;&]*--admin"
REGEX="$REGEX|gh[[:space:]]+api[^|;&]*(-X|--method)[[:space:]]*=?[[:space:]]*(DELETE|PATCH|POST|PUT)"
REGEX="$REGEX|gh[[:space:]]+api[^|;&]*[[:space:]](-[fF]|--field|--raw-field|--input)([[:space:]=]|$)|gh[[:space:]]+api[^|;&]*[[:space:]]-[fF][^|;&[:space:]]"
REGEX="$REGEX|gh[[:space:]]+(pr|issue)[[:space:]]+edit[^|;&]*--add-label[^A-Za-z0-9]+${OVERRIDE_LABEL}"
# Generalisierte Secret-Erkennung (Quelle hatte nur HCLOUD_TOKEN — quelle-hooks-settings.md §4.4
# fordert Generalisierung, nicht Entfernung): Inline-Zuweisung eines Secret-artigen Werts.
REGEX="$REGEX|[A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Za-z_]*=[^[:space:]]{16,}"

printf '%s' "$cmd" | grep -iqE "$REGEX" \
  && { echo "$PREFIX blocked dangerous pattern (protected branches: $PROTECTED_BRANCHES). See AGENTS.md." >&2; exit 2; } \
  || exit 0
