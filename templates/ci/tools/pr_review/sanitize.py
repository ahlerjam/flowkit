"""Sanitizer for log bundles + fuzzer findings."""

from __future__ import annotations

import re

# Snapshot of patterns formerly in tools/log_watcher/claude_analyze.py
# (deleted 2026-05-17 in Claude-Code-Strategie cleanup).
_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]+"),
    re.compile(r"(?i)(?:api[_-]?key|token|password|secret)\s*[=:]\s*[^\s\"\']+"),
    re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        re.DOTALL,
    ),
]


def sanitize_text(text: str) -> str:
    """Apply every regex in :data:`_SECRET_PATTERNS` to ``text`` with a single ``[REDACTED]`` token."""
    for pat in _SECRET_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text
