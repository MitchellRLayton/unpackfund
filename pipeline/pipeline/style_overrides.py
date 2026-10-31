"""Where a fund's peer group comes from, in one place.

The rule engine (:mod:`pipeline.style`) is the source of truth. A generated override
(:mod:`pipeline.style_jev`) can only fill a gap the rules left — never overwrite a rule
hit. That precedence is the whole safety argument for having a model in the loop at all:

* delete ``overrides/style_jev.csv`` and the site returns to exactly what the rules say;
* add a rule that reads one of the overridden names and the rule wins, the override goes
  stale, and ``style_jev fill`` reports it as stale instead of the two disagreeing
  silently;
* a malformed row is skipped with a counter, never raised — a bad CSV line must not take
  the build down, it must make one fund fall back to issuer links.

Both page-building call sites go through :func:`resolve`, so the fund index and the fund
page can never disagree about which bucket a fund is in.
"""

from __future__ import annotations

import csv
from pathlib import Path

from .style import Style, classify

#: The committed override file. Generated offline, reviewed, and read at build time.
DEFAULT_PATH = Path(__file__).resolve().parent.parent / "overrides" / "style_jev.csv"

#: The token recorded in ``Style.matched`` for a model-read bucket. Visible in the page's
#: peer-group heading and enough for a reviewer to see the row did not come from a rule.
ORIGIN = "JEV"

_cache: dict[tuple[str, int], dict[str, Style]] = {}
_skipped: dict[str, int] = {"rows": 0, "bad": 0}


def load(path: Path | None = None) -> dict[str, Style]:
    """The overrides keyed by filed name, re-read only when the file changes."""
    target = Path(path) if path is not None else DEFAULT_PATH
    try:
        stamp = target.stat().st_mtime_ns
    except FileNotFoundError:
        return {}
    key = (str(target), stamp)
    if key in _cache:
        return _cache[key]

    rows: dict[str, Style] = {}
    bad = 0
    with target.open(newline="", encoding="utf-8") as handle:
        lines = (line for line in handle if not line.startswith("#"))
        for row in csv.DictReader(lines):
            name = (row.get("name") or "").strip()
            if not name or not (row.get("key") or "").strip():
                bad += 1
                continue
            try:
                rows[name] = Style(
                    key=row["key"].strip(),
                    label=(row.get("label") or row["key"]).strip(),
                    group=(row.get("group") or "").strip(),
                    region=(row.get("region") or "").strip() or None,
                    size=(row.get("size") or "").strip() or None,
                    style=(row.get("style") or "").strip() or None,
                    theme=(row.get("theme") or "").strip() or None,
                    matched=(ORIGIN,),
                )
            except KeyError:
                bad += 1
    _skipped["rows"] = len(rows) + bad
    _skipped["bad"] = bad
    _cache[key] = rows
    return rows


def skipped() -> dict[str, int]:
    """Counters from the last load: how many rows were read, and how many were not."""
    return dict(_skipped)


def resolve(name: str, issuer: str = "", path: Path | None = None) -> Style | None:
    """The bucket for a fund: rules first, override only when the rules return nothing."""
    style = classify(name, issuer)
    if style is not None:
        return style
    return load(path).get(name)
