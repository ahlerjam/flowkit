"""Merge N reviewer-output JSON files into a single curated findings set."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_SEVERITY_ORDER = {"P0": 0, "P1": 1, "P2": 2}


def _dedup_key(finding: dict[str, Any]) -> tuple[str | None, int | None, str]:
    return (finding.get("file"), finding.get("line"), finding["title"])


def merge_findings(input_paths: list[Path]) -> dict[str, Any]:
    """Load each reviewer output, filter by confidence, dedup, sort by severity."""
    by_key: dict[tuple[str | None, int | None, str], dict[str, Any]] = {}

    for path in input_paths:
        payload = json.loads(path.read_text())
        threshold = payload.get("confidence_filter", 0)
        reviewer = payload["reviewer"]

        for finding in payload["findings"]:
            if "severity" not in finding:
                raise ValueError(
                    f"Finding missing required 'severity' field: title={finding.get('title', '<no title>')!r} "
                    f"(source: {path})"
                )
            if finding.get("confidence", 100) < threshold:
                continue
            key = _dedup_key(finding)
            stamped = {**finding, "source_reviewer": reviewer}
            existing = by_key.get(key)
            # Dedup tiebreaker: keep the HIGHER-severity finding first, then the
            # higher-confidence one. Compare on (severity_order, -confidence) where
            # smaller wins — P0 (order 0) beats P2 (order 2), and within the same
            # severity a higher confidence wins. Previously this compared on
            # confidence ONLY, so a high-confidence P2 from one reviewer could
            # silently overwrite a lower-confidence P0 from another for the same
            # (file, line, title) key — a severity downgrade that masked blockers.
            if existing is None or (
                _SEVERITY_ORDER[stamped["severity"]],
                -stamped.get("confidence", 0),
            ) < (
                _SEVERITY_ORDER[existing["severity"]],
                -existing.get("confidence", 0),
            ):
                by_key[key] = stamped

    merged = sorted(
        by_key.values(),
        key=lambda f: (_SEVERITY_ORDER[f["severity"]], f.get("file") or "", f.get("line") or 0),
    )
    return {"findings": merged}


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Merge reviewer JSON outputs.")
    parser.add_argument("--input", nargs="+", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    result = merge_findings(args.input)
    args.output.write_text(json.dumps(result, indent=2))
    sys.stderr.write(f"Wrote {len(result['findings'])} findings to {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
