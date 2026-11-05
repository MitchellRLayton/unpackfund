"""The filing's own country, published only where it is the best answer available.

A company's country is decided once, by value, across every fund that holds it
(``company_countries``). A *position* that resolved to no company has no such answer,
and the Markets bar still has to place it — so the row carries the filing's own
``invCountry``, under a name that says exactly what it is.

Two rules, and both are tested here because either one alone would let the field
become a second, weaker company country:

* it is published **only** on a row with no ``company_id`` — a row that named a
  company must not carry a second country beside the decided one;
* it survives the flattener, because a wrapper's unmatched rows are the ones that
  need it most and a composed document is the only place they are published.
"""

from __future__ import annotations

from pipeline import artifact, classify, fund_lookthrough as fol, weights


def holding(
    name: str,
    weight_bp: int,
    *,
    company_id: str | None = None,
    asset_cat: str = classify.EQUITY,
    country: str | None = None,
    lei: str | None = None,
) -> weights.FundHolding:
    return weights.FundHolding(
        company_id=company_id,
        name=name,
        ticker=None,
        asset_cat=asset_cat,
        weight_bp=weight_bp,
        is_company_exposure=asset_cat in classify.COMPANY_CATEGORIES,
        country=country,
        lei=lei,
    )


def fund(rows, *, ticker: str, series_lei: str | None = None) -> fol.FundInput:
    return fol.FundInput(
        ticker=ticker,
        as_of="2026-08-31",
        holdings=tuple(rows),
        series_lei=series_lei,
        name=f"{ticker} Fund",
    )


def compose(parent, children) -> fol.Composed:
    funds = {parent.ticker: parent, **{child.ticker: child for child in children}}
    return fol.Composer(funds, fol.EdgeIndex.build(funds, None)).compose(parent.ticker)


# --- the row ----------------------------------------------------------------


def test_an_unmatched_row_publishes_the_filings_country():
    row = artifact.holding_row(
        company_id=None,
        name="Some Bond",
        ticker=None,
        asset_cat=classify.DEBT,
        weight_bp=1_234,
        filed_country="JP",
    )
    assert row["filed_country"] == "JP"


def test_a_matched_row_never_carries_a_second_country():
    # The company map is the answer for a row that named a company; a second, weaker
    # country beside it is exactly the drift the field must not introduce.
    row = artifact.holding_row(
        company_id="c_0000320193",
        name="Apple Inc",
        ticker="AAPL",
        asset_cat=classify.EQUITY,
        weight_bp=5_000,
        filed_country="US",
    )
    assert "filed_country" not in row


def test_a_row_with_no_country_publishes_no_key():
    row = artifact.holding_row(
        company_id=None,
        name="Unnamed",
        ticker=None,
        asset_cat=classify.OTHER,
        weight_bp=1,
    )
    assert "filed_country" not in row


def test_the_key_sits_after_identified_so_both_writers_agree():
    # ``published_row`` inserts ``identified`` after ``weight_bp``; a composed row and a
    # filed row must therefore carry the same keys in the same order, or the two
    # documents would differ in bytes for a reason no reader could see.
    filed = artifact.holding_row(
        company_id=None,
        name="Some Bond",
        ticker=None,
        asset_cat=classify.DEBT,
        weight_bp=1_234,
        filed_country="JP",
    )
    composed = artifact.published_row(
        {
            "company_id": None,
            "name": "Some Bond",
            "ticker": None,
            "asset_cat": classify.DEBT,
            "weight_bp": 1_234,
            "filed_country": "JP",
        }
    )
    assert list(filed) == list(composed)


# --- the flatten ------------------------------------------------------------


def test_a_composed_row_keeps_the_filings_country():
    parent = fund(
        [holding("Alpha ETF", 10_000, asset_cat=classify.FUND, lei="AAA")],
        ticker="PARENT",
        series_lei="PARENT-LEI",
    )
    alpha = fund(
        [
            holding("Mapped Corp", 6_000, company_id="c_1", country="US"),
            holding("Unmapped Bond", 4_000, asset_cat=classify.DEBT, country="JP"),
        ],
        ticker="ALPHA",
        series_lei="AAA",
    )
    composed = compose(parent, [alpha])
    rows = {row["name"]: row for row in composed.holdings}

    assert rows["Unmapped Bond"]["filed_country"] == "JP"
    # The matched row keeps the company id and no country: the map decides that one.
    assert "filed_country" not in rows["Mapped Corp"]


def test_a_sleeve_that_could_not_be_opened_keeps_its_own_domicile():
    # A fund position is not a market exposure, but it is otherwise unplaceable, and
    # the bar states that a sleeve it could not open is placed by its own domicile.
    parent = fund(
        [holding("Unknown ETF", 10_000, asset_cat=classify.FUND, country="IE")],
        ticker="PARENT",
    )
    composed = compose(parent, [])
    row = composed.holdings[0]
    assert row["asset_cat"] == classify.FUND
    assert row["filed_country"] == "IE"
