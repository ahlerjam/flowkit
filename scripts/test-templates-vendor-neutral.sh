#!/usr/bin/env bash
# flowkit ist ausdrücklich anbieterneutral (README.md: "a universal,
# GitHub-issue-driven agent workflow", an anderer Stelle: "labels, commands,
# config ... is language-neutral"). Alles unter templates/ kopiert
# /flowkit:setup WÖRTLICH in fremde Repos — ein Anbietername darin liest sich
# dort als anbieterspezifische Regel (Issue #40: HCLOUD_TOKEN im generischen
# Blocker-Test). Diese Probe hält templates/ frei von Cloud-/SaaS-Anbieternamen.
# Bewusst NICHT in der Liste: GITHUB/GH/CLAUDE/ANTHROPIC — flowkit IST ein
# GitHub-plus-Claude-Code-Plugin, das sind keine Fremdanbieter.
# Bewusst NUR templates/ — CHANGELOG.md darf HCLOUD_TOKEN nennen, es dokumentiert
# genau dessen Entfernung.
# Aufruf: bash scripts/test-templates-vendor-neutral.sh   (aus dem Plugin-Root)
set -u
[ -d templates ] || { echo "FAIL: templates/ nicht gefunden — aus dem Plugin-Root aufrufen"; exit 1; }
VENDORS='hcloud|hetzner|aws_|_aws|amazon|gcp_|google_|azure_|digitalocean|cloudflare|vercel|netlify|heroku|stripe|twilio|sendgrid|datadog|sentry|npm_token|pypi|dockerhub|gitlab|bitbucket|supabase|firebase'
pass=0; fail=0

# Positivkontrolle: prüft das Muster selbst gegen eine synthetische Zeichenkette,
# BEVOR es gegen templates/ läuft. Ohne sie wäre ein kaputtes oder versehentlich
# leer laufendes VENDORS-Muster silent green — genau die Fehlerklasse, die die
# case-Klausel unten für den grep-Exitcode abfängt, hier für das Muster selbst.
if printf '%s\n' 'export HCLOUD_TOKEN=x' | grep -qiE "$VENDORS"; then
  pass=$((pass+1))
else
  echo "FAIL: Positivkontrolle — VENDORS-Muster erkennt 'HCLOUD_TOKEN' nicht mehr (Muster kaputt?)"
  fail=$((fail+1))
fi

# grep-Exitcode explizit auswerten statt `|| true`: 0 = Treffer (FAIL), 1 = sauber
# (pass), alles andere = grep selbst ist gescheitert (kaputtes Muster, I/O-Fehler)
# und darf NICHT als "sauber" durchgehen.
HITS="$(grep -rnIiE "$VENDORS" templates/ --exclude-dir=__pycache__)"
rc=$?
case "$rc" in
  0)
    echo "FAIL: anbieterspezifischer Bezeichner in templates/ (Issue #40):"
    printf '%s\n' "$HITS"
    echo "Bewusste Ausnahme? Dann das Muster hier streichen und im Kopf begründen."
    fail=$((fail+1))
    ;;
  1)
    pass=$((pass+1))
    ;;
  *)
    echo "FAIL: grep ist mit Exitcode $rc fehlgeschlagen (kaputtes Muster oder I/O-Fehler) — kein stiller Erfolg."
    fail=$((fail+1))
    ;;
esac

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
