"""The diagnostic that turns "unmapped" into four numbers with four fixes."""

from __future__ import annotations

import json

import pytest

from pipeline import mapping_report, universe
from pipeline.companies import CompanyIndex, company_id
from pipeline.filings import FoundFiling
from pipeline.nport import Holding, NportFiling


def holding(name, *, ticker=None, value=100.0, asset_cat="EC", issuer_cat=None):
    return Holding(
        name=name,
        title=None,
        cusip=None,
        isin=None,
        ticker=ticker,
        lei=None,
        balance=None,
        units=None,
        cur_cd="USD",
        val_usd=value,
        pct_val=None,
        asset_cat=asset_cat,
        issuer_cat=issuer_cat,
        inv_country="US",
        payoff_profile=None,
        is_derivative=False,
    )


def index() -> CompanyIndex:
    return CompanyIndex.from_document(
        {
            "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
            "1": {"cik_str": 19617, "ticker": "JPM", "title": "JPMorgan Chase & Co"},
        }
    )


def filing(rows: list[Holding], net_assets: float = 1000.0) -> NportFiling:
    return NportFiling(
        accession="0000000000-26-000001",
        submission_type="NPORT-P",
        cik="1",
        class_ids=[],
        fiscal_year_end="2026-06-30",
        total_assets=net_assets,
        total_liabilities=0.0,
        series_id="S000000001",
        series_name="Test Index Fund",
        registrant_name="Test Registrant",
        report_date="2026-06-30",
        holdings=rows,
        net_assets=net_assets,
    )


@pytest.fixture
def ref() -> universe.FundRef:
    return universe.FundRef(ticker="TEST", cik="1", series_id="S000000001", resolved_by="test")


def test_buckets_attribute_every_basis_point_of_exposure(monkeypatch, ref):
    rows = [
        # mapped by ticker, corroborated by name
        holding("Apple Inc.", ticker="AAPL", value=400.0),
        # mapped by name, no symbol
        holding("JPMorgan Chase & Co", value=200.0),
        # symbol the index has never heard of
        holding("Some Tail Company", ticker="ZZZZ", value=100.0),
        # symbol the index has, refused because the name is another company
        holding("Schneider Electric SE", ticker="JPM", value=50.0),
        # no symbol, no company in EDGAR shares the name
        holding("Private Holdings Ltd", value=50.0),
        # neither identifier
        holding("", value=20.0),
        # cash and a fund position: not company exposure, never in the denominator
        holding("Cash", value=100.0, asset_cat="CASH", issuer_cat="CASH"),
        holding("Vanguard Total Bond", value=80.0, asset_cat="EC", issuer_cat="RF"),
    ]
    found = FoundFiling(
        ref=ref,
        accession="0000000000-26-000001",
        filing_date="2026-08-28",
        report_date="2026-06-30",
        source_url="https://www.sec.gov/example",
        filing=filing(rows),
    )
    monkeypatch.setattr(mapping_report.filings, "latest", lambda _ref: found)

    report = mapping_report.analyse([ref], index(), workers=1)
    exposure = report["company_exposure"]

    # Values are dollars against 1,000 of net assets, so 1 dollar = 10 bp.
    # Mapped: Apple 4,000 + JPM 2,000. Cash 1,000 is excluded from the denominator;
    # the fund position (800) is company exposure at one level, so it counts.
    assert exposure["weight_bp"] == pytest.approx(9_000.0)
    assert exposure["mapped_bp"] == pytest.approx(6_000.0)
    assert exposure["unmapped_bp"] == pytest.approx(3_000.0)
    assert exposure["identity_ok"] is True
    assert exposure["mapped_pct"] == pytest.approx(66.67, abs=0.01)

    buckets = report["buckets"]
    assert buckets["ticker_unknown"]["weight_bp"] == pytest.approx(1_000.0)
    assert buckets["ticker_rejected_by_name"]["weight_bp"] == pytest.approx(500.0)
    # Private 500 + the fund position 800, which is company exposure but never a
    # company (by_category is what separates those); the nameless row is its own
    # bucket, because the fix for "no identifier" is not a mapping rule.
    assert buckets["name_unmatched"]["weight_bp"] == pytest.approx(1_300.0)
    assert buckets["no_identifier"]["weight_bp"] == pytest.approx(200.0)
    assert buckets["ticker_unknown"]["share_of_unmapped_pct"] == pytest.approx(33.33, abs=0.01)
    assert report["by_category"]["fund"]["name_unmatched"] == pytest.approx(800.0)
    assert report["per_fund"][0]["mapped_pct"] == pytest.approx(66.67, abs=0.01)


def test_report_renders_markdown_with_the_identity_line(monkeypatch, ref):
    found = FoundFiling(
        ref=ref,
        accession="0000000000-26-000001",
        filing_date="2026-08-28",
        report_date="2026-06-30",
        source_url="https://www.sec.gov/example",
        filing=filing([holding("Apple Inc.", ticker="AAPL", value=500.0)]),
    )
    monkeypatch.setattr(mapping_report.filings, "latest", lambda _ref: found)
    report = mapping_report.analyse([ref], index(), workers=1)
    markdown = mapping_report.render_markdown(report, release="2026-10-30.1", sample=1)
    assert "Identity (mapped + unmapped = total): **ok**" in markdown
    assert "`AAPL`" not in markdown  # mapped rows are not "unmapped holdings"


def test_ticker_unknown_is_company_id_shaped_but_unmapped():
    """A symbol absent from EDGAR's file is not the same as a rejected symbol."""
    idx = index()
    assert idx.explain("ZZZZ", "Some Tail Company") == "ticker_unknown"
    assert idx.explain("JPM", "Schneider Electric SE") == "ticker_rejected_by_name"
    assert idx.explain(None, "Private Holdings Ltd") == "name_unmatched"
    assert idx.explain(None, None) == "no_identifier"
    assert idx.explain("AAPL", "Apple Inc.") == "ticker"
    assert idx.explain(None, "JPMorgan Chase & Co") == "name_exact"
    assert company_id(320193) == "c_0000320193"


def test_sample_is_deterministic_and_spread_across_the_release():
    tickers = [f"T{index:03d}" for index in range(100)]
    assert mapping_report._sample(tickers, 10) == tickers[::10]
    assert mapping_report._sample(tickers, 0) == tickers
    assert mapping_report._sample(tickers, 200) == tickers


def test_release_tickers_are_read_from_the_object(tmp_path):
    (tmp_path / "tickers.json").write_text(
        json.dumps({"as_of": "2026-10-30.1", "tickers": ["VOO", "QQQ"]})
    )
    release, tickers = mapping_report._tickers_from_release(tmp_path)
    assert release == "2026-10-30.1"
    assert tickers == ["VOO", "QQQ"]


def test_near_miss_separates_a_matcher_fix_from_a_missing_identifier():
    """One indexed company sharing most words is fixable; no match is not."""
    titles = {"c_1": "Schneider Electric SE", "c_2": "Apple Inc."}
    tokens_by_company = {
        company: {token for token in mapping_report.name_tokens(title) if len(token) > 2}
        for company, title in titles.items()
    }
    by_token: dict[str, set[str]] = {}
    for company, tokens in tokens_by_company.items():
        for token in tokens:
            by_token.setdefault(token, set()).add(company)

    # Same company, filed with a suffix the exact rung does not normalize away.
    assert mapping_report.near_miss(
        "Schneider Electric Holdings", tokens_by_company, by_token
    )
    # Two companies share "electric"? not here: an unknown name has no candidates.
    assert not mapping_report.near_miss("Hanwha Aerospace", tokens_by_company, by_token)
    # Corporate-form words alone never make a match.
    assert not mapping_report.near_miss("Acme Holdings Ltd", tokens_by_company, by_token)
    # Ambiguity is not a match: two candidates means a human, not a heuristic.
    merged = {**tokens_by_company, "c_3": {"electric", "grid"}}
    merged_by_token: dict[str, set[str]] = {}
    for company, tokens in merged.items():
        for token in tokens:
            merged_by_token.setdefault(token, set()).add(company)
    assert not mapping_report.near_miss("Electric Holdings", merged, merged_by_token)
