"""The N-PORT index window, tested offline.

Regression for 2026-11-17.1, which published 9,277 funds after dropping 47 — 41 of them
from EA Series Trust (CIK 1592900). The index walked the newest three *periods*, on the
stated assumption that "a trust files one N-PORT per series for the same period". That
assumption holds only while every series in a trust shares a fiscal year. EA Series Trust
staggered year-ends across eighteen `reportDate` values, so three periods covered a third
of its series and the rest were reported as closed funds:

    NoFilingError: FRDM: series 'S000065423' has no N-PORT filing in the newest 1159
    filings of CIK 0001592900 — closed fund or money-market fund

FRDM is neither. It is an active ETF whose newest N-PORT simply sat outside the window.
"""

from __future__ import annotations

from pipeline import filings


def _row(accession: str, report: str, filed: str) -> dict:
    return {
        "accessionNumber": accession,
        "form": "NPORT-P",
        "reportDate": report,
        "filingDate": filed,
    }


def _staggered_trust() -> list[dict]:
    """Six monthly periods, one series each — a trust with staggered year-ends."""
    rows = []
    periods = [
        ("2026-09-30", "2026-11-10"),
        ("2026-08-31", "2026-10-12"),
        ("2026-07-31", "2026-09-11"),
        ("2026-06-30", "2026-08-12"),
        ("2026-05-29", "2026-07-13"),
        ("2026-04-30", "2026-06-11"),
    ]
    for index, (report, filed) in enumerate(periods):
        rows.append(_row(f"0001592900-26-{index:06d}", report, filed))
    return rows


def test_a_series_outside_the_three_period_window_is_still_found(monkeypatch):
    rows = _staggered_trust()
    # The sixth period's series is the one FRDM was: four periods back, invisible to a
    # three-period walk.
    by_accession = {
        row["accessionNumber"]: f"S00000000{index}" for index, row in enumerate(rows)
    }

    monkeypatch.setattr(filings, "candidates", lambda cik: rows)
    monkeypatch.setattr(filings.sec, "primary_doc_url", lambda cik, acc: f"u:{acc}")
    monkeypatch.setattr(filings.sec, "fetch", lambda url: url.encode())
    monkeypatch.setattr(filings, "peek_series_id", lambda doc: by_accession[doc.decode()[2:]])
    filings._SERIES_INDEX.clear()
    filings._ACCESSION_SERIES.clear()

    wanted = "S000000005"  # the oldest period's series
    refs = [
        filings.universe.FundRef(
            ticker="FRDM", cik="0001592900", series_id=wanted, resolved_by="test"
        )
    ]

    found = filings.index_registrant("0001592900", refs)

    assert filings._SERIES_INDEX[("0001592900", wanted)][0] == "0001592900-26-000005"
    assert found == len(rows), "the walk reads every period only because it had to"


def test_the_walk_stops_as_soon_as_every_series_is_known(monkeypatch):
    rows = _staggered_trust()
    by_accession = {
        row["accessionNumber"]: f"S00000000{index}" for index, row in enumerate(rows)
    }
    monkeypatch.setattr(filings, "candidates", lambda cik: rows)
    monkeypatch.setattr(filings.sec, "primary_doc_url", lambda cik, acc: f"u:{acc}")
    monkeypatch.setattr(filings.sec, "fetch", lambda url: url.encode())
    monkeypatch.setattr(filings, "peek_series_id", lambda doc: by_accession[doc.decode()[2:]])
    filings._SERIES_INDEX.clear()
    filings._ACCESSION_SERIES.clear()

    # The newest period's series: one document is enough, and the budget is not spent on
    # the four periods a staggered trust would otherwise cost.
    refs = [
        filings.universe.FundRef(
            ticker="AAAA", cik="0001592900", series_id="S000000000", resolved_by="test"
        )
    ]

    assert filings.index_registrant("0001592900", refs) == 1


def test_a_series_with_nothing_in_the_whole_history_still_raises(monkeypatch):
    rows = _staggered_trust()
    monkeypatch.setattr(filings, "candidates", lambda cik: rows)
    monkeypatch.setattr(filings.sec, "primary_doc_url", lambda cik, acc: f"u:{acc}")
    monkeypatch.setattr(filings.sec, "fetch", lambda url: url.encode())
    monkeypatch.setattr(filings, "peek_series_id", lambda doc: "S000000001")
    filings._SERIES_INDEX.clear()
    filings._ACCESSION_SERIES.clear()

    refs = [
        filings.universe.FundRef(
            ticker="GONE", cik="0001592900", series_id="S999999999", resolved_by="test"
        )
    ]
    filings.index_registrant("0001592900", refs)

    try:
        filings.resolve(refs[0])
    except filings.NoFilingError as error:
        assert "S999999999" in str(error)
    else:  # pragma: no cover - the assertion above is the point
        raise AssertionError("a series with no filing must not resolve")
