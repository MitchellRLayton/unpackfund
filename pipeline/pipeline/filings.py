"""Find the newest N-PORT filing for each series, one registrant at a time.

``submissions`` gives the filing history but **not** the series: one trust files
one N-PORT per series per period, so a registrant with 1,100 series has 1,100
filings per quarter and the only way to tell them apart is to read the document.

Day 1 did that per fund — walk the candidates newest-first, stop at the first
whose ``genInfo/seriesId`` matches — and it is fine for five tickers. It is not
fine for the universe: that walk is ``O(series × candidates)``, so a trust with
1,100 series re-reads the same 1,100 documents once per series. Day 4 therefore
resolves **per registrant, once** (:func:`prefetch`): read the newest filings
until every requested series has an accession, then build each fund from its own
document, which is already in the byte cache. One fetch per series is the floor,
and this reaches it.

Two shapes exist and both are handled explicitly:

* series filers — match on ``seriesId``;
* unit investment trusts (SPY) — the filing carries **no** series id, so the match
  is "no series id", and the registrant override is what makes that safe.
"""

from __future__ import annotations

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable, Iterable, Sequence

from . import sec, universe
from .nport import NportFiling, parse, peek_series_id

NPORT_FORMS = ("NPORT-P", "NPORT-P/A")

#: How many portfolio periods (``reportDate``) to search before calling a series
#: absent. One period is one filing per series, which is the whole window in the
#: normal case; the extra periods cover a fund that filed late or was amended two
#: quarters ago. This replaced a multiple-of-series-count guess, which had to be
#: generous to avoid missing late filers and therefore fetched three quarters for
#: every trust that holds a money-market fund.
INDEX_WINDOWS = 3

#: (cik, seriesId or "") → (accession, filingDate).
_SERIES_INDEX: dict[tuple[str, str], tuple[str, str]] = {}
#: accession → the seriesId that document declares (None for a unit investment
#: trust, which files with no series id at all).
_ACCESSION_SERIES: dict[str, str | None] = {}
#: Registrants whose whole candidate list has been read. After that, "not in the
#: index" is an answer, not a reason to walk again.
_INDEX_COMPLETE: set[str] = set()


class NoFilingError(RuntimeError):
    pass


@dataclass
class FoundFiling:
    ref: universe.FundRef
    accession: str
    filing_date: str
    report_date: str
    source_url: str
    filing: NportFiling


def _remember(cik: str, accession: str, series: str | None, filing_date: str) -> None:
    _ACCESSION_SERIES[accession] = series
    _SERIES_INDEX.setdefault((cik, series or ""), (accession, filing_date))


def _columns_to_rows(columns: dict[str, list]) -> list[dict]:
    return [dict(zip(columns, values)) for values in zip(*columns.values())]


@lru_cache(maxsize=None)
def _submission_rows_cached(cik: str) -> tuple[dict, ...]:
    return tuple(_submission_rows(cik))


def _submission_rows(cik: str) -> list[dict]:
    """Filing history as rows, from both shapes EDGAR serves.

    ``submissions/CIK…json`` puts the recent window at ``filings.recent``
    (column-oriented), while the paged ``…-submissions-00N.json`` files are
    column-oriented at the *top level* with no ``filings`` key. Both appear in the
    same API, so both are read; the paged files predate N-PORT but a matcher that
    silently skipped them would break the day the recent window rolls over.
    """
    document = sec.fetch_json(sec.submissions_url(cik))
    filings = document.get("filings") or {}
    rows = _columns_to_rows(filings.get("recent") or {})
    for extra in filings.get("files", []):
        try:
            page = sec.fetch_json(f"https://data.sec.gov/submissions/{extra['name']}")
        except sec.SecError:
            continue
        if isinstance(page.get("filings"), dict):
            rows.extend(_columns_to_rows(page["filings"].get("recent") or {}))
        else:
            rows.extend(_columns_to_rows(page))
    return rows


def candidates(cik: str) -> list[dict]:
    """The registrant's N-PORT filings, newest first — parsed and sorted once.

    A widened run builds a whole trust at a time: Vanguard's ``CIK 36405`` files
    thousands of N-PORTs per quarter, and without this cache every series re-read
    and re-sorted the same submissions document.
    """
    rows = [
        row
        for row in _submission_rows_cached(cik)
        if row.get("form") in NPORT_FORMS and row.get("accessionNumber")
    ]
    rows.sort(key=lambda row: (row["filingDate"], row["accessionNumber"]), reverse=True)
    return rows


def _windows(rows: list[dict], count: int) -> list[list[dict]]:
    """Candidates grouped into portfolio periods, newest first.

    ``reportDate`` — the period the holdings are for — is what groups a filing
    round. A trust files one N-PORT per series for the same period, so a period is
    exactly one document per series, and that is the smallest window that can hold
    a given series' newest filing. Grouping by filing date would mix two periods
    together, because funds file 45–60 days after the period ends.
    """
    periods: dict[str, list[dict]] = {}
    for row in rows:
        key = str(row.get("reportDate") or row.get("filingDate") or "")
        periods.setdefault(key, []).append(row)
    return [periods[key] for key in sorted(periods, reverse=True)[:count]]


def index_registrant(cik: str, refs: Sequence[universe.FundRef]) -> int:
    """Read this registrant's newest filings until every wanted series is known.

    The window is three quarters (``INDEX_BUDGET_FACTOR``): every fund that files
    N-PORT files it quarterly, so a series with nothing in three quarters is a
    closed fund or a money-market fund — MMFs report on N-MFP, not N-PORT, and no
    amount of walking will find an N-PORT that does not exist. Reading a trust's
    whole history to prove that costs the entire corpus for a handful of series.

    Returns how many documents that took. Callers may run several registrants at
    once: the index is keyed by CIK, so two threads only ever write their own keys.
    """
    wanted = {
        ref.series_id or ""
        for ref in refs
        if (cik, ref.series_id or "") not in _SERIES_INDEX
    }
    if not wanted:
        return 0

    fetched = 0
    for period in _windows(candidates(cik), INDEX_WINDOWS):
        for row in period:
            accession = row["accessionNumber"]
            if accession not in _ACCESSION_SERIES:
                _remember(
                    cik,
                    accession,
                    peek_series_id(sec.fetch(sec.primary_doc_url(cik, accession))),
                    row["filingDate"],
                )
                fetched += 1
            wanted.discard(_ACCESSION_SERIES[accession] or "")
            if not wanted:
                return fetched
    return fetched


def prefetch(
    refs: Iterable[universe.FundRef],
    *,
    workers: int = 8,
    progress: Callable[[str], None] | None = None,
) -> dict[str, int]:
    """Index every registrant once, before any fund is built.

    Registrants are visited largest-first: a trust with 1,100 series dominates
    the wall clock, and starting it last would leave one thread holding the tail.
    """
    by_cik: dict[str, list[universe.FundRef]] = defaultdict(list)
    for ref in refs:
        by_cik[ref.cik].append(ref)
    order = sorted(by_cik.items(), key=lambda item: (-len(item[1]), item[0]))
    if not order:
        return {"registrants": 0, "documents": 0, "largest": 0}
    def run(item: tuple[str, list[universe.FundRef]]) -> int:
        done = index_registrant(*item)
        if progress is not None:
            progress(f"  … indexed {item[0]} ({len(item[1])} series, {done} new documents)")
        return done

    if workers <= 1:
        counts = [run(item) for item in order]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            counts = list(pool.map(run, order))
    return {
        "registrants": len(order),
        "documents": sum(counts),
        "largest": len(order[0][1]),
    }


def resolve(ref: universe.FundRef) -> FoundFiling:
    """The newest indexed filing for ``ref``, read from the document cache."""
    key = (ref.cik, ref.series_id or "")
    remembered = _SERIES_INDEX.get(key)
    if remembered is None:
        index_registrant(ref.cik, [ref])
        remembered = _SERIES_INDEX.get(key)
    if remembered is None:
        total = len(candidates(ref.cik))
        raise NoFilingError(
            f"{ref.ticker}: series {ref.series_id!r} has no N-PORT filing in the "
            f"newest {total} filings of CIK {ref.cik} — closed fund or money-market "
            f"fund (MMFs report on N-MFP, never on N-PORT)"
        )

    accession, filing_date = remembered
    url = sec.primary_doc_url(ref.cik, accession)
    filing = parse(sec.fetch(url))
    if filing.net_assets is None:
        raise NoFilingError(f"{ref.ticker}: {accession} has no netAssets")
    return FoundFiling(
        ref=ref,
        accession=accession,
        filing_date=filing_date,
        report_date=filing.report_date or "",
        source_url=url,
        filing=filing,
    )


def latest(ref: universe.FundRef) -> FoundFiling:
    """Day-1 name for :func:`resolve`, kept so single-fund callers read clearly."""
    return resolve(ref)
