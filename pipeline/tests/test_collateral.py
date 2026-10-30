"""Borrowed cash is not a holding: the securities-lending gross-up rule.

N-PORT reports a lending or repo program twice — collateral received inside the
schedule of investments, and the obligation to return it as a liability. EA
Bridgeway Omni Small-Cap Value (BSVO) is the measured case: $237.6M of collateral
against $245.0M of borrowings, so the schedule reads 9.93% over net assets and
0.3% under total assets. The old gate read that as a truncated filing and refused
a fund that is fine; every weight it published would also have been 10% too small.
"""

from __future__ import annotations

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
