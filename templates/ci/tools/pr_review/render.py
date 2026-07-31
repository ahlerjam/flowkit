"""Render findings.json to sticky Markdown PR-Comment with embedded JSON marker."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

OPEN_MARKER = "<!-- flowkit-review:v1 -->"
JSON_MARKER_OPEN = "<!-- flowkit-review-json:v1"
JSON_MARKER_CLOSE = "-->"

# A file that keeps producing blocking findings across this many consecutive
# review rounds gets a visible convergence hint (the gate itself is untouched).
CONVERGENCE_THRESHOLD = 3


def extract_prev_payload(previous_body: str) -> dict[str, Any]:
    """Parse the embedded JSON payload from a previous sticky comment.

    Fail-safe: any parse problem returns an empty dict.
    """
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


def extract_prev_file_rounds(previous_body: str) -> dict[str, int]:
    """Parse the per-file round counter from a previous sticky comment.

    Fail-safe: any parse problem returns an empty dict (the counter resets,
    the warning is lost for one round, the gate is never affected).
    """
    rounds = extract_prev_payload(previous_body).get("fileRounds")
    if not isinstance(rounds, dict):
        return {}
    out: dict[str, int] = {}
    for key, value in rounds.items():
        if isinstance(key, str) and isinstance(value, int) and value > 0:
            out[key] = value
    return out


def find_marker_in_body(body: str) -> bool:
    """Return True if body contains the sticky-comment marker.

    Used by the update path to locate existing comments.
    """
    return OPEN_MARKER in body


def _format_finding(f: dict[str, Any]) -> str:
    loc = f"`{f['file']}`" if f.get("file") else "(no file)"
    if f.get("line"):
        loc += f":{f['line']}"
    cat = f["category"]
    title = f["title"]
    evidence = f["evidence"]
    rec = f.get("recommendation")
    reviewer = f.get("source_reviewer", "unknown")

    out = [f"- **[{cat}]** {loc} — {title}", f"  - Evidence: {evidence}"]
    if rec:
        out.append(f"  - Recommendation: {rec}")
    out.append(f"  - Reviewer: `{reviewer}`")
    return "\n".join(out)


def render_sticky_comment(
    payload: dict[str, Any],
    previous_body: str = "",
    diff_hash: str | None = None,
    cached: bool = False,
) -> str:
    """Render findings.json to human + machine-readable Markdown comment.

    Carries a per-file counter of consecutive rounds with blocking (P0/P1)
    findings across renders via the embedded JSON marker; files at or above
    CONVERGENCE_THRESHOLD get a visible operator hint.

    ``diff_hash`` is stored in the embedded JSON so cache_check.py can skip
    the LLM review when a later run sees a byte-identical diff. ``cached``
    marks such a run: the round counter is carried over UNCHANGED (an
    identical diff is not a new review round) and the comment says the
    review was reused.

    Raises:
        ValueError: if any finding is missing 'severity' field.
    """
    findings = payload["findings"]

    # Defensive: validate severity field on all findings
    for f in findings:
        if "severity" not in f:
            title = f.get("title", "(untitled)")
            raise ValueError(
                f"Finding missing 'severity' field: {title}. All findings must have severity (P0/P1/P2)."
            )

    by_sev = {
        "P0": [f for f in findings if f["severity"] == "P0"],
        "P1": [f for f in findings if f["severity"] == "P1"],
        "P2": [f for f in findings if f["severity"] == "P2"],
    }

    prev_rounds = extract_prev_file_rounds(previous_body) if previous_body else {}
    if cached:
        # Identical diff, review reused — no new round has happened.
        file_rounds = prev_rounds
    else:
        blocking_files = sorted(
            {
                f["file"]
                for f in findings
                if f["severity"] in ("P0", "P1") and f.get("file")
            }
        )
        file_rounds = {name: prev_rounds.get(name, 0) + 1 for name in blocking_files}
    payload = dict(payload)
    if diff_hash:
        payload["diffHash"] = diff_hash
    if file_rounds:
        payload["fileRounds"] = file_rounds
    else:
        payload.pop("fileRounds", None)
    convergence = [(n, c) for n, c in file_rounds.items() if c >= CONVERGENCE_THRESHOLD]

    lines: list[str] = [
        OPEN_MARKER,
        "## flowkit PR Deep Review",
        "",
        f"- **P0 (Block):** {len(by_sev['P0'])}",
        f"- **P1 (Must fix):** {len(by_sev['P1'])}",
        f"- **P2 (Backlog):** {len(by_sev['P2'])}",
        "",
    ]

    if cached:
        lines.append(
            "> :recycle: **Review reused:** the diff is byte-identical to the last "
            "reviewed version (base update only) — LLM review skipped, gate "
            "re-applied to the stored findings."
        )
        lines.append("")

    if convergence:
        parts = "; ".join(
            f"`{name}` carries P0/P1 findings for {count} consecutive review rounds"
            for name, count in convergence
        )
        lines.append(
            f"> :warning: **Convergence alert:** {parts}. "
            "Operator review recommended — repeated rounds on the same artifact "
            "suggest the review is chasing an unreachable ideal or the fix "
            "approach needs a rethink. The gate stays fully active."
        )
        lines.append("")

    if not findings:
        lines.append("No findings — clean review.")
    else:
        if by_sev["P0"]:
            lines.append("### P0 Findings")
            for f in by_sev["P0"]:
                lines.append(_format_finding(f))
                lines.append("")
        if by_sev["P1"]:
            lines.append("### P1 Findings")
            for f in by_sev["P1"]:
                lines.append(_format_finding(f))
                lines.append("")
        if by_sev["P2"]:
            lines.append("<details>")
            lines.append(
                f"<summary>P2 ({len(by_sev['P2'])} findings) — click to expand</summary>"
            )
            lines.append("")
            for f in by_sev["P2"]:
                lines.append(_format_finding(f))
                lines.append("")
            lines.append("</details>")
            lines.append("")

    json_inline = json.dumps(payload, separators=(",", ":"))
    lines.append(f"{JSON_MARKER_OPEN} {json_inline} {JSON_MARKER_CLOSE}")
    return "\n".join(lines)


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Render findings.json to PR-comment Markdown."
    )
    parser.add_argument("findings", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--previous",
        type=Path,
        default=None,
        help="File containing the body of the existing sticky comment (optional).",
    )
    parser.add_argument(
        "--diff-hash",
        default=None,
        help="sha256 of the bounded diff; stored in the embedded JSON for the review cache.",
    )
    parser.add_argument(
        "--cached",
        action="store_true",
        help="This run reused the stored findings (identical diff): no round increment, reuse note in the comment.",
    )
    args = parser.parse_args()

    previous_body = ""
    if args.previous is not None and args.previous.exists():
        previous_body = args.previous.read_text()

    payload = json.loads(args.findings.read_text())
    args.output.write_text(
        render_sticky_comment(
            payload,
            previous_body=previous_body,
            diff_hash=args.diff_hash,
            cached=args.cached,
        )
    )
    sys.stderr.write(f"Wrote sticky comment to {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
