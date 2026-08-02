#!/usr/bin/env bash
# Testet scripts/gitignore-guard.sh gegen echte Wegwerf-Repos.
# Aufruf: bash scripts/test-gitignore-guard.sh [pfad-zum-script]
#
# HERMETIK (Rahmenbedingung ALLER Fälle): jeder Fall bekommt ein eigenes
# `mktemp -d` mit neutralisiertem HOME, GIT_CONFIG_GLOBAL und GIT_CONFIG_SYSTEM.
# Ohne das entscheidet die `~/.config/git/ignore` des Entwicklerrechners über
# das Ergebnis von `git check-ignore` (auf der Maschine, auf der dieser Guard
# entstand, ignoriert sie global `**/.claude/settings.local.json`) — ein
# maschinenabhängiger Test beweist nichts.
#
# Sektionen:
#   (a) .claude/ ignoriert       — Freistellung, lokaler Zustand, Monorepo, Idempotenz
#   (b) .claude/** ignoriert     — Doppelstern-Muster
#   (c) nichts ignoriert         — Nicht-Regression: der Guard blendet nichts neu aus
#   (d) Randfälle                — Restbefund, fehlender Newline, kein Work-Tree,
#                                  fehlende .gitignore, globale excludesFile
#   (e) Blockmarke               — Wiedererkennung über das Präfix, Kopplung an setup.md
#   (f) Zerstörungsfälle         — Lauf nach dem Installations-Commit, beschädigte
#                                  END-Marke, Aufruf aus einem Unterverzeichnis
set -u

SCRIPT="${1:-$(cd "$(dirname "$0")" && pwd)/gitignore-guard.sh}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SCRIPT" ] || { echo "FAIL: Script nicht gefunden: $SCRIPT" >&2; exit 1; }

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

fails=0
check() { # check <beschreibung> <bedingung...>
  local desc="$1"; shift
  if "$@"; then echo "ok:   $desc"; else echo "FAIL: $desc"; fails=$((fails + 1)); fi
}

n=0
newrepo() { # newrepo -> hermetisches Repo anlegen und hineinwechseln
  n=$((n + 1))
  local d="$TMPROOT/r$n"
  mkdir -p "$d/home" "$d/repo"
  : > "$d/gitconfig"
  export HOME="$d/home"
  export GIT_CONFIG_GLOBAL="$d/gitconfig"
  export GIT_CONFIG_SYSTEM=/dev/null
  cd "$d/repo" || return 1
  git init -q -b main . 2>/dev/null
}

seed() { # die sechs Dateien, die /flowkit:setup Schritt 5 schreibt
  mkdir -p .claude/hooks
  : > .claude/flowkit-version
  : > .claude/settings.json
  : > .claude/workflow.config.json
  : > .claude/hooks/inject-context.sh
  : > .claude/hooks/pretooluse-blocker.sh
  : > .claude/hooks/pushci-guard.sh
}

OUT=""; RC=0
run() { OUT=""; RC=0; OUT="$(bash "$SCRIPT" "$@" 2>&1)" || RC=$?; return 0; }

free_()  { ! git check-ignore -q -- "$1"; }   # nicht ignoriert -> versionierbar
ign_()   {   git check-ignore -q -- "$1"; }   # ignoriert
untracked() { git status --porcelain -uall | grep -qxF "?? $1"; }
contains() { printf '%s' "$OUT" | grep -qF "$1"; }
rc_is()  { [ "$RC" -eq "$1" ]; }

SIX=".claude/flowkit-version .claude/settings.json .claude/workflow.config.json
     .claude/hooks/inject-context.sh .claude/hooks/pretooluse-blocker.sh .claude/hooks/pushci-guard.sh"

# ---------------------------------------------------------------- (a)
# Ausgangslage: das Zielrepo ignoriert `.claude/` komplett — genau der Fall, in
# dem der Installations-PR bisher KEINE der in Schritt 5 geschriebenen Dateien
# enthielt und die Drift-Warnung in jedem frischen Clone still blieb.
newrepo
printf '.claude/\n' > .gitignore
seed
mkdir -p .claude/worktrees pkg-a/.claude/hooks
: > .claude/worktrees/x
: > .claude/settings.local.json
: > pkg-a/.claude/settings.local.json
: > pkg-a/.claude/hooks/local.sh
run .

check "(a) T1 Exit 0"                     rc_is 0
check "(a) T1 meldet fixed"               contains "gitignore-guard: fixed"
for p in $SIX; do
  check "(a) T1 versionierbar: $p"        free_ "$p"
  check "(a) T1 als untracked sichtbar: $p" untracked "$p"
done
# T2: der Guard darf die ursprüngliche Absicht nicht kippen. `!.claude/` allein
# würde den gesamten lokalen Claude-Zustand in den Installations-PR ziehen.
check "(a) T2 settings.local.json bleibt ignoriert" ign_ .claude/settings.local.json
check "(a) T2 worktrees bleiben ignoriert"          ign_ .claude/worktrees/x
# Monorepo: `!.claude/` ohne führenden Slash griffe auf JEDER Ebene und legte
# den lokalen Zustand fremder Pakete offen. Alle Blockzeilen sind deshalb
# root-verankert.
check "(a) Monorepo pkg-a/.claude bleibt ignoriert (settings)" ign_ pkg-a/.claude/settings.local.json
check "(a) Monorepo pkg-a/.claude bleibt ignoriert (hook)"     ign_ pkg-a/.claude/hooks/local.sh
check "(a) keine unverankerte Negation im Block" bash -c '! grep -qx "!\.claude/" .gitignore'
check "(a) .flowkit/ ergänzt"             ign_ .flowkit/runs/x.json

# T3: Idempotenz — AC 4. Ein zweites /flowkit:setup darf keine doppelten Zeilen
# erzeugen. Der Guard entfernt den alten Block VOR der Messung und baut ihn neu.
cp .gitignore "$TMPROOT/before-2nd"
run .
check "(a) T3 zweiter Lauf Exit 0"        rc_is 0
check "(a) T3 .gitignore byte-identisch"  diff -q "$TMPROOT/before-2nd" .gitignore
check "(a) T3 genau ein Block"            bash -c '[ "$(grep -c "^# >>> flowkit" .gitignore)" -eq 1 ]'
check "(a) T3 genau eine Negation"        bash -c '[ "$(grep -c "^!/\.claude/flowkit-version$" .gitignore)" -eq 1 ]'

# ---------------------------------------------------------------- (b)
# `.claude/**` matcht die Dateien selbst, aber NICHT das Verzeichnis. Eine
# Fassung, die nur `!.claude/hooks/` schreibt, löst diesen Fall nicht — erst
# `!/.claude/hooks/*.sh` greift für die Datei.
newrepo
printf '.claude/**\n' > .gitignore
seed
run .
check "(b) T4 Exit 0"                          rc_is 0
check "(b) T4 Hook-Datei versionierbar"        free_ .claude/hooks/inject-context.sh
check "(b) T4 Stempeldatei versionierbar"      free_ .claude/flowkit-version
check "(b) T4 settings.json versionierbar"     free_ .claude/settings.json

# ---------------------------------------------------------------- (c)
# Nicht-Regression, der eigentliche Zweck der Bedarfsprüfungen: unter `.claude/`
# ist nichts ignoriert (typische Erst-Installation, und der häufigste reale
# Fall: ein Repo, das `.claude/` bewusst VERSIONIERT). Der Guard darf hier
# ausschließlich die Laufzeit-Artefakte ergänzen. Würde er die Hook-Trias
# bedingungslos schreiben, blendete `/.claude/hooks/*` alles aus, was nicht auf
# `.sh` endet.
newrepo
printf 'node_modules/\n' > .gitignore
seed
: > .claude/hooks/README.md
mkdir -p .claude/hooks/sub
: > .claude/hooks/sub/x.sh
: > .claude/settings.local.json
run .
check "(c) T5 Exit 0"                          rc_is 0
check "(c) T5 nennt .flowkit/"                 contains ".flowkit/"
check "(c) T5 nennt .claude/worktrees/"        contains ".claude/worktrees/"
check "(c) T5 .flowkit/ ignoriert"             ign_ .flowkit/runs/x.json
check "(c) T5 worktrees ignoriert"             ign_ .claude/worktrees/y
check "(c) T5 kein !/.claude/"                 bash -c '! grep -qx "!/\.claude/" .gitignore'
check "(c) T5 kein /.claude/*"                 bash -c '! grep -qx "/\.claude/\*" .gitignore'
check "(c) T5 kein /.claude/hooks/*"           bash -c '! grep -qx "/\.claude/hooks/\*" .gitignore'
check "(c) T5 settings.local.json bleibt sichtbar"    free_ .claude/settings.local.json
check "(c) T5 hooks/README.md bleibt sichtbar"        free_ .claude/hooks/README.md
check "(c) T5 hooks/sub/x.sh bleibt sichtbar"         free_ .claude/hooks/sub/x.sh
check "(c) T5 README weiterhin untracked gelistet"    untracked .claude/hooks/README.md

# ---------------------------------------------------------------- (d)
# T6 — Restbefund: eine tiefer liegende .gitignore überstimmt jede Root-Negation.
# Der Guard kann das nicht reparieren, aber er darf Erfolg nicht BEHAUPTEN (AC 2).
newrepo
printf '.claude/\n' > .gitignore
seed
printf '*\n' > .claude/.gitignore
run .
check "(d) T6 Exit 3"                          rc_is 3
check "(d) T6 meldet BLOCKIERT"                contains "gitignore-guard: BLOCKIERT trotz Ergänzung:"
check "(d) T6 nennt die Stempeldatei"          contains ".claude/flowkit-version"
check "(d) T6 nennt eine Hook-Datei"           contains ".claude/hooks/inject-context.sh"

# T7 — .gitignore ohne Schluss-Newline. Ein naives `echo >>` erzeugte hier
# `.claude/# >>> flowkit …`: alte Regel zerstört, Blockmarke unauffindbar, und
# der Folgelauf hängte einen zweiten Block an.
newrepo
printf '.claude/' > .gitignore
seed
run .
check "(d) T7 Exit 0"                          rc_is 0
check "(d) T7 alte Regel unversehrt"           bash -c 'grep -qx "\.claude/" .gitignore'
check "(d) T7 Blockmarke auffindbar"           bash -c 'grep -q "^# >>> flowkit" .gitignore'
check "(d) T7 Stempeldatei versionierbar"      free_ .claude/flowkit-version

# T8 — kein Git-Work-Tree: /flowkit:setup läuft in fremden Repos, ein
# Fehlschreiben wäre dort nicht rückholbar sichtbar.
mkdir -p "$TMPROOT/nogit"
cd "$TMPROOT/nogit"
run .
check "(d) T8 Exit 1"                          rc_is 1
check "(d) T8 Fehlertext"                      contains "kein Git-Work-Tree"
check "(d) T8 keine .gitignore angelegt"       bash -c '! [ -e .gitignore ]'

# T9 — gar keine .gitignore: der typische frische Zielrepo-Zustand. Eine Fassung,
# die den Bearbeitungspfad an `[ -f .gitignore ]` hängt, täte hier lautlos nichts.
newrepo
seed
: > .claude/hooks/README.md
run .
check "(d) T9 Exit 0"                          rc_is 0
check "(d) T9 .gitignore angelegt"             bash -c '[ -f .gitignore ]'
check "(d) T9 .flowkit/ ignoriert"             ign_ .flowkit/runs/x.json
check "(d) T9 worktrees ignoriert"             ign_ .claude/worktrees/y
check "(d) T9 hooks/README.md bleibt sichtbar" free_ .claude/hooks/README.md

# T10 — globale core.excludesFile. Eine Fassung, die statt `git check-ignore`
# die .gitignore selbst greppt, sähe das Muster gar nicht und übersähe den Bedarf.
newrepo
seed
printf '.claude/\n' > "$HOME/globalignore"
git config --global core.excludesFile "$HOME/globalignore"
check "(d) T10 Vorbedingung: global ignoriert" ign_ .claude/flowkit-version
run .
check "(d) T10 Exit 0"                         rc_is 0
for p in $SIX; do
  check "(d) T10 versionierbar: $p"            free_ "$p"
done

# ---------------------------------------------------------------- (e)
# Die gesamte Idempotenz hängt an der Wiedererkennung der Blockmarke. Wird sie
# über die GANZE Zeile gesucht, verwandelt jede spätere Umformulierung des
# Klammertexts den selbstheilenden Pfad still in „zweiten, widersprüchlichen
# Block anhängen". Deshalb erkennt der Guard über das PRÄFIX — hier gepinnt.
newrepo
seed
{ printf '.claude/\n'
  printf '# >>> flowkit (Wortlaut einer aelteren Fassung)\n'
  printf '.flowkit/\n!.claude/flowkit-version\n'
  printf '# <<< flowkit\n'; } > .gitignore
run .
check "(e) alter Block mit anderem Wortlaut: Exit 0" rc_is 0
check "(e) genau ein Block"                    bash -c '[ "$(grep -c "^# >>> flowkit" .gitignore)" -eq 1 ]'
check "(e) alter Wortlaut entfernt"            bash -c '! grep -q "aelteren Fassung" .gitignore'
check "(e) alte unverankerte Negation weg"     bash -c '! grep -qx "!\.claude/flowkit-version" .gitignore'
check "(e) Stempeldatei versionierbar"         free_ .claude/flowkit-version

# Prosa und Code müssen dieselbe Marke nennen — sonst beschreibt setup.md einen
# Block, den der Guard nicht wiedererkennt.
cd "$REPO_ROOT"
check "(e) setup.md nennt die BEGIN-Marke"     grep -q '# >>> flowkit' commands/setup.md
check "(e) setup.md nennt die END-Marke"       grep -q '# <<< flowkit' commands/setup.md
check "(e) setup.md ruft den Guard auf"        grep -q 'scripts/gitignore-guard.sh' commands/setup.md
check "(e) Guard führt die BEGIN-Marke"        grep -q "BEGIN_MARK='# >>> flowkit'" "$SCRIPT"
check "(e) Guard führt die END-Marke"          grep -q "END='# <<< flowkit'" "$SCRIPT"
# `-v` würde bei einem Negations-Treffer Exit 0 liefern und die Prüfung still
# umdrehen; `-q -v` zusammen sind ein fatal error. Der Guard darf nur `-q`.
# Kommentare werden vor dem Grep entfernt — der Kopf des Guards ERKLÄRT die
# Falle und darf `-v` deshalb erwähnen.
check "(e) Guard prüft mit check-ignore -q"    grep -q 'git check-ignore -q --no-index -- "\$1"' "$SCRIPT"
check "(e) kein check-ignore -v im Code"       bash -c '! sed "s/#.*//" "$1" | grep -q "check-ignore.*-v"' _ "$SCRIPT"
check "(e) CI führt diese Suite aus"           grep -q 'test-gitignore-guard.sh' .github/workflows/tests.yml

# ---------------------------------------------------------------- (f)
# Zerstörungsfälle. Kein Fall der Sektionen (a)–(e) committet und keiner
# beschädigt den Block — genau deshalb blieben die drei Defekte hier unentdeckt.

# T11 — der dokumentierte Update-Pfad: Schritt 8 von /flowkit:setup committet die
# freigestellten Dateien, ein späteres /flowkit:setup läuft erneut. Misst der
# Guard den Bedarf MIT Index, meldet `git check-ignore` jeden getrackten Pfad als
# „nicht ignoriert": der zweite Lauf schrumpft den Block auf `/.flowkit/`, und
# die Nachprüfung ist aus demselben Grund blind und meldet Erfolg. Danach
# scheitert `git add` jedes NEUEN Hooks — die Selbstheilung kehrt sich um.
newrepo
git config user.email flowkit@example.invalid
git config user.name flowkit-test
printf '.claude/\n' > .gitignore
seed
: > .claude/settings.local.json
run .
check "(f) T11 erster Lauf Exit 0"                 rc_is 0
cp .gitignore "$TMPROOT/before-commit"
git add .gitignore .claude/flowkit-version .claude/settings.json \
        .claude/workflow.config.json .claude/hooks >/dev/null 2>&1
git commit -qm "chore: install flowkit" >/dev/null 2>&1
check "(f) T11 Vorbedingung: Dateien getrackt" \
  bash -c 'git ls-files --error-unmatch .claude/hooks/pushci-guard.sh >/dev/null 2>&1'
run .
check "(f) T11 zweiter Lauf Exit 0"                rc_is 0
check "(f) T11 .gitignore byte-identisch"          diff -q "$TMPROOT/before-commit" .gitignore
check "(f) T11 Freistellung erhalten"              bash -c 'grep -qx "!/\.claude/flowkit-version" .gitignore'
check "(f) T11 Hook-Freistellung erhalten"         bash -c 'grep -qx "!/\.claude/hooks/\*\.sh" .gitignore'
: > .claude/hooks/neuer-hook.sh
check "(f) T11 neuer Hook stagebar"                bash -c 'git add .claude/hooks/neuer-hook.sh >/dev/null 2>&1'
check "(f) T11 settings.local.json bleibt ignoriert" ign_ .claude/settings.local.json

# T12 — F-2, Variante „ein Byte daneben": die END-Marke wird über dasselbe
# PRÄFIX erkannt wie die BEGIN-Marke. Beim exakten Zeilenvergleich fraß awk ab
# der BEGIN-Marke alles bis EOF — die eigenen Regeln des Zielrepos verschwanden,
# gemeldet wurde `fixed` mit Exit 0.
newrepo
printf '.claude/\n' > .gitignore
seed
run .
printf 'dist/\ncoverage.xml\n' >> .gitignore
sed 's/^# <<< flowkit$/# <<< flowkit /' .gitignore > "$TMPROOT/gi" && cat "$TMPROOT/gi" > .gitignore
run .
check "(f) T12 abweichende END-Marke: Exit 0"      rc_is 0
check "(f) T12 Fremdregel dist/ erhalten"          bash -c 'grep -qx "dist/" .gitignore'
check "(f) T12 Fremdregel coverage.xml erhalten"   bash -c 'grep -qx "coverage.xml" .gitignore'
check "(f) T12 dist/ weiterhin ignoriert"          ign_ dist/x
check "(f) T12 genau ein Block"                    bash -c '[ "$(grep -c "^# >>> flowkit" .gitignore)" -eq 1 ]'
check "(f) T12 Stempeldatei versionierbar"         free_ .claude/flowkit-version

# T13 — F-2, Variante „END-Marke ganz weg": jetzt ist nicht mehr entscheidbar,
# wo der Block endet. Kürzen wäre Datenverlust, also gar nicht schreiben.
newrepo
printf '.claude/\n' > .gitignore
seed
run .
printf 'dist/\n' >> .gitignore
grep -v '^# <<< flowkit' .gitignore > "$TMPROOT/gi" && cat "$TMPROOT/gi" > .gitignore
cp .gitignore "$TMPROOT/before-broken"
run .
check "(f) T13 fehlende END-Marke: Exit 1"         rc_is 1
check "(f) T13 Fehlertext nennt die END-Marke"     contains "ohne END-Marke '# <<< flowkit'"
check "(f) T13 .gitignore unverändert"             diff -q "$TMPROOT/before-broken" .gitignore
check "(f) T13 dist/ weiterhin ignoriert"          ign_ dist/x

# T14 — F-17: Monorepo-Unterverzeichnis. Jede Blockzeile ist root-verankert, der
# Block gehört also in die .gitignore der Work-Tree-Wurzel. Ein `cd` dorthin
# verließ das übergebene Verzeichnis kommentarlos: geschrieben wurde die FREMDE
# Root-.gitignore, für `pkg-a/.claude/` blieb der Block wirkungslos, und der
# Restbefund nannte `.claude/…` statt `pkg-a/.claude/…`.
newrepo
printf '.claude/\n' > .gitignore
seed
cp .gitignore "$TMPROOT/before-sub"
mkdir -p pkg-a/.claude/hooks
: > pkg-a/.claude/flowkit-version
run pkg-a
check "(f) T14 Unterverzeichnis: Exit 1"           rc_is 1
check "(f) T14 Meldung nennt die Wurzel"           contains "nicht die Wurzel des Work-Trees"
check "(f) T14 Root-.gitignore unverändert"        diff -q "$TMPROOT/before-sub" .gitignore
check "(f) T14 kein Block in der Root-.gitignore"  bash -c '! grep -q "^# >>> flowkit" .gitignore'
# Gegenprobe: die Wurzel selbst bleibt erlaubt, auch als absoluter Pfad.
run "$PWD"
check "(f) T14 absoluter Wurzelpfad erlaubt"       rc_is 0
check "(f) T14 Block jetzt geschrieben"            bash -c 'grep -q "^# >>> flowkit" .gitignore'

echo
if [ "$fails" -eq 0 ]; then echo "ALLE TESTS GRÜN"; else echo "$fails TEST(S) ROT"; exit 1; fi
