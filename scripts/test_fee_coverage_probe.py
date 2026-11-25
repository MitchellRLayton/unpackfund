"""The fee probe's instance parser, on a hand-written instance (no network).

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


def test_waived_class_keeps_net_and_waiver_as_stated():
    facts = probe.parse_instance(INSTANCE)
    match, fees = probe.fees_for(facts, S1, A)
    assert match == "class"
    assert fees.resolved("total") == ("ok", 0.009)
    assert fees.resolved("net") == ("ok", 0.0075)
    assert fees.resolved("waiver") == ("ok", -0.0015)


def test_documents_that_disagree_are_ambiguous_not_picked():
    facts = probe.parse_instance(INSTANCE)
    _, fees = probe.fees_for(facts, S1, B)
    assert fees.resolved("total") == ("ambiguous", None)
    assert fees.resolved("net") == ("absent", None)


def test_nil_is_not_zero_and_other_namespaces_are_ignored():
    facts = probe.parse_instance(INSTANCE)
    _, fees = probe.fees_for(facts, S2, C)
    assert fees.resolved("total") == ("ok", 0.0003)
    assert fees.resolved("net") == ("nil", None)


def test_unknown_class_matches_only_a_single_class_series():
    facts = probe.parse_instance(INSTANCE)
    assert probe.fees_for(facts, S2, None)[0] == "series-single-class"
    assert probe.fees_for(facts, S1, None) == ("none", None)
    assert probe.fees_for(facts, S1, "C000000099") == ("none", None)


INLINE = f"""<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<body><ix:header><ix:resources>
  {_context("a1", S1, A).replace("<context", "<xbrli:context").replace("</context>", "</xbrli:context>")}
</ix:resources></ix:header>
<p><ix:nonFraction name="oef:ExpensesOverAssets" contextRef="a1" unitRef="pure" scale="-2" decimals="4">0.90</ix:nonFraction>%</p>
<p><ix:nonFraction name="oef:FeeWaiverOrReimbursementOverAssets" contextRef="a1" unitRef="pure" scale="-2" sign="-">0.15</ix:nonFraction>%</p>
<p><ix:nonFraction name="oef:NetExpensesOverAssets" contextRef="a1" unitRef="pure" scale="-2">0.75</ix:nonFraction>%</p>
<p><ix:nonFraction name="us-gaap:ExpensesOverAssets" contextRef="a1" unitRef="pure" scale="-2">9.99</ix:nonFraction></p>
</body></html>
""".encode()


def test_inline_xbrl_applies_scale_and_sign():
    _, fees = probe.fees_for(probe.parse_instance(INLINE), S1, A)
    assert fees.resolved("total") == ("ok", 0.009)
    assert fees.resolved("waiver") == ("ok", -0.0015)
    assert fees.resolved("net") == ("ok", 0.0075)


def test_series_in_names_every_series_with_a_total():
    assert probe.series_in(probe.parse_instance(INSTANCE)) == {S1, S2}


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


def test_fee_rows_keep_fee_forms_inside_the_window_newest_first():
    rows = [
        {"form": "485BPOS", "filingDate": "2024-01-02", "accessionNumber": "a"},
        {"form": "497", "filingDate": "2026-03-01", "accessionNumber": "b"},
        {"form": "N-CSR", "filingDate": "2026-04-01", "accessionNumber": "c"},
        {"form": "485BPOS", "filingDate": "2026-05-01", "accessionNumber": "d"},
    ]
    picked = probe._fee_rows(rows, since="2025-05-25")
    assert [r["accessionNumber"] for r in picked] == ["d", "b"]
