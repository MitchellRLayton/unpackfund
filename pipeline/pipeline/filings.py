"""Find the newest N-PORT filing for one series.

``submissions`` gives the filing history but **not** the series: one trust files
one N-PORT per series per period, so a registrant with 50 series has 50 filings
per quarter and the only way to tell them apart is to read the document. So this
walks candidates newest-first and stops at the first whose ``genInfo/seriesId``
matches. That is one fetch per skipped sibling, cached forever afterwards.

Two shapes exist and both are handled explicitly:

* series filers — match on ``seriesId``;
* unit investment trusts (SPY) — the filing carries **no** series id, so the match
  is "no series id", and the registrant override is what makes that safe.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import sec, universe
from .nport import NportFiling, parse

NPORT_FORMS = ("NPORT-P", "NPORT-P/A")
MAX_CANDIDATES = 40


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


def _columns_to_rows(columns: dict[str, list]) -> list[dict]:
    return [dict(zip(columns, values)) for values in zip(*columns.values())]


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
    rows = [
        row
        for row in _submission_rows(cik)
        if row.get("form") in NPORT_FORMS and row.get("accessionNumber")
    ]
    rows.sort(key=lambda row: (row["filingDate"], row["accessionNumber"]), reverse=True)
    return rows


def latest(ref: universe.FundRef) -> FoundFiling:
    tried = 0
    for row in candidates(ref.cik)[:MAX_CANDIDATES]:
        tried += 1
        url = sec.primary_doc_url(ref.cik, row["accessionNumber"])
        filing = parse(sec.fetch(url))
        if ref.series_id:
            matched = filing.series_id == ref.series_id
        else:
            matched = filing.series_id is None
        if not matched:
            continue
        if filing.net_assets is None:
            raise NoFilingError(f"{ref.ticker}: {row['accessionNumber']} has no netAssets")
        return FoundFiling(
            ref=ref,
            accession=row["accessionNumber"],
            filing_date=row["filingDate"],
            report_date=filing.report_date or row.get("reportDate") or "",
            source_url=url,
            filing=filing,
        )
    raise NoFilingError(
        f"{ref.ticker}: no N-PORT filing matched series {ref.series_id!r} "
        f"in {tried} candidates for CIK {ref.cik}"
    )
