"""Decide whether the LLM review can be skipped for this run (review cache).

Every merge makes the gate update the remaining open PR branches
(``git merge origin/main`` + push) — a ``synchronize`` event that re-triggers
the full deep review although the PR's diff against its merge base is
byte-identical when main touched disjoint files. This module compares the
sha256 of the current bounded diff with the ``diffHash`` stored in the
previous sticky comment's embedded JSON. On a hit the stored findings are
re-emitted so the gate re-applies the SAME verdict without spending a single
model token.

Conservative by design — any anomaly is a MISS (full review runs):
missing comment, missing/mismatched hash, malformed JSON, findings that
would crash the gate (missing ``severity``). Fail-open goes toward a full
review, never toward green-without-review. Note that a base update touching
the same files as the PR changes the diff's context lines, so the hash
differs and a real re-review runs — exactly when it is warranted.

Output (stdout, ``$GITHUB_OUTPUT`` format)::

    cache_hit=true|false
    diff_hash=<sha256 of the current bounded diff>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

JSON_MARKER_OPEN = "<!-- flowkit-review-json:v1"
JSON_MARKER_CLOSE = "-->"


def extract_payload(previous_body: str) -> dict[str, Any]:
    """Parse the embedded JSON payload from a sticky comment; {} on any problem."""
    start_idx = previous_body.find(JSON_MARKER_OPEN)
    if start_idx < 0:
        return {}
    start = start_idx + len(JSON_MARKER_OPEN)
    end = previous_body.rfind(JSON_MARKER_CLOSE)
    if end <= start:
        return {}
    try:
        prev = json.loads(previous_body[start:end].strip())
    except json.JSONDecodeError:
        return {}
    return prev if isinstance(prev, dict) else {}


def check(diff_path: Path, previous_path: Path) -> tuple[bool, str, dict[str, Any]]:
    """Return (cache_hit, current_diff_hash, cached_payload)."""
    diff_hash = hashlib.sha256(diff_path.read_bytes()).hexdigest()

    try:
        previous_body = previous_path.read_text()
    except OSError:
        return (False, diff_hash, {})

    payload = extract_payload(previous_body)
    if payload.get("diffHash") != diff_hash:
        return (False, diff_hash, {})

    findings = payload.get("findings")
    if not isinstance(findings, list) or any(
        not isinstance(f, dict) or "severity" not in f for f in findings
    ):
        return (False, diff_hash, {})

    return (True, diff_hash, payload)


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Review-cache check on the bounded diff."
    )
    parser.add_argument("--diff", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument(
        "--findings-out",
        type=Path,
        required=True,
        help="Where to write the cached payload on a hit (untouched on a miss).",
    )
    args = parser.parse_args()

    hit, diff_hash, payload = check(args.diff, args.previous)
    if hit:
        args.findings_out.write_text(json.dumps(payload, indent=2))
        sys.stderr.write(
            "cache_check: HIT — LLM review will be skipped, gate re-applies stored findings\n"
        )
    else:
        sys.stderr.write("cache_check: miss — full review runs\n")
    print(f"cache_hit={'true' if hit else 'false'}")
    print(f"diff_hash={diff_hash}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
