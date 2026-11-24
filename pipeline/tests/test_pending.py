"""Pending funds: registered and listed, no N-PORT yet.

The defect these tests were written for: on 2026-11-19 Corgi MANGOS ETF (MN) and
Roundhill Magnificent Seven Plus ETF (MAGP) were live and absent from the release. Both
launched after a quarter end, so neither had filed the N-PORT that is the product's only
source of holdings. The repair names such a fund, with the reason, and stops there: no
holdings, no fee, no claim that it trades.

Every date below is hand-calculated from the 60-day N-PORT deadline.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from pipeline import pending

#: The shape EDGAR serves at ``…-index-headers.html`` (MAGP's 497 of 2026-11-10), cut to
#: the lines the parser reads.
MAGP_HEADER = """<!--
<SERIES-AND-CLASSES-CONTRACTS-DATA>
<EXISTING-SERIES-AND-CLASSES-CONTRACTS>
<SERIES>
<OWNER-CIK>0001976517
<SERIES-ID>S000106451
<SERIES-NAME>Roundhill Magnificent Seven Plus ETF
<CLASS-CONTRACT>
<CLASS-CONTRACT-ID>C000277312
<CLASS-CONTRACT-NAME>Roundhill Magnificent Seven Plus ETF
</CLASS-CONTRACT>
</SERIES>
</EXISTING-SERIES-AND-CLASSES-CONTRACTS>
</SERIES-AND-CLASSES-CONTRACTS-DATA>
</SEC-HEADER>
-->
<PRE>
ACCESSION NUMBER:\t\t0001398344-26-019878
CONFORMED SUBMISSION TYPE:\t497
FILED AS OF DATE:\t\t20261110

FILER:

\tCOMPANY DATA:\t
\t\tCOMPANY CONFORMED NAME:\t\t\tRoundhill ETF Trust
\t\tCENTRAL INDEX KEY:\t\t\t0001976517
\t\tFISCAL YEAR END:\t\t\t1231
"""


def header(accession, form, filed, series, *, fye="1231", cik="0001976517", registrant="Roundhill ETF Trust"):
    return pending.Header(
        accession=accession, cik=cik.lstrip("0"), form=form, filed=filed,
        fiscal_year_end=fye, registrant=registrant, series=tuple(series),
    )


def test_parse_header_reads_series_form_date_and_fiscal_year_end():
    parsed = pending.parse_header("0001398344-26-019878", "1976517", MAGP_HEADER)
    assert parsed is not None
    assert parsed.form == "497"
    assert parsed.filed == "2026-11-10"
    assert parsed.fiscal_year_end == "1231"
    assert parsed.registrant == "Roundhill ETF Trust"
    assert parsed.series == (("S000106451", "Roundhill Magnificent Seven Plus ETF"),)


def test_parse_header_of_a_trust_level_filing_has_no_series():
    text = MAGP_HEADER.split("<SERIES-AND-CLASSES")[0] + MAGP_HEADER.split("</SEC-HEADER>")[1]
    parsed = pending.parse_header("0001398344-26-019878", "1976517", text)
    assert parsed is not None and parsed.series == ()


def test_parse_header_refuses_what_is_not_a_header():
    assert pending.parse_header("0000000000-26-000001", "1", "<html>blocked</html>") is None


def test_header_url_drops_padding_and_dashes():
    assert pending.header_url("0001976517", "0001398344-26-019878") == (
        "https://www.sec.gov/Archives/edgar/data/1976517/000139834426019878/"
        "0001398344-26-019878-index-headers.html"
    )


# 2026-12-31 + 60 days: January is 31 days, February 28 more brings it to 59, so the
# sixtieth day is 1 March.
@pytest.mark.parametrize(
    "effective, fye, period_end, earliest_due, latest_due",
    [
        # MN: effective 2026-09-29. 2026-09-30 is the next quarter end, + 60 = 2026-11-29
        # (October 31 days, then 29 more). The fund may have started after it, so the
        # following quarter end 2026-12-31 + 60 = 2027-03-01 is the outer bound.
        ("2026-09-29", "1231", "2026-09-30", "2026-11-29", "2027-03-01"),
        # MAGP: effective 2026-11-10 -> 2026-12-31 + 60 = 2027-03-01; the next quarter end
        # 2027-03-31 + 60 = 2027-05-30 (April 30 days, then 30 more).
        ("2026-11-10", "1231", "2026-12-31", "2027-03-01", "2027-05-30"),
        # A trust with an 08-31 year (Listed Funds Trust) has quarter ends 11-30, 02-28,
        # 05-31, 08-31: effective 2026-10-30 -> 2026-11-30 + 60 = 2027-01-29.
        ("2026-10-30", "0831", "2026-11-30", "2027-01-29", "2027-04-29"),
        # Effective on a quarter end: that day is not "after", so the next one is used.
        ("2026-12-31", "1231", "2027-03-31", "2027-05-30", "2027-08-29"),
    ],
)
def test_report_window_is_the_sixty_day_rule_applied_to_fiscal_quarter_ends(
    effective, fye, period_end, earliest_due, latest_due
):
    assert pending.report_window(effective, fye) == (period_end, earliest_due, latest_due)


def test_unreadable_fiscal_year_end_is_read_as_december():
    assert pending.quarter_ends_after(date(2026, 11, 10), "", 1) == [date(2026, 12, 31)]
    assert pending.quarter_ends_after(date(2026, 11, 10), "9999", 1) == [date(2026, 12, 31)]


def test_candidate_series_ignores_drafts_and_old_filings():
    headers = [
        header("a-1", "485BPOS", "2026-10-14", [("S000108971", "Fund A")]),
        header("a-2", "485APOS", "2026-10-15", [("S000108971", "Fund A")]),
        header("b-1", "497K", "2026-02-01", [("S000100000", "Old Fund")]),
    ]
    got = pending.candidate_series(headers, window_start="2026-06-22")
    assert set(got) == {"S000108971"}
    assert [row.accession for row in got["S000108971"]] == ["a-1"]  # the draft is not a prospectus


def test_build_pending_publishes_only_a_series_that_has_a_symbol_and_no_nport():
    mn = header("c-1", "485BPOS", "2026-09-29", [("S000108244", "Corgi MANGOS ETF")],
                fye="1231", cik="2078265", registrant="Corgi ETF Trust I")
    mn_later = header("c-2", "497", "2026-10-23", [("S000108244", "Corgi MANGOS ETF")],
                      fye="1231", cik="2078265", registrant="Corgi ETF Trust I")
    magp = header("d-1", "497", "2026-11-10", [("S000106451", "Roundhill Magnificent Seven Plus ETF")])
    reported = header("e-1", "497K", "2026-10-01", [("S000102337", "Roundhill Memory ETF")])
    money = header("f-1", "485BPOS", "2026-10-14", [("S000108971", "Corgi Money Market ETF")])
    nameless = header("g-1", "497", "2026-10-02", [("S000109999", "Corgi Mystery ETF")])
    candidates = pending.candidate_series(
        [mn, mn_later, magp, reported, money, nameless], window_start="2026-06-22"
    )
    funds, skipped = pending.build_pending(
        candidates,
        has_nport={"S000102337": True},
        symbols={
            "S000108244": ("MN", "sec_ticker_file:company_tickers_mf"),
            "S000106451": ("MAGP", "cover:0001398344-26-019878"),
            "S000109999": (None, "no corroborated exchange line"),
        },
    )
    assert [fund.ticker for fund in funds] == ["MAGP", "MN"]
    assert skipped == {
        "has_nport": ["S000102337"],       # DRAM-shaped: it reports, so the build owns it
        "money_market": ["S000108971"],    # MMFs file N-MFP, never N-PORT
        "no_symbol": ["S000109999"],       # recorded, never guessed
    }
    mn_row = next(fund for fund in funds if fund.ticker == "MN")
    assert mn_row.first_prospectus_filed == "2026-09-29"      # the earliest in the window
    assert mn_row.latest_prospectus_accession == "c-2"         # the newest names the page
    assert (mn_row.earliest_report_due_by, mn_row.latest_report_due_by) == ("2026-11-29", "2027-03-01")


def test_document_states_no_holdings_and_is_deterministic():
    mn = header("c-1", "485BPOS", "2026-09-29", [("S000108244", "Corgi MANGOS ETF")],
                cik="2078265", registrant="Corgi ETF Trust I")
    funds, _ = pending.build_pending(
        pending.candidate_series([mn], window_start="2026-06-22"),
        has_nport={}, symbols={"S000108244": ("MN", "sec_ticker_file:company_tickers_mf")},
    )
    first = pending.document(funds, as_of="2026-11-19.1")
    second = pending.document(list(reversed(funds)), as_of="2026-11-19.1")
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    row = first["funds"]["MN"]
    assert row["series_id"] == "S000108244"
    assert row["latest_prospectus"]["source_url"].startswith("https://www.sec.gov/Archives/edgar/data/2078265/")
    # The contract: nothing a filing has not stated. No weights, no fee, no launch date.
    banned = {"holdings", "weight_bp", "coverage_pct", "expense_ratio", "launch", "inception"}
    assert banned.isdisjoint(row) and "kind" in first and first["kind"] == "pending_funds"


def test_money_market_names():
    assert pending.is_money_market("Corgi Money Market ETF")
    assert pending.is_money_market("Example Money-Market Fund")
    assert not pending.is_money_market("Roundhill Magnificent Seven Plus ETF")


def test_header_cache_round_trips(tmp_path):
    original = {
        "x-1": header("x-1", "497", "2026-11-10", [("S000106451", "Roundhill Magnificent Seven Plus ETF")])
    }
    pending.save_headers(original, root=tmp_path)
    assert pending.load_headers(root=tmp_path) == original


def test_header_cache_of_another_schema_is_ignored(tmp_path):
    path = tmp_path / pending.CACHE_RELPATH
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"schema_version": 0, "headers": {"x": {}}}))
    assert pending.load_headers(root=tmp_path) == {}


# --- the release object's own gate -----------------------------------------------------


def _doc(**overrides):
    mn = header("c-1", "485BPOS", "2026-09-29", [("S000108244", "Corgi MANGOS ETF")],
                cik="2078265", registrant="Corgi ETF Trust I")
    funds, _ = pending.build_pending(
        pending.candidate_series([mn], window_start="2026-06-22"),
        has_nport={}, symbols={"S000108244": ("MN", "sec_ticker_file:company_tickers_mf")},
    )
    body = pending.document(funds, as_of="2026-11-19.1")
    body.update(overrides)
    return body


def test_a_well_formed_document_has_no_problems():
    assert pending.validate_document(_doc(), as_of="2026-11-19.1", published=["AVUV"], size=900) == []


def test_a_pending_row_cannot_shadow_a_published_fund():
    problems = pending.validate_document(_doc(), as_of="2026-11-19.1", published=["MN"], size=900)
    assert any("published fund" in problem for problem in problems)


def test_a_pending_row_cannot_state_what_no_filing_stated():
    body = _doc()
    body["funds"]["MN"]["expense_ratio"] = 0.2
    problems = pending.validate_document(body, as_of="2026-11-19.1", published=[], size=900)
    assert any("expense_ratio" in problem for problem in problems)


def test_the_count_the_as_of_and_the_window_are_recomputed():
    body = _doc()
    body["counts"]["funds"] = 9
    body["funds"]["MN"]["first_report"]["latest_due_by"] = "2026-01-01"
    problems = pending.validate_document(body, as_of="2026-11-20.1", published=[], size=900)
    text = " | ".join(problems)
    assert "counts.funds" in text and "release as_of" in text and "runs backwards" in text


def test_the_ceiling_and_the_wrong_kind_are_refused():
    problems = pending.validate_document(
        _doc(kind="sizes"), as_of="2026-11-19.1", published=[], size=pending.MAX_PENDING_BYTES + 1
    )
    assert any("ceiling" in problem for problem in problems)
    assert any("kind" in problem for problem in problems)


def test_known_nport_series_counts_every_failure_but_no_filing():
    from pipeline import universe

    refs = [
        universe.FundRef(ticker="LEV", cik="1", series_id="S000000001", resolved_by="x"),
        universe.FundRef(ticker="NEW", cik="1", series_id="S000000002", resolved_by="x"),
    ]
    failures = [
        {"ticker": "LEV", "error": "GateError: leverage"},
        {"ticker": "NEW", "error": "NoFilingError: NEW: series 'S000000002' has no N-PORT filing in the newest 9 filings"},
    ]
    assert pending.known_nport_series(["S000000009"], refs, failures, ["S000000008"]) == {
        "S000000009", "S000000008", "S000000001",
    }


def test_the_release_validator_checks_a_present_file_and_ignores_an_absent_one(tmp_path):
    from pipeline import validate

    manifest = {"as_of": "2026-11-19.1"}
    funds = [{"ticker": "AVUV"}]

    absent = validate.Report()
    validate._check_pending(tmp_path, manifest, funds, absent)
    assert absent.failures == 0  # the object is additive: no file is a valid release

    (tmp_path / pending.PENDING_FILE).write_text(json.dumps(_doc()), encoding="utf-8")
    good = validate.Report()
    validate._check_pending(tmp_path, manifest, funds, good)
    assert good.failures == 0

    shadow = validate.Report()  # the same row, but the release now publishes MN
    validate._check_pending(tmp_path, manifest, [{"ticker": "MN"}], shadow)
    assert shadow.failures == 1

    (tmp_path / pending.PENDING_FILE).write_text("{not json", encoding="utf-8")
    broken = validate.Report()
    validate._check_pending(tmp_path, manifest, funds, broken)
    assert broken.failures == 1


def test_write_is_deterministic_and_compact(tmp_path):
    first = pending.write(_doc(), tmp_path)[1]
    second = pending.write(_doc(), tmp_path)[1]
    assert first == second and b"\n" not in first
    compact = json.dumps(json.loads(first), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert first == compact.encode()


def test_absent_nport_series_is_exactly_the_no_filing_failures():
    from pipeline import universe

    refs = [
        universe.FundRef(ticker="LEV", cik="1", series_id="S000000001", resolved_by="x"),
        universe.FundRef(ticker="NEW", cik="1", series_id="S000000002", resolved_by="x"),
    ]
    failures = [
        {"ticker": "LEV", "error": "GateError: leverage"},
        {"ticker": "NEW", "error": "NoFilingError: NEW: series 'S000000002' has no N-PORT filing in the newest 9"},
        {"ticker": "GONE", "error": "NoFilingError: has no N-PORT filing"},
    ]
    assert pending.absent_nport_series(refs, failures) == {"S000000002"}


def test_a_symbol_that_could_not_be_read_is_retried_and_one_that_could_is_remembered(monkeypatch):
    calls = []

    def fake(series_id, cik, name):
        calls.append(series_id)
        return ("MAGP", "cover:x", "cover") if series_id == "S000106451" else (None, None, "no line")

    monkeypatch.setattr(pending.discovery, "resolve_symbol", fake)
    cache: dict = {}
    for _ in range(2):
        pending._symbol_for("S000106451", "1", "n", refs={}, cache=cache, resolve_budget=[9])
        pending._symbol_for("S000109999", "1", "n", refs={}, cache=cache, resolve_budget=[9])
    assert calls == ["S000106451", "S000109999", "S000109999"]  # the success was not re-read
    assert set(cache) == {"S000106451"}


# --- a published page owns its ticker (the 2026-11-22 nightly failed on QRVLX) -------------


def _two_pending():
    headers = [
        header("c-1", "485BPOS", "2026-09-29", [("S000108244", "Corgi MANGOS ETF")],
               cik="2078265", registrant="Corgi ETF Trust I"),
        header("c-2", "485BPOS", "2026-09-30", [("S000108245", "Corgi PAPAYA ETF")],
               cik="2078265", registrant="Corgi ETF Trust I"),
    ]
    funds, _ = pending.build_pending(
        pending.candidate_series(headers, window_start="2026-06-22"),
        has_nport={},
        symbols={"S000108244": ("MN", "sec_ticker_file:company_tickers_mf"),
                 "S000108245": ("PP", "sec_ticker_file:company_tickers_mf")},
    )
    return funds


def test_a_pending_row_whose_ticker_a_published_page_owns_is_dropped_and_counted():
    kept, shadowed = pending.drop_published(_two_pending(), ["MN", "AVUV"])
    assert [fund.ticker for fund in kept] == ["PP"]
    assert [fund.ticker for fund in shadowed] == ["MN"]


def test_nothing_is_dropped_when_no_published_ticker_collides():
    funds = _two_pending()
    kept, shadowed = pending.drop_published(funds, ["AVUV"])
    assert kept == funds and shadowed == []


def test_the_filtered_document_passes_the_release_gate_that_refused_the_unfiltered_one():
    funds = _two_pending()
    unfiltered = pending.document(funds, as_of="2026-11-24.1")
    assert any("published fund" in p for p in pending.validate_document(
        unfiltered, as_of="2026-11-24.1", published=["MN"], size=900))
    kept, _ = pending.drop_published(funds, ["MN"])
    filtered = pending.document(kept, as_of="2026-11-24.1")
    assert pending.validate_document(filtered, as_of="2026-11-24.1", published=["MN"], size=900) == []
