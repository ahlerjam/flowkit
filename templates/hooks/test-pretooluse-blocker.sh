#!/usr/bin/env bash
# flowkit blocker regex tests. Two modes:
#   no argument       — run from the plugin root against the TEMPLATE, with test
#                       values substituted for the {{...}} placeholders.
#   $1 = path to script — run against an ALREADY INSTALLED hook (real values
#                       already substituted at setup-time, e.g. .claude/hooks/pretooluse-blocker.sh
#                       in the target repo); used as-is, no substitution.
# Usage: test-pretooluse-blocker.sh [path-to-installed-script]
set -u
SCRIPT_ARG="${1:-}"
TMP=$(mktemp)
if [ -n "$SCRIPT_ARG" ]; then
  cp "$SCRIPT_ARG" "$TMP"
else
  sed -e 's/{{PROTECTED_BRANCHES}}/main|master/' -e 's/{{OVERRIDE_LABEL}}/override-claude-review/' \
    templates/hooks/pretooluse-blocker.sh > "$TMP"
fi
pass=0; fail=0
run() {
  printf '{"tool_input":{"command":%s}}' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")" \
    | bash "$TMP" >/dev/null 2>&1
}
# BLOCKED_CMDS protokolliert jede must_block-Eingabe für die Vollständigkeitsprobe
# am Dateiende (dort wird geprüft, ob jedes Regex-Schlüsselwort einen Fall hat).
BLOCKED_CMDS=""
must_block() { BLOCKED_CMDS="$BLOCKED_CMDS$1"$'\n'; if run "$1"; then echo "FAIL (durchgelassen): $1"; fail=$((fail+1)); else pass=$((pass+1)); fi; }
must_allow() { if run "$1"; then pass=$((pass+1)); else echo "FAIL (geblockt): $1"; fail=$((fail+1)); fi; }
# Force/Destruktiv-Push auf geschützte Branches
must_block 'git push --force origin main'
must_block 'git push -f origin feature'
must_block 'git push origin --delete main'
must_block 'git push origin :master'
# no-verify / gh-admin / gh-api-Mutationen / Override-Label
must_block 'git commit --no-verify -m x'
must_block 'gh api -X DELETE repos/o/r/issues/1'
must_block 'gh api repos/o/r --method PATCH'
must_block 'gh pr edit 5 --add-label override-claude-review'
# Systemzerstörung + Secrets. Die Bezeichner sind bewusst generisch (MY_<KEYWORD>) —
# ein Anbietername liest sich hier wie eine anbieterspezifische Regel, die Regex ist
# aber allgemein. Je Schlüsselwort der Secret-Alternation genau ein Fall; die
# Vollständigkeitsprobe am Dateiende hält Fälle und Regex synchron.
must_block 'rm -rf /'
must_block 'chmod 777 /etc'
must_block 'export MY_TOKEN=abcdefghij1234567890'
must_block 'export MY_SECRET=abcdefghij1234567890'
must_block 'export MY_PASSWORD=abcdefghij1234567890'
must_block 'MY_API_KEY=abcdefghij1234567890 ./deploy.sh'
must_block 'MY_APIKEY=abcdefghij1234567890 ./deploy.sh'
# Legitimes darf NICHT blocken
must_allow 'git push origin feature-branch'
must_allow 'git push origin --delete stale-feature'
must_allow 'git push origin --delete main-backup'
must_allow 'git push origin main'
must_allow 'git commit -m "no verify later"'
must_allow 'gh api repos/o/r/issues --jq length'
must_allow 'gh pr edit 5 --add-label bug'
must_allow 'echo TOKEN=short'
# Vollständigkeitsprobe: JEDES Schlüsselwort der Secret-Alternation des GETESTETEN
# Hooks muss oben einen must_block-Fall `MY_<KEYWORD>=<langer Wert>` haben. Nur im
# Template-Modus (kein $1): sie hält die Plugin-Testfälle mit der Plugin-Regex
# synchron, soll aber eine repo-eigene Härtung eines bereits installierten Hooks
# (z. B. eine zusätzliche Alternative CREDENTIAL) nicht bestrafen — diese Testfälle
# hier kennen ein solches Repo-Extra prinzipiell nicht.
if [ -z "$SCRIPT_ARG" ]; then
  ALT="$(grep -oE '\([A-Z_|]+\)\[A-Za-z_\]\*=' "$TMP" | head -n 1)"
  KEYWORDS="$(printf '%s' "$ALT" | sed -e 's/^(//' -e 's/)\[A-Za-z_\]\*=$//' | tr '|' ' ')"
  case " $KEYWORDS " in
    *" TOKEN "*) ;;
    *) echo "FAIL: Secret-Alternation im Hook nicht gefunden (gelesen: '$ALT')"; fail=$((fail+1)) ;;
  esac
  for kw in $KEYWORDS; do
    if printf '%s' "$BLOCKED_CMDS" | grep -qF "MY_${kw}="; then pass=$((pass+1))
    else echo "FAIL (kein must_block-Fall MY_${kw}=<langer Wert>): $kw"; fail=$((fail+1)); fi
  done
fi
echo "pass=$pass fail=$fail"
rm -f "$TMP"
[ "$fail" -eq 0 ]
