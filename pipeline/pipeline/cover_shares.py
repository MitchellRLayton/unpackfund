"""The cover-page share count: how many common shares a filer says it has out.

Market cap is ``implied share price × shares``, and the only share count the SEC
publishes for a *company* — as opposed to a fund — is the one on the cover page of
its 10-K or 10-Q: ``dei:EntityCommonStockSharesOutstanding``. It is not a single
number in ``companyfacts``, because a multi-class issuer files one fact per class:
Alphabet files three, Meta two, Berkshire two, and Visa three where one of the
three is a *subtotal* of the other two. So the number a market cap needs is a sum
over classes, and the sum is only right if the subtotal is dropped.

Two document shapes carry the fact, and both are read here:

* an **XBRL instance** (``*_htm.xml``), where each fact is a text node with a
  ``contextRef`` and the context says whether it is dimensioned by share class;
* **Inline XBRL** (the primary ``.htm``), where the fact is an
  ``<ix:nonFraction>`` element whose value is display text — ``1,234`` with a
  ``scale`` and a ``sign`` — and the contexts live in the same document.

The rules, in the order they matter:

1. An undimensioned fact is the total and wins outright; several of them are
   resolved by date, latest first.
2. Otherwise the class facts are summed on one date, deduplicated by context.
3. A class fact within 1% of the sum of the others *and* larger than each of them
   is a subtotal of those others, not a class, and is dropped. Visa's
   ``CommonClassB1AndB2`` beside ``CommonClassB1`` and ``CommonClassB2`` is the
   measured case; summing all three overstates the count by the B-class total.
4. Anything that is not a plausible share count — non-finite, non-positive,
   ≥1e14, or ≤1e5 — is refused rather than published.

Nothing here caches: ``sec.fetch`` already keeps a byte cache keyed by URL, and a
second layer would be a second thing to invalidate.
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from . import sec, xbrl

#: The dei element that carries the cover-page count, matched on its local name.
DEI_FACT = "EntityCommonStockSharesOutstanding"

#: Forms whose cover page states the count. Amendments (``10-K/A``) and
#: notifications of late filing (``NT 10-K``) are deliberately absent: an
#: amendment may restate one item and leave the cover page stale, and an NT form
#: has no cover page at all.
COVER_FORMS = ("10-K", "10-Q")

BASIS_INSTANCE = "instance"
BASIS_INLINE = "inline"

#: How close a class fact must be to the sum of the others to be read as their
#: subtotal. One percent absorbs the rounding a filer applies to a combined line.
SUBTOTAL_TOLERANCE = 0.01

#: Sanity bounds. A share count outside these is a parse defect, not a company.
MAX_SHARES = 1e14
MIN_SHARES = 1e5

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class CoverShares:
    """One filer's latest cover-page count, ready for a market-cap calculation."""

    cik: int
    shares: float
    """Total common shares outstanding, every class summed."""
    as_of: str
    """``YYYY-MM-DD``, the context end date of the facts that were used."""
    classes: int
    """How many class facts were summed — 1 for a single-class filer."""
    basis: str
    """``"instance"`` for an XBRL instance document, ``"inline"`` for Inline XBRL."""


# --- the two document shapes ------------------------------------------------


@dataclass(frozen=True)
class _Fact:
    value: float
    date: str
    dims: tuple[str, ...]


def _is_dei_fact_name(name: str | None) -> bool:
    """Whether an Inline XBRL ``name`` attribute is the dei fact.

    The prefix is not fixed: it is ``dei`` in every filing seen, but the namespace
    it binds to is versioned by year, so the test is the local name plus ``dei``
    appearing in the prefix rather than a hard-coded QName.
    """
    if not name:
        return False
    prefix, _, local = name.rpartition(":")
    return local == DEI_FACT and "dei" in prefix.lower()


def _facts(root: ET.Element, contexts: dict[str, xbrl.Context]) -> tuple[list[_Fact], str]:
    """Every dei share-count fact in the document, plus which shape it came from."""
    facts: list[_Fact] = []
    inline = False
    for element in root.iter():
        namespace, local = xbrl.split(element.tag)
        if local == "nonFraction":
            inline = True
            if not _is_dei_fact_name(element.get("name")):
                continue
            value = xbrl.number(
                "".join(element.itertext()),
                scale=xbrl.scale(element),
                negative=(element.get("sign") or "").strip() == "-",
            )
        elif local == DEI_FACT and "dei" in namespace.lower():
            value = xbrl.number("".join(element.itertext()))
        else:
            continue
        if value is None or value <= 0:
            continue
        context = contexts.get((element.get("contextRef") or "").strip())
        if context is None:
            continue
        facts.append(_Fact(value=value, date=context.date, dims=context.dims))
    return facts, (BASIS_INLINE if inline else BASIS_INSTANCE)


# --- picking the number -----------------------------------------------------


def _majority_date(facts: Sequence[_Fact]) -> str:
    """The date most facts agree on, latest winning a tie.

    A cover page states one date; a document that carries two is a restatement or
    a stale fact left behind, and the majority is the period the filing is about.
    """
    counts = Counter(fact.date for fact in facts)
    return max(counts, key=lambda date: (counts[date], date))


def _dedupe(facts: Sequence[_Fact]) -> list[_Fact]:
    """One fact per context: two contexts with the same dimensions are one class."""
    seen: set[tuple[str, ...]] = set()
    kept: list[_Fact] = []
    for fact in facts:
        if fact.dims in seen:
            continue
        seen.add(fact.dims)
        kept.append(fact)
    return kept


def _drop_subtotal(facts: Sequence[_Fact]) -> list[_Fact]:
    """Drop a class fact that is the sum of the others rather than a class.

    Visa publishes ``CommonClassB1AndB2`` beside ``CommonClassB1`` and
    ``CommonClassB2``; summing all three counts the B shares twice. The subtotal is
    the only fact that is both larger than every other and equal to their sum, so
    that is the test — and only one fact can satisfy it, because two facts cannot
    each be the sum of the other.
    """
    if len(facts) < 2:
        return list(facts)
    for index, fact in enumerate(facts):
        others = [other for position, other in enumerate(facts) if position != index]
        total = sum(other.value for other in others)
        if total <= 0:
            continue
        if fact.value > max(other.value for other in others) and (
            abs(fact.value - total) <= SUBTOTAL_TOLERANCE * total
        ):
            return others
    return list(facts)


def _select(facts: Sequence[_Fact]) -> tuple[float, str, int] | None:
    """The count, its date, and how many facts it was built from."""
    undimensioned = [fact for fact in facts if not fact.dims]
    if undimensioned:
        date = max(fact.date for fact in undimensioned)
        chosen = [fact for fact in undimensioned if fact.date == date]
        return chosen[0].value, date, 1
    date = _majority_date(facts)
    chosen = _dedupe([fact for fact in facts if fact.date == date])
    if not chosen:
        return None
    kept = _drop_subtotal(chosen)
    return sum(fact.value for fact in kept), date, len(kept)


def _plausible(shares: float) -> bool:
    return math.isfinite(shares) and MIN_SHARES < shares < MAX_SHARES


def parse_cover(xml_bytes: bytes) -> tuple[float, str, int, str] | None:
    """Parse one XBRL instance or Inline XBRL document.

    Returns ``(shares, as_of, classes, basis)`` or ``None``. Pure function, no
    network: this is what the offline tests exercise.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return None
    contexts = xbrl.contexts(root)
    facts, basis = _facts(root, contexts)
    if not facts:
        return None
    selected = _select(facts)
    if selected is None:
        return None
    shares, as_of, classes = selected
    if not _plausible(shares) or not _DATE.fullmatch(as_of):
        return None
    return shares, as_of, classes, basis


# --- the filing that carries it ---------------------------------------------


def _latest_cover_filing(submissions: dict) -> dict | None:
    """The newest 10-K or 10-Q row, by filing date then accession."""
    best: dict | None = None
    best_key = ("", "")
    for row in xbrl.recent_rows(submissions):
        if str(row.get("form") or "").strip() not in COVER_FORMS:
            continue
        accession = str(row.get("accessionNumber") or "").strip()
        if not accession:
            continue
        key = (str(row.get("filingDate") or ""), accession)
        if best is None or key > best_key:
            best, best_key = row, key
    return best


def _cover(cik: int, parsed: tuple[float, str, int, str]) -> CoverShares:
    shares, as_of, classes, basis = parsed
    return CoverShares(
        cik=int(cik), shares=shares, as_of=as_of, classes=classes, basis=basis
    )


def latest_cover_shares(cik: int) -> CoverShares | None:
    """Latest 10-K/10-Q cover-page share count for a filer, or ``None``.

    Never raises on a bad/stale/odd filing: return ``None`` and let the caller
    record the company as unplaced. Network errors from ``sec.fetch`` may
    propagate as ``sec.SecError`` — the caller catches them per company.
    """
    submissions = sec.fetch_json(sec.submissions_url(cik), max_age=sec.INDEX_MAX_AGE_S)
    if not isinstance(submissions, dict):
        return None
    filing = _latest_cover_filing(submissions)
    if filing is None:
        return None
    accession = str(filing.get("accessionNumber") or "").strip()
    if not accession:
        return None

    directory = sec.filing_dir_url(cik, accession)
    index = sec.fetch_json(directory + "index.json")
    items = xbrl.index_items(index) if isinstance(index, dict) else []

    instance = xbrl.instance_name(items)
    if instance is not None:
        parsed = parse_cover(sec.fetch(directory + instance))
        if parsed is not None:
            return _cover(cik, parsed)

    # No instance, or an instance that states no count: the primary document is
    # the same filing in Inline XBRL, so it is the fallback rather than a second
    # source.
    primary = xbrl.primary_name(items, filing)
    if primary is None:
        return None
    parsed = parse_cover(sec.fetch(directory + primary))
    return _cover(cik, parsed) if parsed is not None else None
