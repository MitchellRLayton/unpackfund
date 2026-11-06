"""Cash a filing reports on top of a book that already is the fund.

Alpha Architect International Quantitative Value (IVAL, 2026-06-30) is the measured case:
50 positions at 2.00% each — 99.34% of net assets — plus $20,297,444 (9.77%) in a
government money-market fund. The schedule reads 109.08% of net assets and 7.77% over the
filing's own total assets, so on the filing's own numbers the cash row cannot be owned.
Removing it reconciles the book to 0.69%, and the weights are then measured against the
investable book so the vector is a whole fund instead of 99% of one.

The rule must not touch the two neighbouring shapes: a fund whose cash is one of its
positions (schedule ≈ net assets) and a leveraged fund whose remainder is still far from
net assets after the cash comes out.
"""

from __future__ import annotations

import pytest

from pipeline import build, weights
from pipeline.nport import Holding, NportFiling


def holding(name, value, *, asset_cat="EC", issuer_cat="CORP") -> Holding:
    return Holding(
        name=name,
        title=None,
        cusip=None,
        isin=None,
        ticker=None,
        lei=None,
        balance=None,
        units=None,
        cur_cd="USD",
        val_usd=value,
        pct_val=None,
        asset_cat=asset_cat,
        issuer_cat=issuer_cat,
        inv_country=None,
        payoff_profile=None,
        is_derivative=False,
    )


def filing(holdings, *, assets, liabilities, net) -> NportFiling:
    return NportFiling(
        accession="0000000000-26-000001",
        submission_type="NPORT-P",
        cik="0000000001",
        registrant_name="Test Trust",
        series_name="Test Fund",
        series_id="S000000001",
        class_ids=[],
        report_date="2026-06-30",
        fiscal_year_end="2026-06-30",
        total_assets=assets,
        total_liabilities=liabilities,
        net_assets=net,
        holdings=holdings,
    )


#: IVAL's filed figures, to the cent.
IVAL_NET = 207_776_692.40
IVAL_ASSETS = 210_306_145.62
IVAL_LIABILITIES = 2_529_453.22
IVAL_EQUITY_TOTAL = 206_346_608.00
IVAL_CASH = 20_297_444.27


def ival() -> NportFiling:
    equities = [
        holding(f"Company {index}", IVAL_EQUITY_TOTAL / 50) for index in range(50)
    ]
    cash = holding(
        "First American Government Obligations Fund",
        IVAL_CASH,
        asset_cat="STIV",
        issuer_cat="PF",
    )
    return filing(
        [*equities, cash],
        assets=IVAL_ASSETS,
        liabilities=IVAL_LIABILITIES,
        net=IVAL_NET,
    )


def test_ival_money_market_row_is_not_a_holding():
    """The measured case: the book alone reconciles, so the sweep is the row that cannot be."""
    result = build.unfunded_cash(ival())
    assert result.usd == pytest.approx(IVAL_CASH)
    assert len(result.rows) == 1


def test_the_remainder_is_the_band_that_authorises_the_removal():
    """Removing the cash has to land inside the same 5% band the gate uses."""
    disclosure = ival()
    excess = build.unfunded_cash(disclosure)
    rows = [row for row in disclosure.holdings if id(row) not in excess.rows]
    assert sum(row.val_usd for row in rows) / IVAL_NET == pytest.approx(1.0, abs=0.009)


def test_a_fund_whose_cash_is_a_position_keeps_every_row():
    """Schedule ≈ net assets: the cash is part of the fund, not on top of it."""
    cash = holding("Cash", 5.0, asset_cat="STIV", issuer_cat="RF")
    result = build.unfunded_cash(
        filing([holding("Apple Inc", 95.0), cash], assets=100.0, liabilities=0.0, net=100.0)
    )
    assert result.rows == frozenset()
    assert result.usd == 0.0


def test_leverage_is_not_an_unfunded_cash_row():
    """The remainder still misses net assets after the cash comes out: publish as filed."""
    cash = holding("Cash", 20.0, asset_cat="STIV", issuer_cat="RF")
    result = build.unfunded_cash(
        filing(
            [holding("Apple Inc", 150.0), cash],
            assets=170.0,
            liabilities=70.0,
            net=100.0,
        )
    )
    assert result.rows == frozenset()


def test_borrowed_collateral_is_left_to_the_lending_rule():
    """A cash row that already explains a liability is not re-read as an excess."""
    cash = holding("Mount Vernon Liquid Assets Portfolio", 30.0, asset_cat="STIV", issuer_cat="PF")
    disclosure = filing(
        [holding("Viasat Inc", 200.0), cash], assets=230.0, liabilities=30.0, net=200.0
    )
    collateral = build.lending_collateral(disclosure)
    assert collateral.usd == 30.0
    assert build.unfunded_cash(disclosure, exclude=collateral.rows).rows == frozenset()


def test_cash_larger_than_the_fund_is_a_leverage_question():
    """A row worth more than NAV is never excused as a filing quirk."""
    cash = holding("Cash", 120.0, asset_cat="STIV", issuer_cat="RF")
    result = build.unfunded_cash(
        filing(
            [holding("Apple Inc", 100.0), cash],
            assets=220.0,
            liabilities=120.0,
            net=100.0,
        )
    )
    assert result.rows == frozenset()


def test_the_vector_over_the_investable_book_is_a_whole_fund(index):
    """IVAL's 50 rows at 2.00% each total 10,000 bp when the book is the denominator."""
    disclosure = ival()
    excess = build.unfunded_cash(disclosure)
    investable = [row for row in disclosure.holdings if id(row) not in excess.rows]
    basis = sum(row.val_usd for row in investable)

    as_filed = weights.build_vector(investable, index, disclosure.net_assets, lag_days=0)
    as_book = weights.build_vector(investable, index, basis, lag_days=0)

    assert as_filed.total_bp == 9_931
    assert as_book.total_bp == 10_000
    assert as_book.holdings and all(row.weight_bp == 200 for row in as_book.holdings)
