"""The expense ratio a fund's prospectus states, per share class — T-0052 phase 1.

Source: the ``oef`` XBRL tags in a registrant's 485BPOS / 497 filings, which is the only
place the SEC publishes a fee as data. Three elements matter, matched by **local name**
under whatever ``http://xbrl.sec.gov/oef/<year>`` namespace the filing declares:

* ``ExpensesOverAssets`` — the total (gross) annual fund operating expense;
* ``NetExpensesOverAssets`` — the figure after fee waivers, when the filer tagged one;
* ``FeeWaiverOrReimbursementOverAssets`` — the waiver itself. Its sign is **not** fixed:
  most filers write a negative number, some a positive reduction, and one family writes a
  positive *recoupment* (net = total + waiver).

What this module will not do, taken from the skill ``fund-reference-extraction`` and from
the phase 0 measurement (``docs/01-research/2026-11-25-net-expense-ratio-coverage.md``):

* **never compute net.** A net the filing does not state is ``None``; gross minus waiver
  is a number inferred from another field, and a waiver's sign cannot be trusted to do it;
* **never rescale.** A fee outside ``[0, 10%)`` is a filer's scale error (FCTE tags 0.89
  for 0.89%); the class publishes no fee, it is not divided by 100;
* **never pick between disagreeing facts.** A class whose contexts disagree is
  ``ambiguous`` and its value is dropped;
* **never pass an old fee off as current.** A newer fee filing that cannot be read
  withholds every fee the walk then finds in an older one.

The facts are keyed by ``(series, class)``, and the match has four shapes, because filers
differ: exact; class axis with no series axis (T. Rowe Price); a single-series registrant
with no series axis at all; and series-level facts with no class axis. A ``ClassAxis``
member that is not a ``C…`` id is **not** "no class axis" (GARIX tags its class as its
series id) and must never answer through the series-level match.

All HTTP goes through ``sec`` (User-Agent, ≤8 req/s, retry, byte cache), so a rerun
reads the cache and costs nothing.
"""

from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from . import sec, xbrl

#: Filings whose fee table the oef taxonomy tags. 485BPOS is the effective registration
#: statement; a 497 can restate the fee table in a supplement.
FEE_FORMS = ("485BPOS", "497")

OEF_PREFIX = "http://xbrl.sec.gov/oef/"

#: oef local name → our field name.
ELEMENTS = {
    "ExpensesOverAssets": "total",
    "NetExpensesOverAssets": "net",
    "FeeWaiverOrReimbursementOverAssets": "waiver",
}

_SERIES = re.compile(r"S\d{9}")
_CLASS = re.compile(r"C\d{9}")
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")

#: Two values closer than this are the same fee (the facts carry 4 decimals).
EPS = 5e-5

#: A fact whose text is not a number. Kept apart from nil: "not stated" and "could not
#: read" are different findings.
UNREADABLE = "unreadable"

#: The validator's bounds, one definition. Total and net are in ``[0, FEE_CEILING)``; the
#: waiver may carry either sign and its size is bounded by the same ceiling.
FEE_CEILING = 0.10
#: Net may exceed total by at most this, unless a stated positive waiver reconciles it.
NET_OVER_TOTAL = 1e-4
#: Float slop for the comparisons above: 0.0123 + 0.0001 is not exactly 0.0124 in binary, and a
#: boundary the filing states to four decimals must not flip on the last bit.
_SLOP = 1e-9

#: A fund must update its prospectus within 16 months (Securities Act §10(a)(3)), so a fee
#: table older than ~18 months is stale by definition and the walk stops there.
LOOKBACK_DAYS = 548
#: Release review reports a fee read from a filing older than this (info, not a gate).
STALE_DAYS = 396

#: ``basis`` — what the filing says about a waiver. Display rules live with the page.
BASIS_STATED_NET = "stated-net"
BASIS_NO_WAIVER = "no-waiver-stated"
BASIS_WAIVER_NO_NET = "waiver-without-net"
BASIS_WAIVER_UNRESOLVED = "waiver-unresolved"
BASES = (BASIS_STATED_NET, BASIS_NO_WAIVER, BASIS_WAIVER_NO_NET, BASIS_WAIVER_UNRESOLVED)

#: The keys of a published class row, in document order.
ROW_KEYS = (
    "class_id",
    "total",
    "net",
    "waiver",
    "basis",
    "prospectus_date",
    "filed_at",
    "form",
    "source_url",
)

FACT_KEY = tuple[str | None, str | None]


# --- parsing one filing -------------------------------------------------------


@dataclass
class ClassFees:
    """Every value one share class's contexts carry, per field."""

    values: dict[str, set] = field(default_factory=lambda: defaultdict(set))

    def add(self, name: str, value: float | str | None) -> None:
        self.values[name].add(value)

    def resolved(self, name: str) -> tuple[str, float | None]:
        """``(state, value)``: ``absent`` · ``nil`` · ``unreadable`` · ``ok`` · ``ambiguous``."""
        seen = self.values.get(name)
        if not seen:
            return "absent", None
        numbers = sorted(v for v in seen if isinstance(v, float))
        if UNREADABLE in seen:
            return ("ambiguous" if numbers else "unreadable"), None
        if not numbers:
            return "nil", None
        if numbers[-1] - numbers[0] > EPS:
            return "ambiguous", None
        return "ok", numbers[0]


@dataclass
class Filing:
    """What one filing's tags say: the fee facts and the prospectus date, if unique."""

    facts: dict[FACT_KEY, ClassFees]
    prospectus_date: str | None = None


def _member(dims: Iterable[tuple[str, str]], axis: str, pattern: re.Pattern) -> str | None:
    for dimension, member in dims:
        if dimension.endswith(axis):
            found = pattern.search(member)
            if found:
                return found.group(0)
    return None


def _class_key(dims: Iterable[tuple[str, str]]) -> str | None:
    """The ``C…`` id, ``None`` when the context has no ``ClassAxis`` at all, and
    ``?<member>`` when it has one that is not a class id.

    The last case must not collapse into ``None``: a series-level key answers for any
    class of the series through the ``series`` match, and a mis-tagged member is not
    evidence about every class.
    """
    for dimension, member in dims:
        if dimension.endswith("ClassAxis"):
            found = _CLASS.search(member)
            return found.group(0) if found else f"?{member}"
    return None


def _inline_value(element: ET.Element) -> float | None:
    if element.get(xbrl.XSI_NIL) == "true":
        return None
    fmt = (element.get("format") or "").lower().replace("-", "")
    if fmt.endswith("fixedzero"):
        # "None" or "—" in the fee table, tagged as a zero.
        return 0.0
    if fmt.endswith(("numcommadecimal", "numspacecomma", "numcommaspace")):
        # "0,05" is a decimal comma there; xbrl.number would read it as 5, a 100x error.
        return None
    value = xbrl.number(
        "".join(element.itertext()),
        scale=xbrl.scale(element),
        negative=(element.get("sign") or "").strip() == "-",
    )
    return None if value is None else round(value, 8)


def parse_filing(xml_bytes: bytes) -> Filing:
    """Every oef fee fact in an instance or an Inline XBRL document.

    ``None`` in a key means the context has no such axis: a single-series registrant
    omits ``LegalEntityAxis``, a single-class series may omit ``ClassAxis``. Raises
    ``ET.ParseError`` on a document that is not XML; the caller counts it.
    """
    root = ET.fromstring(xml_bytes)
    dims_by_context = {
        identifier: context.pairs for identifier, context in xbrl.contexts(root).items()
    }
    found: dict[FACT_KEY, ClassFees] = defaultdict(ClassFees)
    prospectus: set[str] = set()
    for element in root.iter():
        namespace, local = xbrl.split(element.tag)
        if local == "nonFraction":
            # Inline XBRL: the concept is the ``name`` attribute, and the text is the
            # displayed figure — ``0.40`` with ``scale="-2"`` is 0.0040.
            prefix, _, concept = (element.get("name") or "").rpartition(":")
            name = ELEMENTS.get(concept) if "oef" in prefix.lower() else None
            if name is None:
                continue
            value = _inline_value(element)
            if value is None and element.get(xbrl.XSI_NIL) != "true":
                value = UNREADABLE
        elif local == "nonNumeric":
            prefix, _, concept = (element.get("name") or "").rpartition(":")
            if concept == "ProspectusDate" and "oef" in prefix.lower():
                prospectus.add("".join(element.itertext()).strip())
            continue
        else:
            if local == "ProspectusDate" and namespace.startswith(OEF_PREFIX):
                prospectus.add((element.text or "").strip())
                continue
            name = ELEMENTS.get(local)
            if name is None or not namespace.startswith(OEF_PREFIX):
                continue
            if element.get(xbrl.XSI_NIL) == "true":
                value = None
            else:
                try:
                    value = float((element.text or "").strip())
                except ValueError:
                    value = UNREADABLE
        dims = dims_by_context.get((element.get("contextRef") or "").strip(), ())
        key = (_member(dims, "LegalEntityAxis", _SERIES), _class_key(dims))
        found[key].add(name, value)
    # An inline filing writes the date the way a reader sees it ("April 29, 2026"), and a
    # filing with several prospectus documents carries several dates: publish a date only
    # when it is one ISO date, never a guess.
    dates = {text for text in prospectus if _ISO_DATE.fullmatch(text)}
    return Filing(dict(found), next(iter(dates)) if len(dates) == 1 and len(prospectus) == 1 else None)


def parse_instance(xml_bytes: bytes) -> dict[FACT_KEY, ClassFees]:
    """``(series_id, class_id) → ClassFees`` — the facts alone."""
    return parse_filing(xml_bytes).facts


def fees_for(
    facts: Mapping[FACT_KEY, ClassFees], series_id: str, class_id: str | None
) -> tuple[str, ClassFees | None]:
    """The facts for one class: ``(match, fees)``.

    ``match`` says how the class was found — ``class`` (exact series and class),
    ``class-no-series`` (class axis only), ``series`` (series-level facts, no class
    axis), ``series-single-class`` (the series has one class in the filing and the
    published class is unknown) — or ``none``.
    """
    if class_id and (series_id, class_id) in facts:
        return "class", facts[(series_id, class_id)]
    if class_id and (None, class_id) in facts:
        return "class-no-series", facts[(None, class_id)]
    if (series_id, None) in facts:
        return "series", facts[(series_id, None)]
    in_series = [key for key in facts if key[0] == series_id and key[1] and not key[1].startswith("?")]
    if len(in_series) == 1 and class_id is None:
        return "series-single-class", facts[in_series[0]]
    return "none", None


def series_in(facts: Mapping[FACT_KEY, ClassFees]) -> set[str | None]:
    return {key[0] for key, fees in facts.items() if fees.values.get("total")}


def classes_without_series(facts: Mapping[FACT_KEY, ClassFees]) -> set[str]:
    """Classes tagged with a total but no ``dei:LegalEntityAxis`` member."""
    return {
        key[1]
        for key, fees in facts.items()
        if key[0] is None and key[1] and not key[1].startswith("?") and fees.values.get("total")
    }


# --- the rules a published fee must satisfy -----------------------------------


def _over(value: float, bound: float) -> bool:
    """``value > bound``, with the float slop that a 4-decimal fact needs."""
    return value > bound + _SLOP


def is_recoupment(total: float | None, net: float | None, waiver: float | None) -> bool:
    """Net above total because a positive waiver (a recoupment) is stated and reconciles."""
    return (
        None not in (total, net, waiver)
        and waiver > EPS
        and not _over(abs(total + waiver - net), NET_OVER_TOTAL)
    )


def refusal(total: float | None, net: float | None, waiver: float | None) -> str | None:
    """Why a class publishes no fee, or ``None``. The build and the validator share this."""
    for name, value in (("total", total), ("net", net)):
        if value is not None and not 0 <= value < FEE_CEILING:
            return f"{name}-out-of-range"
    recoupment = is_recoupment(total, net, waiver)
    if waiver is not None:
        if abs(waiver) >= FEE_CEILING:
            return "waiver-out-of-range"
        # A waiver cannot take back more than the fund charges: a 100x scale error on a waiver
        # (0.04 for 0.04%) passes the ceiling above and is caught here. Never rescaled.
        if total is not None and _over(abs(waiver), total) and not recoupment:
            return "waiver-out-of-range"
    if net is not None and total is not None:
        # The 1 bp tolerance is for rounding between independent facts. A stated waiver that cannot
        # raise a fee (zero or negative) leaves no room for net above total at all (LYRIX: total
        # 0.98%, net 0.99%, waiver -0.02%).
        no_markup = waiver is not None and waiver <= EPS
        if _over(net, total + (0.0 if no_markup else NET_OVER_TOTAL)) and not recoupment:
            return "net-above-total"
        # The filing states "no waiver" and a lower net in the same breath (USBNX: net 0 beside a
        # 1.35% total and a waiver of -0): two facts that disagree, so neither is published.
        if waiver is not None and abs(waiver) <= EPS and _over(total - net, NET_OVER_TOTAL):
            return "net-contradicts-waiver"
    return None


def headline(row: Mapping[str, Any]) -> float | None:
    """The figure investors pay per the prospectus: net when stated, else the total."""
    net = row.get("net")
    return net if net is not None else row.get("total")


def basis_for(net: tuple[str, float | None], waiver: tuple[str, float | None]) -> str:
    """What the filing says about a waiver, from the resolved states of its two facts.

    An ambiguous or unreadable net is **not** "no waiver stated" (phase 0 re-check N2):
    the filer may well have stated one, and "no fee waiver stated" on the page would
    contradict the filing.
    """
    net_state, _ = net
    waiver_state, waiver_value = waiver
    if net_state == "ok":
        return BASIS_STATED_NET
    if net_state in ("ambiguous", "unreadable") or waiver_state in ("ambiguous", "unreadable"):
        return BASIS_WAIVER_UNRESOLVED
    if waiver_state == "ok" and waiver_value is not None and abs(waiver_value) > EPS:
        return BASIS_WAIVER_NO_NET
    return BASIS_NO_WAIVER


def basis_problem(net: float | None, waiver: float | None, basis: str) -> str | None:
    """Why ``basis`` contradicts the row's own numbers, or ``None``. The validator uses this.

    ``waiver-unresolved`` says the filing's own facts could not be read, which the numbers
    cannot contradict; the other three each say something checkable about net and waiver.
    """
    if basis == BASIS_STATED_NET:
        return None if net is not None else "stated-net without a net"
    if net is not None:
        return f"{basis!r} on a row that states net={net!r}"
    stated_waiver = waiver is not None and abs(waiver) > EPS
    if basis == BASIS_NO_WAIVER and stated_waiver:
        return f"no-waiver-stated beside waiver={waiver!r}"
    if basis == BASIS_WAIVER_NO_NET and not stated_waiver:
        return f"waiver-without-net with waiver={waiver!r}"
    return None


# --- the walk -----------------------------------------------------------------


@dataclass(frozen=True)
class Want:
    """One share class we want a fee for: a ticker the SEC lists for a published series."""

    ticker: str
    series_id: str
    class_id: str | None


#: Why a wanted class has no fee. Every band is counted in the release summary, so a
#: change in coverage is a changed number, never a silently thinner page.
BANDS = (
    "no-fee-filing",
    "no-xbrl-filing",
    "series-not-tagged",
    "class-not-in-filing",
    "class-unknown",
    "walk-cap",
    "newer-filing-unread",
    "total-absent",
    "registrant-unavailable",
)


@dataclass
class RegistrantResult:
    rows: dict[str, dict] = field(default_factory=dict)
    """ticker → the row to publish."""
    bands: dict[str, str] = field(default_factory=dict)
    """ticker → why it has no row (a band, or a refusal reason)."""
    stats: Counter = field(default_factory=Counter)


def _instance_facts(cik: int, row: Mapping[str, Any]) -> tuple[Filing | None, str, str | None]:
    """The filing's fee facts, where they came from, and the document's URL.

    A filing flagged XBRL with no ``*_htm.xml`` beside it is Inline XBRL only, and its
    primary document carries the facts. ``index.json`` can list an instance that EDGAR
    does not serve (an iShares 485BPOS 404s), so the inline primary is the fallback.
    """
    directory = sec.filing_dir_url(cik, str(row.get("accessionNumber") or ""))
    index = sec.fetch_json(directory + "index.json")
    items = xbrl.index_items(index) if isinstance(index, dict) else []
    name = xbrl.instance_name(items)
    primary = xbrl.primary_name(items, dict(row)) if row.get("isInlineXBRL") else None
    if name is not None:
        try:
            return parse_filing(sec.fetch(directory + name)), "instance", directory + name
        except sec.SecError:
            if primary is None:
                raise
            return parse_filing(sec.fetch(directory + primary)), "inline-fallback", directory + primary
    if primary is not None:
        return parse_filing(sec.fetch(directory + primary)), "inline", directory + primary
    return None, "none", None


def _fee_rows(rows: Iterable[Mapping[str, Any]], since: str, filed_by: str) -> list[dict]:
    """Fee-form rows filed in ``[since, filed_by]``, newest first.

    ``filed_by`` is the release's own date: a release may only state what had been filed
    when it was built, so rebuilding it later cannot change a fee (point-in-time on
    ``filed``). The phase 0 probe had no upper bound, and 410 of its covered fees came
    from filings dated after its release.
    """
    picked = [
        dict(r)
        for r in rows
        if r.get("form") in FEE_FORMS and since <= str(r.get("filingDate") or "") <= filed_by
    ]
    picked.sort(key=lambda r: (str(r.get("filingDate") or ""), str(r.get("accessionNumber"))), reverse=True)
    return picked


def _older_page(name: str) -> list[dict]:
    """One of ``filings.files``: the same columns as ``recent``, without the wrapper."""
    page = sec.fetch_json(f"https://data.sec.gov/submissions/{name}")
    return xbrl.recent_rows({"filings": {"recent": page}})


def _row(want: Want, filing: Filing, fees: ClassFees, row: Mapping[str, Any], url: str | None) -> tuple[dict | None, str | None]:
    """The class row to publish, or ``(None, reason)``. Values are fractions."""
    states = {name: fees.resolved(name) for name in ELEMENTS.values()}
    if states["total"][0] != "ok":
        return None, "total-absent" if states["total"][0] in ("absent", "nil") else f"total-{states['total'][0]}"
    total, net, waiver = (states[name][1] for name in ("total", "net", "waiver"))
    why = refusal(total, net, waiver)
    if why is not None:
        return None, why
    return {
        "class_id": want.class_id,
        "total": total,
        "net": net,
        "waiver": waiver,
        "basis": basis_for(states["net"], states["waiver"]),
        "prospectus_date": filing.prospectus_date,
        "filed_at": str(row.get("filingDate") or ""),
        "form": str(row.get("form") or ""),
        "source_url": url,
    }, None


def registrant_fees(
    cik: int,
    wants: Sequence[Want],
    *,
    filed_by: str,
    since: str,
    max_filings: int = 150,
    max_pages: int = 3,
    series_count: int | None = None,
) -> RegistrantResult:
    """Walk one registrant's fee filings newest-first until every wanted class has one.

    ``recent`` holds at most about a year for a busy trust (iShares: 2,522 filings), and
    an annual prospectus can sit just before it, so older pages are read — lazily, only
    while a class is still unmatched — up to ``max_pages``. Nothing filed before
    ``since`` is read.

    ``series_count`` is how many series the SEC ticker file lists for this registrant,
    published or not. A filing with no series axis is credited to the wanted series only
    when that count is 1: counting just the published series (the default, for callers that
    have nothing better) would hand an unpublished sibling's fee to the published one.
    """
    result = RegistrantResult()
    stats = result.stats
    submissions = sec.fetch_json(sec.submissions_url(cik), max_age=sec.INDEX_MAX_AGE_S)
    rows = _fee_rows(xbrl.recent_rows(submissions), since, filed_by)
    older = [
        f["name"]
        for f in (submissions.get("filings") or {}).get("files", [])
        if f.get("name") and str(f.get("filingTo") or "9999") >= since
    ]
    xbrl_rows = [r for r in rows if r.get("isXBRL") or r.get("isInlineXBRL")]

    pending = {w.ticker: w for w in wants if w.series_id}
    # A filing with no series axis belongs to the wanted series only when it is the registrant's
    # one series *and* the only series wanted: either alone is not enough (a count of 1 with two
    # wanted series would give both the same undimensioned fee).
    wanted_series = len({w.series_id for w in wants})
    single_series = wanted_series == 1 and (series_count is None or series_count == 1)
    partial: dict[str, str] = {}
    walked = position = pages_read = 0
    # The newest fee filing we could not read. The walk is newest-first, so every fee
    # matched after it comes from an older filing and is withheld, never passed as current.
    unread: str | None = None
    while pending and walked < max_filings:
        if position >= len(xbrl_rows):
            if pages_read >= min(max_pages, len(older)):
                break
            page_rows = _fee_rows(_older_page(older[pages_read]), since, filed_by)
            pages_read += 1
            rows.extend(page_rows)
            xbrl_rows.extend(r for r in page_rows if r.get("isXBRL") or r.get("isInlineXBRL"))
            continue
        row = xbrl_rows[position]
        position += 1
        walked += 1
        try:
            filing, basis, url = _instance_facts(cik, row)
        except (sec.SecError, ET.ParseError) as error:
            stats["filing_errors"] += 1
            stats[f"error:{type(error).__name__}"] += 1
            unread = unread or str(row.get("accessionNumber"))
            continue
        if filing is None:
            stats["xbrl_flag_but_no_document"] += 1
            unread = unread or str(row.get("accessionNumber"))
            continue
        stats[f"read_{basis}"] += 1
        tagged = series_in(filing.facts)
        # Some trusts (T. Rowe Price) tag the class axis with no series axis at all, so a
        # filing whose series list lacks the fund can still carry its class.
        class_only = classes_without_series(filing.facts)
        for ticker, want in list(pending.items()):
            if want.series_id in tagged or (want.class_id and want.class_id in class_only):
                key_series: str | None = want.series_id
            elif single_series and tagged == {None}:
                key_series = None
            else:
                continue
            _match, fees = fees_for(filing.facts, key_series, want.class_id)
            if fees is None:
                # The series is in this filing but not the wanted class. Keep walking: an
                # older filing may be the class's own prospectus.
                partial.setdefault(ticker, "class-unknown" if want.class_id is None else "class-not-in-filing")
                continue
            if unread is not None:
                result.bands[ticker] = "newer-filing-unread"
                del pending[ticker]
                continue
            published, why = _row(want, filing, fees, row, url)
            if published is None:
                result.bands[ticker] = why or "total-absent"
            else:
                result.rows[ticker] = published
            del pending[ticker]
    stats["filings_walked"] = walked
    stats["older_pages_read"] = pages_read
    stats["fee_filings"] = len(rows)
    history_left = position < len(xbrl_rows) or pages_read < len(older)

    for ticker in pending:
        if ticker in partial:
            result.bands[ticker] = partial[ticker]
        elif not rows:
            result.bands[ticker] = "no-fee-filing"
        elif not xbrl_rows:
            result.bands[ticker] = "no-xbrl-filing"
        elif unread is not None:
            result.bands[ticker] = "newer-filing-unread"
        elif history_left:
            # Stopped by the walk cap with history unread: not a finding about the fund.
            result.bands[ticker] = "walk-cap"
        else:
            result.bands[ticker] = "series-not-tagged"
    return result


# --- the release -------------------------------------------------------------


@dataclass
class ReleaseFees:
    """Every fee the release states, and the account of every class that has none."""

    by_series: dict[str, dict[str, dict]] = field(default_factory=dict)
    """series_id → ticker → row."""
    missing: dict[str, str] = field(default_factory=dict)
    """ticker → the band that says why it has no row."""
    stats: Counter = field(default_factory=Counter)
    classes_wanted: int = 0
    overridden: int = 0
    unavailable: list[int] = field(default_factory=list)

    @property
    def classes_found(self) -> int:
        return sum(len(rows) for rows in self.by_series.values())

    @property
    def bands(self) -> Counter:
        return Counter(self.missing.values())


def lookback_start(filed_by: str) -> str:
    return (date.fromisoformat(filed_by) - timedelta(days=LOOKBACK_DAYS)).isoformat()


def collect(
    wants_by_cik: Mapping[int, Sequence[Want]],
    *,
    filed_by: str,
    workers: int = 1,
    log: Callable[[str], None] | None = None,
    overrides: Mapping[str, Mapping[str, Any]] | None = None,
    series_counts: Mapping[int, int] | None = None,
) -> ReleaseFees:
    """Walk every registrant and gather its classes' fees.

    A registrant whose filing index cannot be read is counted as ``registrant-unavailable``
    and its classes publish no fee: a fee is a display fact, and one trust's outage must
    not cost the release its funds. Anything other than a SEC fetch or parse failure is a
    bug and propagates.
    """
    since = lookback_start(filed_by)
    release = ReleaseFees()

    def one(cik: int) -> tuple[int, RegistrantResult | None]:
        try:
            return cik, registrant_fees(
                cik,
                wants_by_cik[cik],
                filed_by=filed_by,
                since=since,
                series_count=(series_counts or {}).get(cik),
            )
        except (sec.SecError, ET.ParseError):
            return cik, None

    ciks = sorted(wants_by_cik)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for done, (cik, found) in enumerate(pool.map(one, ciks), start=1):
            if log and done % 200 == 0:
                log(f"fees: {done:,}/{len(ciks):,} registrants")
            wanted = wants_by_cik[cik]
            release.classes_wanted += len(wanted)
            if found is None:
                release.unavailable.append(cik)
                release.missing.update({want.ticker: "registrant-unavailable" for want in wanted})
                continue
            release.stats.update(found.stats)
            for want in wanted:
                row = found.rows.get(want.ticker)
                if row is None:
                    release.missing[want.ticker] = found.bands.get(want.ticker, "series-not-tagged")
                else:
                    release.by_series.setdefault(want.series_id, {})[want.ticker] = row
    if overrides:
        apply_overrides(release, wants_by_cik, overrides)
    return release


#: The bands where the filings did not speak at all, the only holes a reviewed row may fill.
#: A refusal (a range error, an ambiguous total), a nil total, an unread newer filing and an
#: unreachable registrant are the filings' answer, or a transient one: an override must not
#: paper over any of them.
OVERRIDE_FILLS = ("no-fee-filing", "no-xbrl-filing", "series-not-tagged")
#: The skill's bound on the override file, as a share of the classes wanted.
OVERRIDE_SHARE = 0.05
#: A build of a handful of tickers (``--tickers``, a fixture) may carry a few overrides whatever
#: the share says; the bound is for the universe.
OVERRIDE_FLOOR = 10


def apply_overrides(
    release: ReleaseFees,
    wants_by_cik: Mapping[int, Sequence[Want]],
    overrides: Mapping[str, Mapping[str, Any]],
) -> None:
    """Reviewed rows for classes the filings cannot answer (SPY: a unit trust with no XBRL).

    An override only fills a hole the filings left open (``OVERRIDE_FILLS``): a class the
    filings answered keeps the filing's fee, and a class they refused or could not be read
    for stays without one, so a reviewed row can never outlive or mask the filing's own word.
    More overrides than ``OVERRIDE_SHARE`` of the classes wanted stops the build: the file
    would have become the pipeline (fund-reference-extraction §2.4).
    """
    wanted = {want.ticker: want for group in wants_by_cik.values() for want in group}
    if len(overrides) > max(OVERRIDE_FLOOR, OVERRIDE_SHARE * len(wanted)):
        raise ValueError(
            f"{len(overrides)} fee overrides exceed {OVERRIDE_SHARE:.0%} of {len(wanted)} classes wanted"
        )
    for ticker, row in overrides.items():
        want = wanted.get(ticker)
        if want is None or release.missing.get(ticker) not in OVERRIDE_FILLS:
            continue
        release.by_series.setdefault(want.series_id, {})[ticker] = dict(row)
        release.missing.pop(ticker, None)
        release.overridden += 1


def document_fees(rows: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """The ``fees`` object of a fund document: classes in ticker order, keys in contract order."""
    return {"classes": {ticker: {key: rows[ticker].get(key) for key in ROW_KEYS} for ticker in sorted(rows)}}


# --- the reviewed override file ------------------------------------------------

OVERRIDES = Path(__file__).resolve().parent.parent / "overrides" / "fees.csv"
OVERRIDE_COLUMNS = ("ticker", *ROW_KEYS)


def load_overrides(path: Path = OVERRIDES) -> dict[str, dict]:
    """ticker → a reviewed row. ``#`` lines are comments; a malformed row stops the build.

    The same rules as a row read from a filing: a number outside its range, a basis outside
    the enum, or a row without ``filed_at`` and an https SEC ``source_url`` is refused, so
    the override file cannot be the way a bad fee gets in. The skill bounds this file at 5%
    of the universe; one row is the whole of it today.
    """
    if not path.exists():
        return {}
    body = "\n".join(line for line in path.read_text().splitlines() if not line.lstrip().startswith("#"))
    out: dict[str, dict] = {}
    for record in csv.DictReader(io.StringIO(body)):
        ticker = (record.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        if ticker in out:
            raise ValueError(f"{path.name}: {ticker} appears twice")
        row: dict[str, Any] = {key: (record.get(key) or "").strip() or None for key in ROW_KEYS}
        for name in ("total", "net", "waiver"):
            if row[name] is not None:
                try:
                    row[name] = round(float(row[name]), 8)
                except ValueError as error:
                    raise ValueError(f"{path.name}: {ticker}.{name} is not a number") from error
        if row["total"] is None:
            raise ValueError(f"{path.name}: {ticker} has no total")
        why = refusal(row["total"], row["net"], row["waiver"])
        if why is not None:
            raise ValueError(f"{path.name}: {ticker} refused: {why}")
        if row["basis"] not in BASES:
            raise ValueError(f"{path.name}: {ticker}.basis {row['basis']!r} is not one of {BASES}")
        if not row["filed_at"] or not _ISO_DATE.fullmatch(row["filed_at"]):
            raise ValueError(f"{path.name}: {ticker}.filed_at is required (YYYY-MM-DD)")
        if not str(row["source_url"] or "").startswith("https://www.sec.gov/"):
            raise ValueError(f"{path.name}: {ticker}.source_url must be an https SEC URL")
        out[ticker] = row
    return out
