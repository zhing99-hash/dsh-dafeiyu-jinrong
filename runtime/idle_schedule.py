"""Daily wall-clock targets for the idle countdown.

Pure Python so the schedule can be tested without Qt or a running Helper. The
default targets are the two A-share session landmarks requested for the pet;
labels are free text and every target repeats daily.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta
from typing import Iterable

DEFAULT_TARGETS = ((9, 30, "开盘"), (15, 30, "收盘"))
_TARGET_RE = re.compile(r"^\s*(\d{1,2})\s*:\s*(\d{2})\s*(.*)$")
_SPLIT_RE = re.compile(r"[,，;；\n]+")


def _normalise(time_text: str, label: str) -> tuple[int, int, str] | None:
    match = _TARGET_RE.match(time_text)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    target_label = (match.group(3) or label or "目标").strip() or "目标"
    return hour, minute, target_label[:20]


def parse_targets(raw: object) -> list[tuple[int, int, str]]:
    """Parse ``09:30 开盘, 15:30 收盘`` or a list of ``{time,label}`` entries.

    ``None`` keeps the shipped defaults; an explicitly empty string disables
    the countdown. Invalid entries are skipped.
    """
    if raw is None:
        return list(DEFAULT_TARGETS)
    entries: list[object]
    if isinstance(raw, (list, tuple)):
        entries = list(raw)
    else:
        text = str(raw).strip()
        if not text:
            return []
        entries = [part for part in _SPLIT_RE.split(text) if part.strip()]
    targets: list[tuple[int, int, str]] = []
    for entry in entries:
        if isinstance(entry, dict):
            time_text = str(entry.get("time") or "")
            label = str(entry.get("label") or "")
            parsed = _normalise(time_text, label)
        else:
            text = str(entry).strip()
            time_match = re.match(r"^(\d{1,2}\s*:\s*\d{2})\s*(.*)$", text)
            if not time_match:
                continue
            parsed = _normalise(time_match.group(1), time_match.group(2))
        if parsed and parsed not in targets:
            targets.append(parsed)
    if not targets and entries:
        # A non-empty but malformed setting should not silently disable the
        # feature for someone who typed a full-width colon or a stray suffix.
        return list(DEFAULT_TARGETS)
    return targets


def next_target(
    targets: Iterable[tuple[int, int, str]],
    now: datetime,
) -> tuple[datetime, str] | None:
    """Return the earliest target strictly after ``now`` (today or tomorrow)."""
    options: list[tuple[datetime, str]] = []
    for day in (0, 1):
        date = (now + timedelta(days=day)).date()
        for hour, minute, label in targets:
            candidate = datetime.combine(date, datetime.min.time()).replace(
                hour=hour, minute=minute
            )
            if candidate > now:
                options.append((candidate, label))
    if not options:
        return None
    return min(options, key=lambda item: item[0])


def format_remaining(seconds: float) -> str:
    """``H:MM:SS`` above an hour, ``MM:SS`` below it; rounds up."""
    total = max(0, int(math.ceil(float(seconds))))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def countdown_text(label: str, seconds: float) -> str:
    return f"{label}倒计时 {format_remaining(seconds)}"
