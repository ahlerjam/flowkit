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
# Nachrichtentext ausklammern — per Lexer, gebunden ans Programm (Issue #44)
# ---------------------------------------------------------------------------
# Bei `git commit -m "…"` ist der gequotete Wert NUTZLAST: die Shell reicht ihn
# unverändert weiter. Ohne Ausklammerung blockiert der Hook genau die Commits,
# die ÜBER seine eigenen Muster schreiben — im unbeaufsichtigten Lauf eine
# Eigenblockade, die der Builder nicht als solche erkennt.
#
# Der erste Anlauf hat das per sed versucht und war damit selbst der Bypass:
# sed kennt keinen Shell-Quoting-Kontext, also konnte ein Muster wie '[^']*'
# nicht wissen, ob ein Apostroph ein Quote ÖFFNET oder nur in einem
# Doppelquote-Wert steht. `git commit -m "x -t 'y" ; rm -rf / ; …` klammerte
# über den Kommandotrenner hinweg aus und versteckte ein real ausgeführtes
# `rm -rf /`.
#
# Deshalb jetzt ein echter Lexer. Ausgeklammert wird nur, wenn ALLE drei
# Bedingungen halten:
#   1. Das Segment beginnt mit `git commit|tag` oder `gh pr|issue|release|gist`
#      — dieselben Schalter bei `ssh -t` oder `watch -t` bezeichnen ein
#      AUSZUFÜHRENDES Kommando, keine Nachricht.
#   2. Der Wert hängt an einem Nachrichten-Schalter genau dieses Programms.
#   3. Er enthält keine Kommandosubstitution ($( , ${ , Backtick). Nach dem
#      Lexen ist nicht mehr unterscheidbar, ob der Wert einfach oder doppelt
#      gequotet war — deshalb gilt hier die strengere Annahme.
# Segmentiert wird an den Shell-Operatoren, damit ein angehängtes Kommando nie
# in den Schatten einer Nachricht gerät.
#
# Jeder Zweifelsfall fällt auf den VOLLTEXT zurück: unbalancierte Quotes,
# fehlendes python3, leere Ausgabe. Im Zweifel wird mehr geprüft, nie weniger.
PYSCOPE=$(cat <<'PYEOF'
import sys, shlex
OPS = {';', '&&', '||', '|', '&', '\n'}
# Nachrichten-Schalter je (Programm, Unterbefehl). Nur was hier steht, gilt
# als Nutzlast — die Liste ist absichtlich kurz und explizit.
MSG = {
    ('git', 'commit'):  {'-m', '--message'},
    ('git', 'tag'):     {'-m', '--message'},
    ('gh', 'pr'):       {'-b', '--body', '-t', '--title'},
    ('gh', 'issue'):    {'-b', '--body', '-t', '--title'},
    ('gh', 'release'):  {'-n', '--notes', '-t', '--title'},
    ('gh', 'gist'):     {'-d', '--desc'},
}
GIT_GLOBAL_WITH_ARG = {'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'}
PLACEHOLDER = 'FLOWKIT_MESSAGE'

def risky(v):
    # Alles, was die Shell im Wert ausfuehren oder expandieren wuerde. `<(…)`
    # und `>(…)` sind der Fall, der beim Selbstangriff durchrutschte: sie
    # werden AUSGEFUEHRT, enthalten aber weder $( noch einen Backtick. Ein
    # blankes $ zaehlt mit, weil der Wert nach der Expansion ein anderer waere
    # als der geprueft wurde — das kostet wenig, denn ein harmloser Text ohne
    # Muster geht auch ungefiltert durch.
    return '$' in v or '`' in v or '<(' in v or '>(' in v

def subcommand(seg):
    prog = seg[0]
    if prog == 'git':
        i = 1
        while i < len(seg) and seg[i].startswith('-'):
            i += 2 if seg[i] in GIT_GLOBAL_WITH_ARG else 1
        return (prog, seg[i]) if i < len(seg) else None
    if prog == 'gh':
        return (prog, seg[1]) if len(seg) > 1 else None
    return None

def elide(seg):
    key = subcommand(seg)
    flags = MSG.get(key) if key else None
    if not flags:
        return seg
    out, i = list(seg), 0
    while i < len(out):
        t = out[i]
        if t in flags and i + 1 < len(out):
            if not risky(out[i + 1]):
                out[i + 1] = PLACEHOLDER
            i += 2
            continue
        if '=' in t:
            k, v = t.split('=', 1)
            if k in flags and not risky(v):
                out[i] = k + '=' + PLACEHOLDER
        i += 1
    return out

try:
    toks = shlex.split(sys.stdin.read())
except ValueError:
    sys.exit(1)          # unbalanciert -> Aufrufer nimmt den Volltext
res, seg = [], []
for t in toks + [';']:
    if t in OPS:
        res.extend(elide(seg)); res.append(t); seg = []
    else:
        seg.append(t)
sys.stdout.write(' '.join(res))
PYEOF
)
scan=$(printf '%s' "$cmd" | python3 -c "$PYSCOPE" 2>/dev/null) || scan="$cmd"
[ -n "$scan" ] || scan="$cmd"

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
# Dritter Parameter: "full" prüft gegen den UNGEFILTERTEN Kommandotext, also
# auch gegen ausgeklammerten Nachrichtentext. Voreinstellung ist "scan".
RULE_NAMES=(); RULE_RES=(); RULE_SCOPE=()
rule() {
  RULE_NAMES[${#RULE_NAMES[@]}]="$1"
  RULE_RES[${#RULE_RES[@]}]="$2"
  RULE_SCOPE[${#RULE_SCOPE[@]}]="${3:-scan}"
}

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
#
# "full": als einzige Regel gilt sie auch im ausgeklammerten Nachrichtentext.
# Ein Secret in einer Commit-Message oder einem PR-Body ist kein Fehlalarm,
# sondern der Kernfall — es wird veröffentlicht und ist danach nicht mehr
# einzufangen. Die Ausklammerung schützt vor Eigenblockade beim BESCHREIBEN
# gefährlicher Muster; ein Secret ist keine Beschreibung, sondern der Wert.
rule secret-assignment '[A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Za-z_]*=[^[:space:]]{16,}' full

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
  target="$scan"
  [ "${RULE_SCOPE[$i]}" = "full" ] && target="$cmd"
  printf '%s' "$target" | grep -iqE "${RULE_RES[$i]}" || continue
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
