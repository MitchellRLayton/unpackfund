"""The stated expense ratio: parsing, the rules, the walk, and what reaches a document.

Offline throughout. Instances are written by hand in the shapes EDGAR serves them, and
the SEC client is replaced, so nothing here needs a User-Agent or a cache. The cases are
the ones phase 0 measured (``docs/01-research/2026-11-25-net-expense-ratio-coverage.md``):
each is a fund that would have shown a wrong or invented fee.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline import build, fees, review, sec, validate, xbrl

from .conftest import fund_document, write_release

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
  <oef:ProspectusDate contextRef="a1">2026-04-29</oef:ProspectusDate>
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


def _inline(*body: str) -> bytes:
    resources = _context("a1", S1, A).replace("<context", "<xbrli:context").replace("</context>", "</xbrli:context>")
    return f"""<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<body><ix:header><ix:resources>{resources}</ix:resources></ix:header>
{"".join(body)}</body></html>""".encode()


INLINE = _inline(
    '<p><ix:nonFraction name="oef:ExpensesOverAssets" contextRef="a1" unitRef="pure" scale="-2">0.90</ix:nonFraction></p>',
    '<p><ix:nonFraction name="oef:FeeWaiverOrReimbursementOverAssets" contextRef="a1" unitRef="pure" scale="-2" sign="-">0.15</ix:nonFraction></p>',
    '<p><ix:nonFraction name="oef:NetExpensesOverAssets" contextRef="a1" unitRef="pure" scale="-2">0.75</ix:nonFraction></p>',
    '<p><ix:nonFraction name="us-gaap:ExpensesOverAssets" contextRef="a1" unitRef="pure" scale="-2">9.99</ix:nonFraction></p>',
)


# --- parsing ------------------------------------------------------------------


def test_a_waived_class_keeps_net_and_waiver_as_stated():
    match, found = fees.fees_for(fees.parse_instance(INSTANCE), S1, A)
    assert match == "class"
    assert found.resolved("total") == ("ok", 0.009)
    assert found.resolved("net") == ("ok", 0.0075)
    assert found.resolved("waiver") == ("ok", -0.0015)


def test_documents_that_disagree_are_ambiguous_not_picked():
    _, found = fees.fees_for(fees.parse_instance(INSTANCE), S1, B)
    assert found.resolved("total") == ("ambiguous", None)
    assert found.resolved("net") == ("absent", None)


def test_nil_is_not_zero_and_other_namespaces_are_ignored():
    _, found = fees.fees_for(fees.parse_instance(INSTANCE), S2, C)
    assert found.resolved("total") == ("ok", 0.0003)
    assert found.resolved("net") == ("nil", None)


def test_an_unknown_class_matches_only_a_single_class_series():
    facts = fees.parse_instance(INSTANCE)
    assert fees.fees_for(facts, S2, None)[0] == "series-single-class"
    assert fees.fees_for(facts, S1, None) == ("none", None)
    assert fees.fees_for(facts, S1, "C000000099") == ("none", None)


def test_inline_xbrl_applies_scale_and_sign():
    _, found = fees.fees_for(fees.parse_instance(INLINE), S1, A)
    assert found.resolved("total") == ("ok", 0.009)
    assert found.resolved("waiver") == ("ok", -0.0015)
    assert found.resolved("net") == ("ok", 0.0075)


def test_a_fixed_zero_is_a_zero_and_decimals_inf_is_read():
    doc = _inline(
        '<ix:nonFraction name="oef:ExpensesOverAssets" contextRef="a1" decimals="INF" scale="-2">0.40</ix:nonFraction>',
        '<ix:nonFraction name="oef:FeeWaiverOrReimbursementOverAssets" contextRef="a1" format="ixt:fixed-zero">—</ix:nonFraction>',
    )
    _, found = fees.fees_for(fees.parse_instance(doc), S1, A)
    assert found.resolved("total") == ("ok", 0.004)
    assert found.resolved("waiver") == ("ok", 0.0)


def test_series_in_names_every_series_with_a_total():
    assert fees.series_in(fees.parse_instance(INSTANCE)) == {S1, S2}


CLASS_ONLY = f"""<?xml version="1.0"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:oef="http://xbrl.sec.gov/oef/2025"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
  {_context("k1", None, A)}
  <oef:ExpensesOverAssets contextRef="k1" unitRef="pure" decimals="4">0.0049</oef:ExpensesOverAssets>
</xbrl>
""".encode()

UNREAD_CLASS = f"""<?xml version="1.0"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:oef="http://xbrl.sec.gov/oef/2025"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
  {_context("g1", S1, None).replace("</segment>",
     '<xbrldi:explicitMember dimension="oef:ClassAxis">x:S000040832Member</xbrldi:explicitMember></segment>')}
  {_context("g2", S2, C)}
  <oef:ExpensesOverAssets contextRef="g1" unitRef="pure" decimals="4">0.0173</oef:ExpensesOverAssets>
  <oef:ExpensesOverAssets contextRef="g2" unitRef="pure" decimals="4">n/a</oef:ExpensesOverAssets>
</xbrl>
""".encode()


def test_a_class_tagged_without_its_series_is_still_found():
    facts = fees.parse_instance(CLASS_ONLY)
    assert fees.series_in(facts) == {None}
    assert fees.classes_without_series(facts) == {A}
    assert fees.fees_for(facts, S1, A)[0] == "class-no-series"


def test_a_class_axis_we_cannot_read_never_answers_for_a_known_class():
    facts = fees.parse_instance(UNREAD_CLASS)
    assert (S1, "?x:S000040832Member") in facts and (S1, None) not in facts
    assert fees.fees_for(facts, S1, A) == ("none", None)
    assert fees.fees_for(facts, S1, None) == ("none", None)


def test_an_unparseable_value_is_unreadable_not_nil():
    found = fees.fees_for(fees.parse_instance(UNREAD_CLASS), S2, C)[1]
    assert found.resolved("total") == ("unreadable", None)


def test_the_prospectus_date_is_published_only_when_it_is_one_iso_date():
    assert fees.parse_filing(INSTANCE).prospectus_date == "2026-04-29"
    two = INSTANCE.replace(b"</xbrl>", b'<oef:ProspectusDate contextRef="a1">2026-05-01</oef:ProspectusDate></xbrl>')
    assert fees.parse_filing(two).prospectus_date is None
    reader_text = _inline('<ix:nonNumeric name="oef:ProspectusDate" contextRef="a1">April 29, 2026</ix:nonNumeric>')
    assert fees.parse_filing(reader_text).prospectus_date is None


# --- the rules ----------------------------------------------------------------


def test_the_refusal_keeps_negative_waivers_and_recoupments_and_refuses_scale_errors():
    assert fees.refusal(0.0053, 0.0028, -0.0025) is None  # FCTDX, a waiver
    assert fees.refusal(0.0123, 0.0125, 0.0002) is None  # EPDIX, a recoupment: net = total + waiver
    assert fees.refusal(0.0001, 0.0118, None) == "net-above-total"  # FAMVX
    assert fees.refusal(0.89, 0.85, -0.0004) == "total-out-of-range"  # FCTE tags 0.89 for 0.89%
    assert fees.refusal(0.005, None, -0.2) == "waiver-out-of-range"
    assert fees.refusal(-0.001, None, None) == "total-out-of-range"
    assert fees.refusal(0.0, None, None) is None  # a zero fee is a fee


def test_a_positive_waiver_that_does_not_reconcile_is_not_a_recoupment():
    assert fees.refusal(0.0100, 0.0125, 0.0010) == "net-above-total"


def test_the_headline_is_net_when_stated_else_total():
    assert fees.headline({"total": 0.009, "net": 0.0075}) == 0.0075
    assert fees.headline({"total": 0.009, "net": None}) == 0.009
    assert fees.headline({"total": 0.0, "net": None}) == 0.0


@pytest.mark.parametrize(
    ("net", "waiver", "basis"),
    [
        (("ok", 0.0075), ("ok", -0.0015), fees.BASIS_STATED_NET),
        (("absent", None), ("absent", None), fees.BASIS_NO_WAIVER),
        (("nil", None), ("nil", None), fees.BASIS_NO_WAIVER),
        (("absent", None), ("ok", 0.0), fees.BASIS_NO_WAIVER),
        (("absent", None), ("ok", -0.0015), fees.BASIS_WAIVER_NO_NET),
        # An ambiguous or unreadable net is not "no waiver stated": the filer may well have
        # stated one (re-check N2, PYGSX / PYUSX / AUIAX).
        (("ambiguous", None), ("absent", None), fees.BASIS_WAIVER_UNRESOLVED),
        (("unreadable", None), ("absent", None), fees.BASIS_WAIVER_UNRESOLVED),
        (("absent", None), ("ambiguous", None), fees.BASIS_WAIVER_UNRESOLVED),
    ],
)
def test_basis_says_what_the_filing_says_about_a_waiver(net, waiver, basis):
    assert fees.basis_for(net, waiver) == basis


# --- the walk -----------------------------------------------------------------


def _filing_rows(*rows: tuple[str, str]) -> list[dict]:
    return [
        {"form": "485BPOS", "filingDate": filed, "accessionNumber": accession, "isXBRL": 1}
        for accession, filed in rows
    ]


@pytest.fixture
def walk(monkeypatch):
    """Drive ``registrant_fees`` over ``filings``: accession → facts, or an exception."""

    def run(filings: dict, rows: list[dict], wants, *, filed_by="2026-11-25"):
        monkeypatch.setattr(sec, "fetch_json", lambda url, **kw: {"filings": {"recent": {}, "files": []}})
        monkeypatch.setattr(xbrl, "recent_rows", lambda submissions: rows)

        def read(cik, row):
            got = filings[row["accessionNumber"]]
            if isinstance(got, Exception):
                raise got
            return got, "instance", f"https://www.sec.gov/Archives/edgar/data/{cik}/{row['accessionNumber']}/x_htm.xml"

        monkeypatch.setattr(fees, "_instance_facts", read)
        return fees.registrant_fees(1, wants, filed_by=filed_by, since="2025-01-01")

    return run


def test_a_class_row_carries_where_and_when_it_was_read(walk):
    result = walk(
        {"new": fees.parse_filing(INSTANCE)},
        _filing_rows(("new", "2026-07-01")),
        [fees.Want("AAA", S1, A)],
    )
    assert result.rows["AAA"] == {
        "class_id": A,
        "total": 0.009,
        "net": 0.0075,
        "waiver": -0.0015,
        "basis": "stated-net",
        "prospectus_date": "2026-04-29",
        "filed_at": "2026-07-01",
        "form": "485BPOS",
        "source_url": "https://www.sec.gov/Archives/edgar/data/1/new/x_htm.xml",
    }


def test_a_filing_after_the_release_date_is_not_read(walk):
    """Point in time on ``filed``: rebuilding a release later cannot change its fees."""
    result = walk(
        {"later": fees.parse_filing(INSTANCE), "ok": fees.parse_filing(CLASS_ONLY)},
        _filing_rows(("later", "2026-12-01"), ("ok", "2026-07-01")),
        [fees.Want("AAA", S1, A)],
        filed_by="2026-11-25",
    )
    assert result.rows["AAA"]["filed_at"] == "2026-07-01"
    assert result.rows["AAA"]["total"] == 0.0049


def test_a_newer_filing_that_cannot_be_read_withholds_the_older_fee(walk):
    result = walk(
        {"new": sec.SecError("HTTP 404"), "old": fees.parse_filing(INSTANCE)},
        _filing_rows(("new", "2026-09-01"), ("old", "2026-05-01")),
        [fees.Want("AAA", S1, A)],
    )
    assert result.rows == {}
    assert result.bands == {"AAA": "newer-filing-unread"}
    assert result.stats["filing_errors"] == 1


def test_a_class_found_only_in_an_older_filing_keeps_its_own_fee(walk):
    """The series is in the newest filing but not this class: the older prospectus answers."""
    newest = fees.parse_filing(INSTANCE)  # S1 has A and B
    result = walk(
        {"new": newest, "old": fees.parse_filing(INSTANCE.replace(b"x:C000000011", b"x:C000000013"))},
        _filing_rows(("new", "2026-09-01"), ("old", "2026-05-01")),
        [fees.Want("ZZZ", S1, "C000000013")],
    )
    assert result.rows["ZZZ"]["filed_at"] == "2026-05-01"


def test_a_class_in_no_filing_has_its_reason(walk):
    result = walk(
        {"f": fees.parse_filing(INSTANCE)},
        _filing_rows(("f", "2026-07-01")),
        [fees.Want("NOC", S1, "C000000099"), fees.Want("UNK", S1, None), fees.Want("OFF", "S000000009", "C000000090")],
    )
    assert result.bands == {
        "NOC": "class-not-in-filing",
        "UNK": "class-unknown",
        "OFF": "series-not-tagged",
    }


def test_a_refused_class_publishes_no_fee_and_says_why(walk):
    scale_error = fees.parse_filing(INSTANCE.replace(b"0.0090", b"0.90"))
    result = walk({"f": scale_error}, _filing_rows(("f", "2026-07-01")), [fees.Want("FCT", S1, A)])
    assert result.rows == {} and result.bands == {"FCT": "total-out-of-range"}


def test_a_listed_instance_that_404s_falls_back_to_the_inline_primary(monkeypatch):
    def fetch(url, **kw):
        if url.endswith("_htm.xml"):
            raise sec.SecError("HTTP 404")
        return INLINE

    monkeypatch.setattr(sec, "fetch", fetch)
    monkeypatch.setattr(
        sec, "fetch_json", lambda url, **kw: {"directory": {"item": [{"name": "d1_htm.xml"}, {"name": "d1.htm"}]}}
    )
    filing, basis, url = fees._instance_facts(
        1, {"accessionNumber": "0000000001-26-000001", "isInlineXBRL": 1, "primaryDocument": "d1.htm"}
    )
    assert basis == "inline-fallback" and url.endswith("/d1.htm")
    assert fees.fees_for(filing.facts, S1, A)[1].resolved("total") == ("ok", 0.009)


def test_fee_forms_are_filtered_by_window_and_sorted_newest_first():
    rows = [
        {"form": "485BPOS", "filingDate": "2024-01-02", "accessionNumber": "a"},
        {"form": "497", "filingDate": "2026-03-01", "accessionNumber": "b"},
        {"form": "N-CSR", "filingDate": "2026-04-01", "accessionNumber": "c"},
        {"form": "485BPOS", "filingDate": "2026-05-01", "accessionNumber": "d"},
        {"form": "485BPOS", "filingDate": "2026-12-01", "accessionNumber": "e"},
    ]
    picked = fees._fee_rows(rows, "2025-05-25", "2026-11-25")
    assert [r["accessionNumber"] for r in picked] == ["d", "b"]


def test_the_lookback_is_548_days_before_the_release_date():
    assert fees.lookback_start("2026-11-25") == "2025-05-26"


# --- the release --------------------------------------------------------------


def _row(total=0.0004, filed_at="2026-04-28", **extra) -> dict:
    row = {
        "class_id": A, "total": total, "net": None, "waiver": None, "basis": "no-waiver-stated",
        "prospectus_date": "2026-04-29", "filed_at": filed_at, "form": "485BPOS",
        "source_url": "https://www.sec.gov/Archives/edgar/data/1/0001/x_htm.xml",
    }
    row.update(extra)
    return row


def test_collect_counts_what_it_found_and_why_it_did_not(monkeypatch):
    def registrant(cik, wants, **kw):
        if cik == 2:
            raise sec.SecError("HTTP 503")
        result = fees.RegistrantResult()
        result.rows["AAA"] = _row()
        result.bands["BBB"] = "class-not-in-filing"
        return result

    monkeypatch.setattr(fees, "registrant_fees", registrant)
    release = fees.collect(
        {1: [fees.Want("AAA", S1, A), fees.Want("BBB", S1, B)], 2: [fees.Want("CCC", S2, C)]},
        filed_by="2026-11-25",
    )
    assert release.classes_wanted == 3 and release.classes_found == 1
    assert release.bands == {"class-not-in-filing": 1, "registrant-unavailable": 1}
    assert release.unavailable == [2]
    assert list(release.by_series[S1]) == ["AAA"]


def test_an_override_fills_a_hole_but_never_replaces_a_filing(monkeypatch):
    def registrant(cik, wants, **kw):
        result = fees.RegistrantResult()
        result.rows["OLD"] = _row(0.0009)
        result.bands["SPY"] = "no-xbrl-filing"
        return result

    monkeypatch.setattr(fees, "registrant_fees", registrant)
    override = _row(0.000945)
    release = fees.collect(
        {1: [fees.Want("OLD", S1, A), fees.Want("SPY", S2, None)]},
        filed_by="2026-11-25",
        overrides={"SPY": override, "OLD": _row(0.0100)},
    )
    assert release.by_series[S1]["OLD"]["total"] == 0.0009
    assert release.by_series[S2]["SPY"]["total"] == 0.000945
    assert release.overridden == 1 and release.bands == {}


def test_the_override_file_is_held_to_the_same_rules(tmp_path):
    header = "ticker,class_id,total,net,waiver,basis,prospectus_date,filed_at,form,source_url\n"
    good = "SPY,,0.000945,,,no-waiver-stated,,2026-01-27,485BPOS,https://www.sec.gov/Archives/edgar/data/1/x.htm\n"
    path = tmp_path / "fees.csv"
    path.write_text("# reviewed\n" + header + good)
    rows = fees.load_overrides(path)
    assert rows["SPY"]["total"] == 0.000945 and rows["SPY"]["net"] is None and rows["SPY"]["class_id"] is None

    for broken, why in [
        (good.replace("0.000945", "0.45"), "total-out-of-range"),
        (good.replace("no-waiver-stated", "made-up"), "basis"),
        (good.replace("2026-01-27", ""), "filed_at"),
        (good.replace("https://www.sec.gov", "http://example.com"), "source_url"),
        (good + good, "twice"),
    ]:
        path.write_text(header + broken)
        with pytest.raises(ValueError, match=why):
            fees.load_overrides(path)


def test_the_override_file_that_ships_loads():
    rows = fees.load_overrides()
    assert "SPY" in rows
    assert rows["SPY"]["source_url"].startswith("https://www.sec.gov/")


# --- the build ------------------------------------------------------------------


def test_every_listed_class_of_a_series_is_wanted_from_its_registrant(monkeypatch):
    monkeypatch.setattr(
        build.universe,
        "_mf_map",
        lambda: {"AAA": ("0000000001", S1, A), "AAAX": ("0000000001", S1, B), "ODD": ("0000000001", "S000000009", C)},
    )
    one = build.FundBuild(
        ticker="AAA", document={"fund_id": S1}, payload=b"", ref_symbols=("AAA", "AAAX", "NEW"), cik=1
    )
    no_cik = build.FundBuild(ticker="Z", document={"fund_id": S2}, payload=b"", cik=None)
    # A unit trust has no series id (SPY files as ``CIK…``) and no XBRL, but it can still be
    # answered by a reviewed override, so it is wanted under its fund id.
    trust = build.FundBuild(ticker="SPY", document={"fund_id": "CIK0000884394"}, payload=b"", cik=884394)
    wants = build._fee_wants([one, no_cik, trust])
    assert wants == {
        1: [fees.Want("AAA", S1, A), fees.Want("AAAX", S1, B), fees.Want("NEW", S1, None)],
        884394: [fees.Want("SPY", "CIK0000884394", None)],
    }


def test_the_fees_sit_after_net_assets_in_the_documents_fixed_order():
    document = {"ticker": "T", "coverage_pct": 99.0, "net_assets": 5, "holdings": []}
    published = build._with_fees(document, {"B": _row(), "A": _row()})
    assert list(published) == ["ticker", "coverage_pct", "net_assets", "fees", "holdings"]
    assert list(published["fees"]["classes"]) == ["A", "B"]
    assert list(published["fees"]["classes"]["A"]) == list(fees.ROW_KEYS)


def test_fees_never_cost_a_fund_its_place(monkeypatch):
    """A document the fees would push over the per-fund ceiling goes without them."""
    document = {"ticker": "BIG", "fund_id": S1, "coverage_pct": 99.0, "net_assets": 100, "holdings": []}
    small = {"ticker": "SML", "fund_id": S2, "coverage_pct": 99.0, "net_assets": 300, "holdings": []}
    builds = [
        build.FundBuild(ticker="BIG", document=document, payload=b"old"),
        build.FundBuild(ticker="SML", document=small, payload=b"old"),
    ]
    found = fees.ReleaseFees(by_series={S1: {"BIG": _row()}, S2: {"SML": _row()}}, classes_wanted=2)
    monkeypatch.setattr(build, "MAX_FUND_BYTES", 200)
    summary = build._attach_fees(builds, found)
    assert all("fees" not in build_.document and build_.payload == b"old" for build_ in builds)
    assert summary["oversize_dropped"] == 2 and summary["funds"] == 0
    monkeypatch.setattr(build, "MAX_FUND_BYTES", 2_000_000)
    summary = build._attach_fees(builds, found)
    assert summary["funds"] == 2 and summary["pct_assets"] == 100.0
    assert json.loads(builds[1].payload)["fees"]["classes"]["SML"]["total"] == 0.0004


# --- the validator ----------------------------------------------------------------


def _report():
    return validate.Report()


def _check(document: dict, release_date="2026-11-25", aliases=None) -> int:
    report = _report()
    validate._check_fees(document, release_date, aliases or {}, report)
    return report.failures


def _fund(rows: dict | None = None) -> dict:
    return {"ticker": "AAA", "fees": {"classes": rows if rows is not None else {"AAA": _row()}}}


def test_a_document_without_fees_is_valid():
    assert _check({"ticker": "AAA"}) == 0


def test_a_good_fee_block_passes_including_an_alias_class_and_a_recoupment():
    rows = {
        "AAA": _row(),
        "AAAX": _row(0.0123, net=0.0125, waiver=0.0002, basis="stated-net"),
    }
    assert _check(_fund(rows), aliases={"AAAX": "AAA"}) == 0


@pytest.mark.parametrize(
    "document",
    [
        _fund({}),  # present but empty
        _fund({"AAA": _row(0.89)}),  # a scale error reached the document
        _fund({"AAA": _row(0.0004, net=0.0100)}),  # net above total, no recoupment
        _fund({"AAA": _row(basis="stated-net")}),  # basis says net, none stated
        _fund({"AAA": _row(net=0.0003, basis="no-waiver-stated")}),  # basis hides a net
        _fund({"AAA": _row(filed_at="2026-12-01")}),  # filed after the release
        _fund({"AAA": _row(source_url="http://x")}),
        _fund({"AAA": _row(form="N-CSR")}),
        _fund({"AAA": _row(class_id="C12")}),
        _fund({"AAA": _row(total=None)}),
        _fund({"ZZZ": _row()}),  # another fund's ticker
        {"ticker": "AAA", "fees": {"classes": {"AAA": _row()}, "extra": 1}},
        _fund({"AAB": _row(), "AAA": _row()}),  # not in ticker order
    ],
)
def test_a_bad_fee_block_fails_the_release(document):
    assert _check(document) >= 1


def test_the_release_check_reads_the_date_and_aliases_from_the_release(tmp_path):
    document = fund_document()
    document["fees"] = {"classes": {document["ticker"]: _row()}}
    release_dir = write_release(tmp_path, [document], release_id="2026-04-01.1")
    report = _report()
    validate._check_fees_release(release_dir, [document], report)
    assert report.failures == 1  # filed 2026-04-28, after a release dated 2026-04-01


# --- the review ---------------------------------------------------------------------


def _doc(ticker="AAA", **fee_rows):
    document = fund_document()
    document.update({"ticker": ticker, "fund_id": S1})
    if fee_rows:
        document["fees"] = {"classes": fee_rows}
    return document


def _review(tmp_path: Path, parent: dict, current: dict, release_id="2026-11-25.1"):
    parent_dir = write_release(tmp_path, [parent], release_id="2026-11-24.1")
    release_dir = write_release(tmp_path, [current], release_id=release_id)
    return review.review(release_dir, parent_dir)


def test_a_fee_that_moves_more_than_25_bp_is_a_warning(tmp_path):
    report = _review(tmp_path, _doc(AAA=_row(0.0040)), _doc(AAA=_row(0.0075)))
    (finding,) = [f for f in report.findings if f["rule"] == "fee_jump"]
    assert (finding["before"], finding["after"], finding["severity"]) == (40, 75, "warn")
    same = _review(tmp_path / "b", _doc(AAA=_row(0.0040)), _doc(AAA=_row(0.0064)))
    assert same.rules["fee_jump"] == 0


def test_the_headline_fee_is_net_when_stated(tmp_path):
    report = _review(
        tmp_path,
        _doc(AAA=_row(0.0090, net=0.0050, basis="stated-net")),
        _doc(AAA=_row(0.0090, net=0.0090, basis="stated-net")),
    )
    assert report.rules["fee_jump"] == 1


def test_a_fund_that_stated_a_fee_and_now_states_none_is_a_warning(tmp_path):
    report = _review(tmp_path, _doc(AAA=_row()), _doc())
    assert report.rules["fee_lost"] == 1
    assert _review(tmp_path / "b", _doc(), _doc()).rules["fee_lost"] == 0


def test_a_fee_read_from_a_filing_over_13_months_old_is_info(tmp_path):
    report = _review(tmp_path, _doc(AAA=_row(filed_at="2025-01-10")), _doc(AAA=_row(filed_at="2025-01-10")))
    (finding,) = [f for f in report.findings if f["rule"] == "fee_stale"]
    assert finding["severity"] == "info"
    fresh = _review(tmp_path / "b", _doc(AAA=_row()), _doc(AAA=_row()))
    assert fresh.rules["fee_stale"] == 0
