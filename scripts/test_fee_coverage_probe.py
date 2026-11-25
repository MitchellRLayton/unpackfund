"""The fee probe's own logic — the walk and the report — on hand-written instances (no network).

Parsing and the fee rules are ``pipeline.fees`` and are tested in ``pipeline/tests/test_fees.py``.

    .venv/pipeline/bin/python -m pytest -q scripts/test_fee_coverage_probe.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fee_coverage_probe as probe  # noqa: E402

S1, S2 = "S000000001", "S000000002"
A, B, C = "C000000011", "C000000012", "C000000021"


def _context(cid: str, series: str | None, cls: str | None, doc: str | None = None) -> str:
    members = []
    if series:
        members.append(f'<xbrldi:explicitMember dimension="dei:LegalEntityAxis">x:{series}Member</xbrldi:explicitMember>')
    if cls:
        members.append(f'<xbrldi:explicitMember dimension="oef:ClassAxis">x:{cls}Member</xbrldi:explicitMember>')
    if doc:
        members.append(f'<xbrldi:explicitMember dimension="dei:DocumentInformationDocumentAxis">x:{doc}</xbrldi:explicitMember>')
    return (
        f'<context id="{cid}"><entity><identifier scheme="http://www.sec.gov/CIK">1</identifier>'
        f'<segment>{"".join(members)}</segment></entity>'
        f"<period><startDate>2026-01-01</startDate><endDate>2026-01-01</endDate></period></context>"
    )


INSTANCE = f"""<?xml version="1.0"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:oef="http://xbrl.sec.gov/oef/2025"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xmlns:other="http://example.com/2026">
  {_context("a1", S1, A, "d1")}
  {_context("a2", S1, A, "d2")}
  {_context("b1", S1, B, "d1")}
  {_context("b2", S1, B, "d2")}
  {_context("c1", S2, C)}
  <oef:ExpensesOverAssets contextRef="a1" unitRef="pure" decimals="4">0.0090</oef:ExpensesOverAssets>
  <oef:ExpensesOverAssets contextRef="a2" unitRef="pure" decimals="4">0.0090</oef:ExpensesOverAssets>
  <oef:FeeWaiverOrReimbursementOverAssets contextRef="a1" unitRef="pure" decimals="4">-0.0015</oef:FeeWaiverOrReimbursementOverAssets>
  <oef:NetExpensesOverAssets contextRef="a1" unitRef="pure" decimals="4">0.0075</oef:NetExpensesOverAssets>
  <oef:ExpensesOverAssets contextRef="b1" unitRef="pure" decimals="4">0.0050</oef:ExpensesOverAssets>
  <oef:ExpensesOverAssets contextRef="b2" unitRef="pure" decimals="4">0.0060</oef:ExpensesOverAssets>
  <oef:ExpensesOverAssets contextRef="c1" unitRef="pure" decimals="4">0.0003</oef:ExpensesOverAssets>
  <oef:NetExpensesOverAssets contextRef="c1" xsi:nil="true"/>
  <other:ExpensesOverAssets contextRef="c1" unitRef="pure" decimals="4">0.9999</other:ExpensesOverAssets>
</xbrl>
""".encode()


def test_summary_rates_by_count_and_by_assets():
    def result(ticker, assets, band, **kw):
        return probe.Result(ticker=ticker, series_id="S", class_id=None, cik=1, net_assets=assets,
                            etf=True, name=ticker, band=band, **kw)

    results = [
        result("BIG", 900.0, "no-xbrl-filing"),
        result("W", 60.0, "covered", total=0.009, net=0.0075, waiver=-0.0015,
               total_state="ok", net_state="ok", waiver_state="ok"),
        result("P", 40.0, "covered", total=0.0003, total_state="ok", net_state="nil"),
    ]
    summary = probe.summarise(results)
    assert summary["total_stated"] == {"funds": 2, "of_funds": 3, "pct_funds": 66.7, "pct_assets": 10.0}
    assert summary["net_tagged"]["pct_assets"] == 6.0
    assert summary["net_differs_from_total"]["funds"] == 1
    assert summary["waiver_sign"] == {"negative": 1}
    assert summary["largest_uncovered"][0]["ticker"] == "BIG"


CLASS_ONLY = f"""<?xml version="1.0"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:oef="http://xbrl.sec.gov/oef/2025"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
  {_context("k1", None, A)}
  <oef:ExpensesOverAssets contextRef="k1" unitRef="pure" decimals="4">0.0049</oef:ExpensesOverAssets>
</xbrl>
""".encode()


def test_a_class_tagged_without_its_series_is_still_found(monkeypatch):
    facts = probe.parse_instance(CLASS_ONLY)
    assert probe.series_in(facts) == {None}
    assert probe.classes_without_series(facts) == {A}
    monkeypatch.setattr(probe, "_fetch", lambda url, **kw: {"filings": {"recent": {}, "files": []}})
    monkeypatch.setattr(probe.xbrl, "recent_rows", lambda sub: [
        {"form": "485BPOS", "filingDate": "2026-07-27", "accessionNumber": "x", "isXBRL": 1}])
    monkeypatch.setattr(probe, "_instance_facts", lambda cik, row: (facts, "instance"))
    funds = [probe.Fund("AAA", S1, A, 1, 10.0, False, "a"), probe.Fund("BBB", S2, C, 1, 10.0, False, "b")]
    results, _ = probe.probe_registrant(1, funds, 10)
    by = {r.ticker: r for r in results}
    assert by["AAA"].band == "covered" and by["AAA"].match == "class-no-series" and by["AAA"].total == 0.0049
    assert by["BBB"].band != "covered"


def _walk(monkeypatch, filings):
    """Drive probe_registrant over ``filings``: a list of (accession, facts-or-exception)."""
    rows = [{"form": "485BPOS", "filingDate": f"2026-0{9 - i}-01", "accessionNumber": acc, "isXBRL": 1}
            for i, (acc, _) in enumerate(filings)]
    by_acc = dict(filings)

    def facts(cik, row):
        got = by_acc[row["accessionNumber"]]
        if isinstance(got, Exception):
            raise got
        return got, "instance"

    monkeypatch.setattr(probe, "_fetch", lambda url, **kw: {"filings": {"recent": {}, "files": []}})
    monkeypatch.setattr(probe.xbrl, "recent_rows", lambda sub: rows)
    monkeypatch.setattr(probe, "_instance_facts", facts)


def test_a_newer_filing_that_cannot_be_read_flags_the_older_fee(monkeypatch):
    _walk(monkeypatch, [("new", probe.sec.SecError("HTTP 404")), ("old", probe.parse_instance(INSTANCE))])
    (result,), stats = probe.probe_registrant(1, [probe.Fund("AAA", S1, A, 1, 1.0, False, "a")], 10)
    assert result.band == "covered" and result.accession == "old"
    assert result.newer_filing_unread == "new"
    assert stats["filing_errors"] == 1
