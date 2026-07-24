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


def render_sticky_comment(payload: dict[str, Any]) -> str:
    """Render findings.json to human + machine-readable Markdown comment.

    Raises:
        ValueError: if any finding is missing 'severity' field.
    """
    findings = payload["findings"]

    # Defensive: validate severity field on all findings
    for f in findings:
        if "severity" not in f:
            title = f.get("title", "(untitled)")
            raise ValueError(f"Finding missing 'severity' field: {title}. All findings must have severity (P0/P1/P2).")

    by_sev = {
        "P0": [f for f in findings if f["severity"] == "P0"],
        "P1": [f for f in findings if f["severity"] == "P1"],
        "P2": [f for f in findings if f["severity"] == "P2"],
    }

    lines: list[str] = [
        OPEN_MARKER,
        "## flowkit PR Deep Review",
        "",
        f"- **P0 (Block):** {len(by_sev['P0'])}",
        f"- **P1 (Must fix):** {len(by_sev['P1'])}",
        f"- **P2 (Backlog):** {len(by_sev['P2'])}",
        "",
    ]

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
            lines.append(f"<summary>P2 ({len(by_sev['P2'])} findings) — click to expand</summary>")
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
    parser = argparse.ArgumentParser(description="Render findings.json to PR-comment Markdown.")
    parser.add_argument("findings", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    payload = json.loads(args.findings.read_text())
    args.output.write_text(render_sticky_comment(payload))
    sys.stderr.write(f"Wrote sticky comment to {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
