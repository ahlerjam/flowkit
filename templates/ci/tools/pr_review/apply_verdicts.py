"""Drop verifier-refuted findings from the merged set.

The adversarial verifier job re-examines each merged P0/P1 finding against the
diff and marks it ``confirmed`` or ``refuted``. This module removes the refuted
ones before the gate runs, joining on ``(file, line, title)`` — the same key
``merge.py`` dedups on.

Conservative by design: a missing, empty, or malformed verdict set removes
nothing (the pipeline then behaves exactly as if no verifier ran). Only an
explicit ``"refuted"`` verdict drops a finding; ``confirmed`` and unseen
findings are always kept.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_Key = tuple[Any, Any, Any]


def _key(item: dict[str, Any]) -> _Key:
    return (item.get("file"), item.get("line"), item.get("title"))


def apply_verdicts(findings: dict[str, Any], verdicts: dict[str, Any]) -> dict[str, Any]:
    """Return ``findings`` with verifier-refuted entries removed."""
    refuted = {
        _key(v)
        for v in verdicts.get("verdicts", [])
        if isinstance(v, dict) and v.get("verdict") == "refuted" and "title" in v
    }
    kept = [f for f in findings.get("findings", []) if _key(f) not in refuted]
    return {"findings": kept}


def _load_required(path: Path) -> dict[str, Any]:
    """Load findings — must be valid; a bad file is a hard error (no silent pass)."""
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    return data


def _load_optional(path: Path) -> dict[str, Any]:
    """Load verdicts — missing/garbled is fine and means 'verify nothing'."""
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Drop verifier-refuted findings.")
    parser.add_argument("--findings", type=Path, required=True)
    parser.add_argument("--verdicts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    findings = _load_required(args.findings)
    verdicts = _load_optional(args.verdicts)
    result = apply_verdicts(findings, verdicts)
    dropped = len(findings.get("findings", [])) - len(result["findings"])
    args.output.write_text(json.dumps(result, indent=2))
    sys.stderr.write(f"apply_verdicts: dropped {dropped} refuted finding(s)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
