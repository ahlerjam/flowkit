#!/usr/bin/env bash
# gitignore-guard.sh — macht die von /flowkit:setup erzeugten Dateien im
# Zielrepo versionierbar und hält die Laufzeit-Artefakte des Runners
# (`.flowkit/`, `.claude/worktrees/`) ignoriert.
#
# Aufruf:
#   gitignore-guard.sh [<pfad-im-repo>]        (Default: .)
# Exit:
#   0  alles versionierbar (mit oder ohne Ergänzung)
#   1  Voraussetzung verletzt: kein Git-Work-Tree, übergebener Pfad ist nicht die
#      Wurzel des Work-Trees, markierter Block ohne END-Marke, oder .gitignore
#      nicht schreibbar. In allen vier Fällen bleibt die .gitignore unverändert.
#   3  mindestens ein Pfad bleibt trotz Ergänzung ignoriert
#
# Warum ein Script und keine Prosa in commands/setup.md: die Reihenfolge der
# gitignore-Regeln ist fehleranfällig und in Prosa nicht testbar.
#   - Git steigt in ein AUSGESCHLOSSENES ELTERNVERZEICHNIS nicht ab. Eine nackte
#     `!.claude/flowkit-version`-Zeile unter einem `.claude/` bleibt deshalb
#     wirkungslos; erst `!.claude/` + `.claude/*` + Negation wirkt.
#   - Ein Muster ohne Slash im Innern (`.claude/`) greift auf JEDER Ebene, eines
#     mit Slash im Innern (`.claude/*`) nur root-relativ. Ein unverankertes
#     `!.claude/` legt in Monorepos den lokalen Claude-Zustand von `pkg-*/`
#     offen. Deshalb trägt JEDE Zeile dieses Blocks ein führendes `/`.
#   - `git check-ignore -v` liefert Exit 0 AUCH bei einem Negations-Treffer und
#     dreht die Prüfung damit still um; `-q` antwortet korrekt, und beide
#     zusammen sind ein fatal error (rc=128). Hier wird ausschließlich `-q`
#     benutzt.
# Gemessen wird mit `--no-index`, also ausschließlich gegen die Ignore-REGELN.
# Ohne das liest `git check-ignore` den Index mit und meldet jeden bereits
# GETRACKTEN Pfad als „nicht ignoriert" — der Guard kehrt sich damit beim
# zweiten Lauf gegen sich selbst um: nach dem in commands/setup.md Schritt 8
# vorgeschriebenen `git add` + Commit misst er `free_files=0`, schrumpft den
# Block auf `/.flowkit/`, und die Nachprüfung ist aus demselben Grund blind und
# meldet Erfolg. Genau dieser zweite Lauf ist der dokumentierte Update-Pfad;
# danach scheitert `git add .claude/hooks/<neuer-hook>.sh` mit rc=1.
#
# `set -u` ohne `set -e` — wie in den Hook-Skripten: die Bedarfsprüfungen leben
# davon, dass ein Nicht-Treffer (Exit 1) ein normales Ergebnis ist.
set -u

# Der Block wird über das kurze PRÄFIX wiedererkannt, nicht über die ganze
# Zeile. Sonst verwandelt jede spätere Umformulierung des Klammertexts den
# selbstheilenden Pfad lautlos in „zweiten, widersprüchlichen Block anhängen".
BEGIN_MARK='# >>> flowkit'
BEGIN="$BEGIN_MARK (managed block — von /flowkit:setup geschrieben, nicht von Hand editieren)"
END='# <<< flowkit'

# Freizustellen: was Schritt 5 von /flowkit:setup schreibt. settings.json und
# workflow.config.json sind bewusst dabei — ohne sie ist die Installation im
# Clone und in CI wirkungslos.
FREE_FILES=".claude/flowkit-version .claude/settings.json .claude/workflow.config.json"
FREE_HOOKS=".claude/hooks/inject-context.sh .claude/hooks/pretooluse-blocker.sh .claude/hooks/pushci-guard.sh"

cd "${1:-.}" 2>/dev/null \
  || { echo "gitignore-guard: FEHLER Verzeichnis nicht gefunden: ${1:-.}" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "gitignore-guard: FEHLER kein Git-Work-Tree" >&2; exit 1; }
# Der Block ist root-verankert (jede Zeile mit führendem `/`) und gehört in die
# .gitignore der Work-Tree-WURZEL. Ein `cd "$(git rev-parse --show-toplevel)"`
# würde ein übergebenes Monorepo-Unterverzeichnis kommentarlos verlassen: es
# schriebe die FREMDE Root-.gitignore, meldete den Restbefund als
# `.claude/flowkit-version` statt `pkg-a/.claude/flowkit-version` — und für
# `pkg-a/.claude/` bliebe der Block wirkungslos. Deshalb hier abbrechen statt
# umziehen. Verglichen wird physisch (`pwd -P`), sonst schlägt der Vergleich
# schon an einem Symlink im Pfad fehl (macOS: /tmp -> /private/tmp).
top="$(git rev-parse --show-toplevel 2>/dev/null)"
top_phys="$(cd "$top" 2>/dev/null && pwd -P)"
if [ -z "$top_phys" ] || [ "$(pwd -P)" != "$top_phys" ]; then
  echo "gitignore-guard: FEHLER ${1:-.} ist nicht die Wurzel des Work-Trees (${top:-unbekannt}); nichts geändert" >&2
  exit 1
fi

# `--no-index`: nur die Ignore-Regeln zählen, nicht der Index (siehe Kopf).
ignored() { git check-ignore -q --no-index -- "$1"; }   # -q, NIE -v (siehe Kopf)

# 1) Alten Block entfernen -> Ausgangszustand. Macht den Lauf idempotent UND
#    selbstheilend: der Bedarf wird gegen die .gitignore OHNE unseren Block
#    gemessen, der Block danach neu berechnet. Der Umweg über eine Temp-Datei
#    AUSSERHALB des Repos verhindert, dass ein Abbruch eine `.gitignore.tmp` im
#    fremden Arbeitsbaum liegen lässt; zurückgeschrieben wird mit `cat >`, nicht
#    mit `mv`, damit Rechte und Inode der .gitignore erhalten bleiben.
#    Die END-Marke wird über dasselbe PRÄFIX erkannt wie die BEGIN-Marke. Ein
#    exakter Zeilenvergleich liess awk bei jeder Byte-Abweichung (CRLF-
#    Normalisierung bei `core.autocrlf=true`, Handänderung) bis EOF im
#    skip-Zweig — gelöscht wurde ALLES ab der BEGIN-Marke, inklusive der eigenen
#    Regeln des Zielrepos, und gemeldet wurde `fixed` mit Exit 0. Findet awk zur
#    BEGIN-Marke gar keine END-Marke, wird deshalb NICHT geschrieben (Exit 2 aus
#    dem awk-END-Block), sondern mit Fehler abgebrochen.
if [ -f .gitignore ] && grep -q "^$BEGIN_MARK" .gitignore; then
  tmp="$(mktemp)" || { echo "gitignore-guard: FEHLER mktemp fehlgeschlagen" >&2; exit 1; }
  awk -v b="$BEGIN_MARK" -v e="$END" \
      'index($0, b) == 1 { skip = 1; next }
       index($0, e) == 1 { skip = 0; next }
       !skip { print }
       END { if (skip) exit 2 }' \
      .gitignore > "$tmp"
  awk_rc=$?
  if [ "$awk_rc" -eq 2 ]; then
    rm -f "$tmp"
    echo "gitignore-guard: FEHLER markierter Block ohne END-Marke '$END' — .gitignore unverändert gelassen" >&2
    exit 1
  fi
  if [ "$awk_rc" -ne 0 ] || ! cat "$tmp" > .gitignore; then
    rm -f "$tmp"
    echo "gitignore-guard: FEHLER .gitignore nicht schreibbar" >&2
    exit 1
  fi
  rm -f "$tmp"
fi

# 2) Bedarf ermitteln — je Zeile des Blocks eine eigene Prüfung.
need=""
need_flowkit=0; need_wt=0; free_files=0; free_hooks=0; dir_ignored=0

ignored ".flowkit/probe"          || { need_flowkit=1; need="$need .flowkit/"; }
ignored ".claude/worktrees/probe" || { need_wt=1;      need="$need .claude/worktrees/"; }
for p in $FREE_FILES; do
  ignored "$p" && { free_files=1; need="$need $p"; }
done
for p in $FREE_HOOKS; do
  ignored "$p" && { free_hooks=1; need="$need .claude/hooks/*.sh"; break; }
done
ignored ".claude" && dir_ignored=1

if [ -z "$need" ]; then
  echo "gitignore-guard: ok (keine .gitignore-Anpassung nötig)"
  exit 0
fi

# 3) Genau EINEN markierten Block anhängen. Jede Zeile hängt an ihrer eigenen
#    Bedarfsprüfung: der Guard darf nur freistellen, was vorher ignoriert war,
#    und nur ignorieren, was vorher sichtbar UND ein Laufzeit-Artefakt war.
#    Bedingungslos geschriebene Zeilen würden in der typischen Erst-Installation
#    (unter `.claude/` ist nichts ignoriert) bisher sichtbare Dateien wie
#    `.claude/hooks/README.md` neu ausblenden.
{
  # Ohne Schluss-Newline verschmilzt die letzte Bestandszeile mit der
  # Blockmarke: die alte Regel wäre zerstört, der Block unauffindbar, und der
  # nächste Lauf hängte einen zweiten an.
  [ -s .gitignore ] && [ -n "$(tail -c 1 .gitignore)" ] && printf '\n'
  printf '%s\n' "$BEGIN"
  [ "$need_flowkit" -eq 1 ] && printf '/.flowkit/\n'
  # `!/.claude/` + `/.claude/*` NUR, wenn das Verzeichnis selbst ignoriert ist.
  # `/.claude/*` stellt die ursprüngliche Absicht (alles unter .claude bleibt
  # lokal) sofort wieder her, damit z. B. settings.local.json ignoriert bleibt.
  [ "$dir_ignored" -eq 1 ] && printf '!/.claude/\n/.claude/*\n'
  [ "$free_files" -eq 1 ] && printf '!/.claude/flowkit-version\n!/.claude/settings.json\n!/.claude/workflow.config.json\n'
  # `!/.claude/hooks/` allein genügt nicht: ein `.claude/**` im Bestand matcht
  # die Datei selbst weiter, die Verzeichnis-Negation greift für sie nicht.
  [ "$free_hooks" -eq 1 ] && printf '!/.claude/hooks/\n/.claude/hooks/*\n!/.claude/hooks/*.sh\n'
  # Zuletzt, damit die Worktrees des Runners keine Negation von oben erben.
  [ "$need_wt" -eq 1 ] && printf '/.claude/worktrees/\n'
  printf '%s\n' "$END"
} >> .gitignore || { echo "gitignore-guard: FEHLER .gitignore nicht schreibbar" >&2; exit 1; }

# 4) Erfolg nicht behaupten, sondern erneut prüfen. Eine tiefer liegende
#    .gitignore (z. B. `.claude/.gitignore` mit `*`) überstimmt jede
#    Root-Negation — das ist von hier aus nicht reparierbar, aber meldbar.
rest=""
for p in $FREE_FILES $FREE_HOOKS; do
  ignored "$p" && rest="$rest $p"
done
ignored ".flowkit/probe"          || rest="$rest .flowkit/"
ignored ".claude/worktrees/probe" || rest="$rest .claude/worktrees/"
if [ -n "$rest" ]; then
  echo "gitignore-guard: BLOCKIERT trotz Ergänzung:$rest"
  exit 3
fi
echo "gitignore-guard: fixed$need"
exit 0
