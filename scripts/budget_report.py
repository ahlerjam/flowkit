#!/usr/bin/env python3
"""budget_report.py — Kalibrier-Auswertung der flowkit-Lauf-Berichte.

Liest alle Lauf-Berichte (`.flowkit/runs/*.json`) eines Zielrepos, filtert
Läufe mit `tokenMode == "delta"` (nur dort ist `done[].tokens` eine echte
Messung, keine Schätzung) und aggregiert den Token-Verbrauch je size-Label
(S/M/L). Ausgabe: Median und p90 je Label plus ein Vorschlagsblock für
`budgets.<size>.tokens` (p90 aufgerundet auf 50000er-Schritte).

Rote Linie (Spec-Issue #7): dieses Script schreibt NUR nach stdout und fasst
`workflow.config.json` niemals an — der Vorschlag wird dem Operator
präsentiert, die Übernahme bleibt seine Entscheidung. Bei weniger als
3 verwertbaren Delta-Läufen gibt es einen klaren Hinweis statt Zahlen
(zu dünne Datenbasis wäre Scheinpräzision).

Aufruf:
    python3 budget_report.py [<runs-Verzeichnis>]    # Default: .flowkit/runs

Keine Fremdpakete — nur Python-Stdlib. Exit != 0 nur bei Fehlbedienung
(fehlendes Verzeichnis); "zu wenig Daten" ist ein korrektes Ergebnis (Exit 0).
"""

import json
import math
import statistics
import sys
from pathlib import Path

# Nur diese Labels kennt das Budget-Schema (budgets.S/M/L) — andere size-Werte
# in Lauf-Berichten wären Datenfehler und werden bewusst nicht aggregiert.
SIZES = ("S", "M", "L")
# Vorschlags-Rundung: p90 aufgerundet auf das nächste Vielfache dieses Werts.
RUNDUNG = 50_000
# Unter dieser Zahl verwertbarer Delta-Läufe gibt es keine Kalibrier-Zahlen.
MIN_DELTA_LAEUFE = 3


def lies_laeufe(verzeichnis):
    """Alle *.json im Verzeichnis lesen (sortiert, deterministisch).

    Unlesbare oder strukturell fremde Dateien werden mit Warnung auf stderr
    übersprungen — ein kaputter Einzelbericht darf die Auswertung nicht kippen.
    Rückgabe: (Liste der Lauf-Dicts, Anzahl gefundener Dateien).
    """
    laeufe = []
    dateien = sorted(Path(verzeichnis).glob("*.json"))
    for pfad in dateien:
        try:
            with open(pfad, encoding="utf-8") as f:
                daten = json.load(f)
        except (OSError, ValueError) as fehler:
            print(f"WARNUNG: {pfad} übersprungen ({fehler})", file=sys.stderr)
            continue
        if not isinstance(daten, dict):
            print(f"WARNUNG: {pfad} übersprungen (kein JSON-Objekt)", file=sys.stderr)
            continue
        laeufe.append(daten)
    return laeufe, len(dateien)


def tokens_je_size(laeufe):
    """`done[].tokens` der Delta-Läufe je size-Label einsammeln.

    Nicht-Delta-Läufe (tokenMode fehlt oder != "delta") zählen komplett nicht;
    innerhalb eines Delta-Laufs werden Einträge ohne Zahlenwert in `tokens`
    oder ohne bekanntes size-Label übersprungen.
    Rückgabe: (dict size -> Liste der Token-Messungen, Anzahl Delta-Läufe).
    """
    je_size = {s: [] for s in SIZES}
    delta_laeufe = 0
    for lauf in laeufe:
        if lauf.get("tokenMode") != "delta":
            continue
        delta_laeufe += 1
        for eintrag in lauf.get("done") or []:
            if not isinstance(eintrag, dict):
                continue
            tokens = eintrag.get("tokens")
            size = eintrag.get("size")
            # bool ist in Python ein int-Subtyp — explizit ausschließen.
            if isinstance(tokens, bool) or not isinstance(tokens, (int, float)):
                continue
            if size in je_size:
                je_size[size].append(int(tokens))
    return je_size, delta_laeufe


def p90(werte):
    """p90 nach Nearest-Rank: der Messwert, unter oder auf dem mindestens
    90 % der Messungen liegen. Deterministisch, keine Interpolation —
    bei kleinen Stichproben ehrlicher als ein interpolierter Zwischenwert.
    """
    sortiert = sorted(werte)
    rang = max(1, math.ceil(0.9 * len(sortiert)))
    return sortiert[rang - 1]


def vorschlag(p90_wert):
    """Config-Vorschlag: p90 aufgerundet auf das nächste RUNDUNG-Vielfache,
    mindestens ein RUNDUNG-Schritt (ein Budget von 0 wäre sinnlos)."""
    return max(RUNDUNG, math.ceil(p90_wert / RUNDUNG) * RUNDUNG)


def erzeuge_bericht(verzeichnis):
    """Berichtstext für das Verzeichnis erzeugen (reine Funktion, testbar)."""
    laeufe, dateien = lies_laeufe(verzeichnis)
    je_size, delta_laeufe = tokens_je_size(laeufe)

    zeilen = [
        f"flowkit Budget-Report — {verzeichnis}",
        f"Dateien: {dateien} gesamt, davon {delta_laeufe} Läufe mit"
        f' tokenMode == "delta" (nur diese zählen).',
        "",
    ]

    if delta_laeufe < MIN_DELTA_LAEUFE:
        zeilen.append(
            f"Zu wenig Datenbasis: nur {delta_laeufe} Delta-Läufe, mindestens"
            f" {MIN_DELTA_LAEUFE} nötig — keine Kalibrier-Zahlen."
        )
        zeilen.append(
            'Kalibrier-Läufe entstehen mit parallelism: 1 (tokenMode "delta");'
            " einfach weitere Läufe sammeln und den Report erneut aufrufen."
        )
        return "\n".join(zeilen)

    zeilen.append(f"{'size':<6}{'n':>4}  {'Median':>10}  {'p90':>10}")
    vorschlaege = []
    for size in SIZES:
        werte = je_size[size]
        if not werte:
            zeilen.append(f"{size:<6}{0:>4}  {'—':>10}  {'—':>10}  (keine Messungen)")
            continue
        med = int(statistics.median(werte))
        p = p90(werte)
        zeilen.append(f"{size:<6}{len(werte):>4}  {med:>10}  {p:>10}")
        vorschlaege.append((size, len(werte), p, vorschlag(p)))

    if vorschlaege:
        zeilen.append("")
        zeilen.append(
            f"Vorschlag für budgets.<size>.tokens"
            f" (p90 aufgerundet auf {RUNDUNG}er-Schritte):"
        )
        for size, n, p, wert in vorschlaege:
            zeilen.append(
                f'  "{size}": {{ "tokens": {wert} }}'
                f"   (Basis: p90 = {p} aus {n} Messungen)"
            )

    zeilen.append("")
    zeilen.append(
        "Hinweis: Der Vorschlag wird NICHT automatisch angewendet —"
        " workflow.config.json bleibt unangetastet, Übernahme ist"
        " Operator-Entscheidung."
    )
    return "\n".join(zeilen)


def main(argv):
    verzeichnis = argv[1] if len(argv) > 1 else ".flowkit/runs"
    if not Path(verzeichnis).is_dir():
        print(
            f"FEHLER: {verzeichnis} ist kein Verzeichnis — Pfad zu den"
            f" Lauf-Berichten (.flowkit/runs) als Argument übergeben.",
            file=sys.stderr,
        )
        return 2
    print(erzeuge_bericht(verzeichnis))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
