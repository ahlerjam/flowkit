#!/usr/bin/env bash
# flowkit blocker regex tests — run from the plugin root. Substitutes test values
# for the placeholders, then feeds hook-style JSON via stdin.
set -u
TMP=$(mktemp)
sed -e 's/{{PROTECTED_BRANCHES}}/main|master/' -e 's/{{OVERRIDE_LABEL}}/override-claude-review/' \
  templates/hooks/pretooluse-blocker.sh > "$TMP"
pass=0; fail=0
run() {
  printf '{"tool_input":{"command":%s}}' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")" \
    | bash "$TMP" >/dev/null 2>&1
}
must_block() { if run "$1"; then echo "FAIL (durchgelassen): $1"; fail=$((fail+1)); else pass=$((pass+1)); fi; }
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
# Systemzerstörung + Secrets
must_block 'rm -rf /'
must_block 'chmod 777 /etc'
must_block 'export HCLOUD_TOKEN=abcdefghij1234567890'
must_block 'MY_API_KEY=abcdefghij1234567890 ./deploy.sh'
# Legitimes darf NICHT blocken
must_allow 'git push origin feature-branch'
must_allow 'git push origin --delete stale-feature'
must_allow 'git push origin --delete main-backup'
must_allow 'git push origin main'
must_allow 'git commit -m "no verify later"'
must_allow 'gh api repos/o/r/issues --jq length'
must_allow 'gh pr edit 5 --add-label bug'
must_allow 'echo TOKEN=short'
echo "pass=$pass fail=$fail"
rm -f "$TMP"
[ "$fail" -eq 0 ]
