"""Borrowed cash is not a holding: the securities-lending gross-up rule.

N-PORT reports a lending or repo program twice — collateral received inside the
schedule of investments, and the obligation to return it as a liability. EA
Bridgeway Omni Small-Cap Value (BSVO) is the measured case: $237.6M of collateral
against $245.0M of borrowings, so the schedule reads 9.93% over net assets and
0.3% under total assets. The old gate read that as a truncated filing and refused
a fund that is fine; every weight it published would also have been 10% too small.
"""

from __future__ import annotations

import pytest

from pipeline import build
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


def test_collateral_matched_by_a_liability_is_set_aside():
    """Cash ≈ liabilities and the rest ≈ net assets: one story, so exclude it."""
    equities = [holding("Viasat Inc", 120.0), holding("Victoria's Secret", 80.0)]
    cash = holding("Mount Vernon Liquid Assets Portfolio", 30.0, asset_cat="STIV", issuer_cat="PF")
    result = build.lending_collateral(
        filing([*equities, cash], assets=230.0, liabilities=30.0, net=200.0)
    )
    assert result.usd == 30.0
    assert result.rows == frozenset({id(cash)})


def test_a_real_cash_position_with_unrelated_borrowings_is_kept():
    """Cash that does not match the liability is the fund's money; keep every row."""
    cash = holding("Cash", 30.0, asset_cat="STIV", issuer_cat="RF")
    result = build.lending_collateral(
        filing(
            [holding("Apple Inc", 270.0), cash], assets=300.0, liabilities=100.0, net=200.0
        )
    )
    assert result.rows == frozenset()
    assert result.usd == 0.0


def test_matching_cash_that_does_not_explain_the_gap_is_kept():
    """Coincidence is not evidence: if the rest misses net assets, publish as filed."""
    cash = holding("Cash", 30.0, asset_cat="STIV", issuer_cat="RF")
    result = build.lending_collateral(
        filing(
            [holding("Apple Inc", 150.0), cash], assets=180.0, liabilities=30.0, net=200.0
        )
    )
    assert result.rows == frozenset()


def test_no_liabilities_means_no_collateral():
    cash = holding("Cash", 30.0, asset_cat="STIV", issuer_cat="RF")
    result = build.lending_collateral(
        filing([holding("Apple Inc", 170.0), cash], assets=200.0, liabilities=0.0, net=200.0)
    )
    assert result.rows == frozenset()


def test_collateral_beside_the_funds_own_sweep_is_found():
    """A repo program's collateral is one repo row next to the fund's own liquidity.

    Transamerica's IIBAX/IIBPX file $1.73B of borrowings, a repo row that matches them
    and a sweep of their own. Summing every cash row overshoots the liability, so the
    old "all cash" test saw leverage where the filing shows a lending program — and the
    funds dropped out of the release the moment repo rows were classified as cash.
    """
    equities = [holding("Apple Inc", 1_000.0)]
    repo = holding("Fixed Income Clearing Corp.", 173.0, asset_cat="RA", issuer_cat="CORP")
    sweep = holding("Mount Vernon Liquid Assets Portfolio", 12.0, asset_cat="STIV", issuer_cat="PF")
    result = build.lending_collateral(
        filing([*equities, repo, sweep], assets=1_185.0, liabilities=173.0, net=1_012.0)
    )
    assert result.usd == 173.0
    assert result.rows == frozenset({id(repo)})


def test_collateral_split_across_two_rows_is_found():
    """Two repo tranches against one liability: the complement of the sweep."""
    equities = [holding("Apple Inc", 1_000.0)]
    first = holding("Societe Generale 3.53 8/03/2026", 100.0, asset_cat="RA", issuer_cat="CORP")
    second = holding("HSBC Securities (USA) Inc.", 73.0, asset_cat="RA", issuer_cat="CORP")
    sweep = holding("Cash", 12.0, asset_cat="STIV", issuer_cat="RF")
    result = build.lending_collateral(
        filing([*equities, first, second, sweep], assets=1_185.0, liabilities=173.0, net=1_012.0)
    )
    assert result.usd == 173.0
    assert result.rows == frozenset({id(first), id(second)})


def test_collateral_reinvested_in_a_money_market_fund_is_found():
    """Half the collateral is cash, half is a registered-fund position.

    Dimensional's U.S. Micro Cap (DFSCX, 2026-07-31) files $1.09B of collateral
    payable: $551.4M in cash and $533.9M in the DFA short-term fund, which N-PORT
    reports as a fund position (assetCat EC, issuerCat RF), not as a cash row. The
    cash-only search finds no shape that matches the liability, so the gate read the
    fund as leveraged and refused it. The fund row is the other half of the same
    story, and both bands still have to pass.
    """
    equities = [holding("Apple Inc", 7_775.9)]
    fund = holding("The DFA Investment Trust Company", 533.9, asset_cat="EC", issuer_cat="RF")
    cash = holding("Dimensional Holdings Inc.", 551.4, asset_cat="STIV", issuer_cat="RF")
    sweep = holding("State Street Bank and Trust Company", 82.9, asset_cat="STIV", issuer_cat="RF")
    result = build.lending_collateral(
        filing(
            [*equities, fund, cash, sweep],
            assets=8_948.3,
            liabilities=1_089.3,
            net=7_859.0,
        )
    )
    assert result.usd == pytest.approx(1_085.3)
    assert result.rows == frozenset({id(fund), id(cash)})
    assert result.fund_usd == pytest.approx(533.9)


def test_a_genuine_fund_position_with_unrelated_borrowings_is_kept():
    """A fund-of-funds holds funds as its book; a fund row is not collateral by itself."""
    fund = holding("Vanguard Total World Stock ETF", 30.0, asset_cat="EC", issuer_cat="RF")
    result = build.lending_collateral(
        filing(
            [holding("Apple Inc", 170.0), fund], assets=300.0, liabilities=100.0, net=200.0
        )
    )
    assert result.rows == frozenset()
    assert result.usd == 0.0


def test_a_fund_row_that_matches_the_liability_but_not_the_gap_is_kept():
    """Coincidence is not evidence, for a fund row as much as for cash."""
    fund = holding("Money Market Fund", 30.0, asset_cat="EC", issuer_cat="RF")
    result = build.lending_collateral(
        filing(
            [holding("Apple Inc", 150.0), fund], assets=180.0, liabilities=30.0, net=200.0
        )
    )
    assert result.rows == frozenset()


def test_cash_only_collateral_is_preferred_to_a_fund_shape():
    """The simplest story wins, so a fund that already publishes cannot change its answer.

    Both a cash row and a fund row match the liability here. The cash-only pass runs
    first and returns, which is what keeps the widened search from re-deciding a fund
    the old rule already explained.
    """
    cash = holding("Cash", 30.0, asset_cat="STIV", issuer_cat="RF")
    fund = holding("Money Market Fund", 30.0, asset_cat="EC", issuer_cat="RF")
    result = build.lending_collateral(
        filing(
            [holding("Apple Inc", 170.0), cash, fund],
            assets=230.0,
            liabilities=30.0,
            net=200.0,
        )
    )
    assert result.rows == frozenset({id(cash)})
    assert result.fund_usd == 0.0
