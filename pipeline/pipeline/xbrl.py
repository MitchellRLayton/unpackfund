"""Reading an SEC filing's XBRL: the pieces every fact reader shares.

Two modules read tagged facts out of EDGAR filings — ``cover_shares`` (the cover-page
share count of a 10-K) and ``fees`` (the expense ratio in a 485BPOS) — and both start
the same way: ask the filing directory which file carries the tags, then read either
the stacked instance (``*_htm.xml``) or the Inline XBRL primary document, whose
``ix:nonFraction`` elements carry a *displayed* number with a ``scale`` and a ``sign``.
That part is here once (AGENTS.md: code is DRY); what each module does with the facts
is theirs.

Nothing here fetches. ``sec.fetch`` already keeps a byte cache keyed by URL, and a
second layer would be a second thing to invalidate.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from dataclasses import dataclass

#: ``xsi:nil`` — a fact the filer tagged but gave no value. Not zero.
XSI_NIL = "{http://www.w3.org/2001/XMLSchema-instance}nil"


def split(tag: str) -> tuple[str, str]:
    """``{namespace}local`` → ``(namespace, local)``; a bare tag has no namespace."""
    if tag.startswith("{"):
        namespace, _, local = tag[1:].partition("}")
        return namespace, local
    return "", tag


@dataclass(frozen=True)
class Context:
    """What a fact's context says: when it was true, and which members it names."""

    date: str
    pairs: tuple[tuple[str, str], ...]
    """``(dimension, member)`` in document order; empty means undimensioned."""

    @property
    def dims(self) -> tuple[str, ...]:
        """Sorted ``dimension=member`` strings, the form a set comparison wants."""
        return tuple(sorted(f"{dimension}={member}" for dimension, member in self.pairs))


def contexts(root: ET.Element) -> dict[str, Context]:
    """Every ``xbrli:context`` in the document, keyed by its id.

    Inline XBRL keeps its contexts in an ``<ix:header>`` inside the same HTML, so one
    walk serves both shapes.
    """
    found: dict[str, Context] = {}
    for element in root.iter():
        _, local = split(element.tag)
        if local != "context":
            continue
        identifier = (element.get("id") or "").strip()
        if not identifier:
            continue
        found[identifier] = Context(date=_date(element), pairs=_pairs(element))
    return found


def _date(element: ET.Element) -> str:
    """The period end: ``endDate`` for a duration, ``instant`` for a point in time."""
    instant = ""
    for child in element.iter():
        _, local = split(child.tag)
        if local == "endDate":
            return (child.text or "").strip()
        if local == "instant" and not instant:
            instant = (child.text or "").strip()
    return instant


def _pairs(element: ET.Element) -> tuple[tuple[str, str], ...]:
    members: list[tuple[str, str]] = []
    for child in element.iter():
        _, local = split(child.tag)
        if local not in ("explicitMember", "typedMember"):
            continue
        members.append(((child.get("dimension") or "").strip(), (child.text or "").strip()))
    return tuple(members)


def number(text: str, *, scale: int = 0, negative: bool = False) -> float | None:
    """A displayed number as a float: commas and spaces out, ``scale`` applied.

    Inline XBRL writes the value the way a reader sees it — ``1,234`` with
    ``scale="6"`` meaning 1,234,000,000 — so the display text is not the number.
    """
    cleaned = "".join(text.replace(",", "").replace(" ", " ").split())
    if not cleaned:
        return None
    try:
        value = float(cleaned)
    except ValueError:
        return None
    if scale:
        try:
            value *= 10.0**scale
        except OverflowError:
            return None
    if negative:
        value = -value
    return value if math.isfinite(value) else None


def scale(element: ET.Element) -> int:
    try:
        return int((element.get("scale") or "").strip())
    except ValueError:
        return 0


# --- the filing directory ----------------------------------------------------


def recent_rows(submissions: dict) -> list[dict]:
    """``filings.recent`` as rows — EDGAR serves it column-oriented."""
    recent = (submissions.get("filings") or {}).get("recent") or {}
    columns = {name: values for name, values in recent.items() if isinstance(values, list)}
    if not columns:
        return []
    return [dict(zip(columns, values)) for values in zip(*columns.values())]


def index_items(document: dict) -> list[dict]:
    """The filing directory's file list, from ``index.json``."""
    directory = document.get("directory")
    if not isinstance(directory, dict):
        return []
    items = directory.get("item")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and item.get("name")]


def instance_name(items: Sequence[dict]) -> str | None:
    """The XBRL instance document, if the filing has one.

    Two labels name the same file: the ``*_htm.xml`` name EDGAR gives it, and the
    ``XBRL INSTANCE`` / ``EX-101.INS`` type it is filed under. ``index.json`` can list
    an instance that EDGAR does not serve (an iShares 485BPOS 404s on its own), so a
    caller that needs the facts falls back to ``primary_name``.
    """
    for item in items:
        name = str(item.get("name") or "")
        kind = str(item.get("type") or "").strip().lower()
        if name.lower().endswith("_htm.xml") or "xbrl instance" in kind or kind == "ex-101.ins":
            return name
    return None


def primary_name(items: Sequence[dict], filing: dict) -> str | None:
    """The primary ``.htm`` document: the one the submission names, else the first."""
    names = [str(item.get("name") or "") for item in items]
    wanted = str(filing.get("primaryDocument") or "").strip()
    if wanted and wanted in names:
        return wanted
    for name in names:
        if name.lower().endswith((".htm", ".html")):
            return name
    return None
