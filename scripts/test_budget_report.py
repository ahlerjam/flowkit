#!/usr/bin/env python3
"""test_budget_report.py — Tests für budget_report.py (nur Stdlib).

Erzeugt echte Fixture-Dateien in einem tempdir (Muster wie
test-cleanup-worktrees.sh: gegen echte Artefakte testen, nichts mocken)
und prüft:
  - Median-/p90-Berechnung (Nearest-Rank) und die 50k-Aufrundung
  - den Pfad "< 3 Delta-Läufe": Hinweis statt Zahlen, kein Vorschlagsblock
  - dass Läufe ohne tokenMode == "delta" komplett ignoriert werden
  - dass kaputte Dateien und Einträge ohne tokens/size die Auswertung
    nicht kippen

Aufruf: python3 scripts/test_budget_report.py
"""

import json
import os
import sys
import tempfile
import unittest

# budget_report.py liegt im selben Verzeichnis — direkt importierbar machen.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import budget_report  # noqa: E402


def schreibe_lauf(verzeichnis, name, token_mode, done):
    """Fixture-Datei im Format der .flowkit/runs-Berichte schreiben."""
    lauf = {
        "done": done,
        "stopped": None,
        "remaining": [],
        "failed": [],
        "blocked": [],
        "parallelism": 1,
        "tokenMode": token_mode,
        "scope": "next 3",
        "startedAt": "2026-07-31T09:00",
    }
    pfad = os.path.join(verzeichnis, name)
    with open(pfad, "w", encoding="utf-8") as f:
        json.dump(lauf, f)
    return pfad


def eintrag(issue, tokens, size):
    """Ein done[]-Eintrag wie ihn der implement-Workflow schreibt."""
    return {"issue": issue, "tokens": tokens, "size": size, "pr": issue + 100}


class TestKennzahlen(unittest.TestCase):
    """Reine Rechenfunktionen: Median, p90 (Nearest-Rank), Aufrundung."""

    def test_p90_nearest_rank(self):
        # n=10: Rang ceil(9.0)=9 → neuntkleinster Wert.
        self.assertEqual(budget_report.p90(list(range(1, 11))), 9)
        # n=5: Rang ceil(4.5)=5 → Maximum.
        self.assertEqual(budget_report.p90([10, 50, 30, 20, 40]), 50)
        # n=1: der einzige Wert.
        self.assertEqual(budget_report.p90([7]), 7)

    def test_vorschlag_rundet_auf_50k_auf(self):
        self.assertEqual(budget_report.vorschlag(180_000), 200_000)
        # Exaktes Vielfaches bleibt stehen.
        self.assertEqual(budget_report.vorschlag(200_000), 200_000)
        # Untergrenze: nie unter einen 50k-Schritt.
        self.assertEqual(budget_report.vorschlag(1), 50_000)


class TestBericht(unittest.TestCase):
    """Berichtstext gegen echte Fixture-Dateien in einem tempdir."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.runs = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_median_und_p90_aus_drei_delta_laeufen(self):
        # S-Messungen über die Läufe verteilt: 100k 120k 140k 180k 200k
        # → Median 140000, p90 (n=5, Rang 5) = 200000, Vorschlag 200000.
        schreibe_lauf(
            self.runs,
            "a.json",
            "delta",
            [eintrag(1, 100_000, "S"), eintrag(2, 120_000, "S")],
        )
        schreibe_lauf(
            self.runs,
            "b.json",
            "delta",
            [eintrag(3, 140_000, "S"), eintrag(4, 470_000, "M")],
        )
        schreibe_lauf(
            self.runs,
            "c.json",
            "delta",
            [eintrag(5, 180_000, "S"), eintrag(6, 200_000, "S")],
        )
        bericht = budget_report.erzeuge_bericht(self.runs)
        s_zeile = next(z for z in bericht.splitlines() if z.startswith("S"))
        self.assertIn("140000", s_zeile)  # Median
        self.assertIn("200000", s_zeile)  # p90
        # M: ein Messwert 470000 → Vorschlag auf 500000 aufgerundet.
        self.assertIn('"M": { "tokens": 500000 }', bericht)
        self.assertIn('"S": { "tokens": 200000 }', bericht)
        # L hat keine Messungen → als solches ausgewiesen, kein L-Vorschlag.
        self.assertIn("keine Messungen", bericht)
        self.assertNotIn('"L": { "tokens"', bericht)
        # Der Nicht-Automatik-Hinweis (Akzeptanzkriterium) steht immer drin.
        self.assertIn("NICHT automatisch", bericht)

    def test_unter_drei_delta_laeufen_hinweis_statt_zahlen(self):
        schreibe_lauf(self.runs, "a.json", "delta", [eintrag(1, 100_000, "S")])
        schreibe_lauf(self.runs, "b.json", "delta", [eintrag(2, 120_000, "S")])
        # Ein dritter Lauf existiert, ist aber kein Delta-Lauf — zählt nicht.
        schreibe_lauf(self.runs, "c.json", "estimate", [eintrag(3, 900_000, "S")])
        bericht = budget_report.erzeuge_bericht(self.runs)
        self.assertIn("Zu wenig Datenbasis", bericht)
        self.assertIn("nur 2 Delta-Läufe", bericht)
        # Keine Scheinpräzision: weder Tabelle noch Vorschlag.
        self.assertNotIn("Median", bericht)
        self.assertNotIn("Vorschlag für budgets", bericht)

    def test_nicht_delta_laeufe_werden_ignoriert(self):
        for name, tokens in (
            ("a.json", 100_000),
            ("b.json", 100_000),
            ("c.json", 100_000),
        ):
            schreibe_lauf(self.runs, name, "delta", [eintrag(1, tokens, "S")])
        # Riesiger Nicht-Delta-Ausreißer darf die Zahlen nicht verschieben;
        # tokens ist dort ohnehin null (so schreibt es der Workflow).
        schreibe_lauf(self.runs, "d.json", "estimate", [eintrag(9, 999_999_999, "S")])
        schreibe_lauf(
            self.runs, "e.json", None, [{"issue": 10, "tokens": None, "size": "S"}]
        )
        bericht = budget_report.erzeuge_bericht(self.runs)
        self.assertIn("davon 3 Läufe", bericht)
        s_zeile = next(z for z in bericht.splitlines() if z.startswith("S"))
        self.assertIn("100000", s_zeile)
        self.assertNotIn("999999999", bericht)

    def test_kaputte_datei_und_kaputte_eintraege_kippen_nichts(self):
        schreibe_lauf(self.runs, "a.json", "delta", [eintrag(1, 100_000, "S")])
        schreibe_lauf(self.runs, "b.json", "delta", [eintrag(2, 100_000, "S")])
        # Delta-Lauf mit unbrauchbaren Einträgen: tokens null (needs-human),
        # unbekanntes size-Label, kein Dict — alle still übersprungen.
        schreibe_lauf(
            self.runs,
            "c.json",
            "delta",
            [
                {"issue": 3, "tokens": None, "size": "S", "needsHuman": True},
                eintrag(4, 100_000, "XL"),
                "kein-dict",
                eintrag(5, 100_000, "S"),
            ],
        )
        # Syntaktisch kaputte Datei: Warnung, kein Absturz.
        with open(os.path.join(self.runs, "kaputt.json"), "w", encoding="utf-8") as f:
            f.write("{ kein json")
        bericht = budget_report.erzeuge_bericht(self.runs)
        self.assertIn("Dateien: 4 gesamt, davon 3 Läufe", bericht)
        s_zeile = next(z for z in bericht.splitlines() if z.startswith("S"))
        self.assertIn(" 3 ", s_zeile)  # genau 3 S-Messungen gezählt
        self.assertIn("100000", s_zeile)


if __name__ == "__main__":
    unittest.main(verbosity=2)
