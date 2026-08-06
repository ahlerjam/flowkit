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

# ---------------------------------------------------------------------------
# Nachrichtentext ausklammern (Issue #44)
# ---------------------------------------------------------------------------
# Bei `git commit -m "…"` und `gh pr create --body "…"` ist der gequotete Wert
# NUTZLAST, kein auszuführendes Kommando — die Shell reicht ihn unverändert an
# das Programm weiter. Ohne diese Ausklammerung blockiert der Hook genau die
# Commits, die ÜBER seine eigenen Muster schreiben (Hook-Änderungen,
# Sicherheitsdoku, Testfixturen); im unbeaufsichtigten Lauf ist das eine
# Eigenblockade, die der Builder nicht als solche erkennt.
#
# Ausgeklammert wird nur, was die Shell garantiert nicht ausführt:
#   '…'  — innerhalb einfacher Anführungszeichen gibt es keine Expansion.
#   "…"  — nur wenn weder $ noch ` darin vorkommen; sonst würde eine
#          Kommandosubstitution mit ausgeklammert und der Block umgangen.
# Alles außerhalb des Werts (Schalter, Verkettungen mit && ; |, weitere
# Kommandos) bleibt erhalten und wird weiterhin geprüft.
MSG_FLAGS='--message|--description|--notes|--title|--body|-m|-b|-t'
scan=$(printf '%s' "$cmd" \
  | sed -E "s/(^|[[:space:]])($MSG_FLAGS)(=|[[:space:]]*)'[^']*'/\\1\\2\\3'FLOWKIT_MESSAGE_ELIDED'/g" \
  | sed -E "s/(^|[[:space:]])($MSG_FLAGS)(=|[[:space:]]*)\"[^\"\$\`]*\"/\\1\\2\\3\"FLOWKIT_MESSAGE_ELIDED\"/g")
[ -n "$scan" ] || scan="$cmd"   # sed-Ausfall darf keine Prüfung überspringen

# ---------------------------------------------------------------------------
# Regelklassen
# ---------------------------------------------------------------------------
# Eine Regel je Klasse statt einer einzigen Monster-Alternation: die
# Diagnosezeile kann so benennen, WAS gegriffen hat. Die alte Meldung nannte
# bei jedem Treffer die Branch-Liste und schickte die Fehlersuche damit in eine
# falsche Richtung (Issue #44, Punkt 2).
# POSIX-portabel ([[:space:]] statt \s), damit BSD grep (macOS) und GNU grep
# sich gleich verhalten.
B="($PROTECTED_BRANCHES)"
RULE_NAMES=(); RULE_RES=()
rule() { RULE_NAMES[${#RULE_NAMES[@]}]="$1"; RULE_RES[${#RULE_RES[@]}]="$2"; }

rule destructive-fs 'rm[[:space:]]+-rf[[:space:]]+/|chmod[[:space:]]+777|>[[:space:]]*\.env([[:space:]]|$)'

rule protected-branch-push "git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]([^|;&]*[[:space:]])?push[^|;&]*([[:space:]]--force([[:space:]]|$|=)|[[:space:]]-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|[[:space:]]--force-with-lease|[[:space:]]--mirror|[[:space:]](--delete|-[a-zA-Z]*d[a-zA-Z]*)[[:space:]][^|;&]*${B}([^A-Za-z0-9_/:-]|$)|[[:space:]]:[^|;&]*${B}([^A-Za-z0-9_/:-]|$)|[[:space:]]\+[^|;&]*${B}([^A-Za-z0-9_/:-]|$))"
rule protected-branch-push "git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]([^|;&]*[[:space:]])?push[^|;&]*([[:space:]]|:)${B}[[:space:]]([^|;&]*[[:space:]])?(--delete|-[a-zA-Z]*d[a-zA-Z]*)([[:space:]]|$)"

rule commit-no-verify 'git[^|;&]*commit[^|;&]*--no-verify'

# Externe Diff-/Merge-Programme: mergetool und difftool starten die frei
# wählbare Kommandozeile aus merge.tool / difftool.<tool>.cmd — die kann aus
# einer .git/config stammen, die der Runner nicht geschrieben hat. Zweite
# Verteidigungslinie hinter der eingegrenzten Allowlist (Issue #42); sie gilt
# auch für ein Repo, das sich `git merge*` selbst wieder breiter freigibt.
rule external-tool 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(mergetool|difftool)([^A-Za-z0-9_.-]|$)'

rule gh-admin 'gh[^|;&]*--admin'
rule gh-api-mutation 'gh[[:space:]]+api[^|;&]*(-X|--method)[[:space:]]*=?[[:space:]]*(DELETE|PATCH|POST|PUT)'
rule gh-api-field 'gh[[:space:]]+api[^|;&]*[[:space:]](-[fF]|--field|--raw-field|--input)([[:space:]=]|$)|gh[[:space:]]+api[^|;&]*[[:space:]]-[fF][^|;&[:space:]]'
rule override-label "gh[[:space:]]+(pr|issue)[[:space:]]+edit[^|;&]*--add-label[^A-Za-z0-9]+${OVERRIDE_LABEL}"

# Generalisierte, anbieterneutrale Secret-Erkennung: Inline-Zuweisung eines
# Secret-artigen Werts (>= 16 Zeichen ohne Whitespace) an einen Bezeichner, der
# eines der Schlüsselwörter der Alternation enthält. Wird die Alternation
# erweitert, verlangt test-pretooluse-blocker.sh einen passenden Testfall; die
# Schwelle selbst ist dort mit einem Wertepaar bei 15/16 Zeichen festgeschrieben.
rule secret-assignment '[A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Za-z_]*=[^[:space:]]{16,}'

# Interpreter-Escapes. Die Allow-Regeln der Permission-Ebene sind Präfix-Matches
# je Teilbefehl: ein Interpreter mit freiem Argument hebt sie als Ganzes auf
# (awk führt über BEGIN{system("…")} beliebige Befehle aus). Die Allowlist lässt
# awk deshalb nur noch wörtlich als '{print $4}' zu — diese Regeln sind die
# zweite Verteidigungslinie dahinter und gelten auch für ein Repo, das sich
# awk selbst breiter freigeschaltet hat.
rule awk-escape 'awk[^;&|]*system[[:space:]]*\('
rule awk-escape 'awk[^;&]*\|[[:space:]]*("[^"]*sh"|getline)'
# Pipe in eine Shell (curl … | sh, echo … | bash). Die Klammer vor sh deckt
# bash/dash/ksh/zsh mit ab; die rechte Abgrenzung hält shasum/shuf/sort heraus,
# lässt aber jedes Nicht-Bezeichnerzeichen als Ende gelten — `… | sh)` innerhalb
# einer Kommandosubstitution ist derselbe Angriff wie `… | sh` am Zeilenende.
rule pipe-to-shell '\|[[:space:]]*(sudo[[:space:]]+)?([^|;&[:space:]]*/)?(ba|da|k|z)?sh([^A-Za-z0-9_.-]|$)'
rule pipe-to-interpreter '(curl|wget)[^;&]*\|[[:space:]]*(sudo[[:space:]]+)?([^|;&[:space:]]*/)?(python[0-9.]*|perl|ruby|node)([^A-Za-z0-9_.-]|$)'
# Traversal aus einem freigegebenen Skriptverzeichnis heraus: die Allow-Regel
# "Bash(bash <PLUGIN_ROOT>/scripts/*)" ist ein Präfix-Match und deckt damit auch
# …/scripts/../../beliebig.sh ab. Nur die absolute Form wird geblockt — ein
# relatives `bash ../x.sh` ist ohnehin von keiner Allow-Regel gedeckt.
rule interpreter-traversal '(^|[^A-Za-z0-9_.])(sudo[[:space:]]+)?((ba|da|k|z)?sh|python[0-9.]*|perl|ruby|node)[[:space:]]+/[^|;&]*/\.\./'

for i in "${!RULE_NAMES[@]}"; do
  printf '%s' "$scan" | grep -iqE "${RULE_RES[$i]}" || continue
  name="${RULE_NAMES[$i]}"
  case "$name" in
    protected-branch-push) extra=" (geschützte Branches: $PROTECTED_BRANCHES)" ;;
    override-label)        extra=" (Override-Label: $OVERRIDE_LABEL)" ;;
    *)                     extra="" ;;
  esac
  echo "$PREFIX blocked dangerous pattern [$name]${extra}. See AGENTS.md." >&2
  exit 2
done
exit 0
