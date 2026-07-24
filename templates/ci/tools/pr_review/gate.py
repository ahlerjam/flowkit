"""Policy gate: exit 1 when P0/P1 findings present unless override-label set."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

OVERRIDE_LABEL = os.environ.get("FLOWKIT_OVERRIDE_LABEL", "override-claude-review")
BLOCKING_SEVERITIES = frozenset({"P0", "P1"})


@dataclass(frozen=True)
class Verdict:
    exit_code: int
    blocker_count: int
    override_applied: bool


def evaluate_gate(findings_path: Path, override_label_present: bool) -> Verdict:
    """Evaluate policy gate: count P0/P1 findings, decide exit code.

    Args:
        findings_path: JSON file with {"findings": [...]} structure
        override_label_present: if True, bypass blocking findings

    Returns:
        Verdict(exit_code, blocker_count, override_applied)

    Raises:
        ValueError: if any finding is missing "severity" field
    """
    data = json.loads(findings_path.read_text())

    # Defensive: validate all findings have severity before counting
    for finding in data["findings"]:
        if "severity" not in finding:
            title = finding.get("title", "unknown")
            raise ValueError(f"Finding '{title}' missing 'severity' field (from {findings_path})")

    count = sum(1 for f in data["findings"] if f["severity"] in BLOCKING_SEVERITIES)

    if override_label_present:
        return Verdict(exit_code=0, blocker_count=count, override_applied=True)
    return Verdict(
        exit_code=1 if count else 0,
        blocker_count=count,
        override_applied=False,
    )


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Gate on P0/P1 findings.")
    parser.add_argument("findings", type=Path)
    parser.add_argument(
        "--labels",
        default=os.environ.get("PR_LABELS", ""),
        help="Comma-separated PR labels (from `gh pr view --json labels`).",
    )
    args = parser.parse_args()

    label_set = {label.strip() for label in args.labels.split(",") if label.strip()}
    override_present = OVERRIDE_LABEL in label_set

    verdict = evaluate_gate(args.findings, override_present)

    if verdict.override_applied and verdict.blocker_count > 0:
        actor = os.environ.get("GITHUB_ACTOR", "unknown")
        sys.stderr.write(
            f"::warning::Override label `{OVERRIDE_LABEL}` set by {actor} — "
            f"bypassing {verdict.blocker_count} blocking finding(s).\n"
        )
    elif verdict.exit_code == 1:
        sys.stderr.write(f"::error::{verdict.blocker_count} P0/P1 finding(s) — blocking merge.\n")
    else:
        sys.stderr.write("::notice::No blocking findings.\n")
    return verdict.exit_code


if __name__ == "__main__":
    raise SystemExit(_cli())
