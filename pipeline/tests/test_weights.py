"""Weights: integer basis points that keep the filed residual and never drift."""

from __future__ import annotations

import pytest

from pipeline import weights
from pipeline.nport import Holding


def _holding(name: str, value: float, **overrides) -> Holding:
    defaults = dict(
        name=name,
        title="COMMON STOCK",
        cusip=None,
        isin=None,
        ticker=None,
        lei=None,
        balance=1.0,
        units="NS",
        cur_cd="USD",
        val_usd=value,
        pct_val=None,
        asset_cat="EC",
        issuer_cat="CORP",
        inv_country="US",
        payoff_profile="Long",
        is_derivative=False,
    )
    defaults.update(overrides)
    return Holding(**defaults)


# --- allocation -------------------------------------------------------------


def test_allocation_sums_to_round_of_exact_total():
    """Three equal thirds cannot be integers; the total still has to be exact."""
    bp = weights.allocate_bp([1 / 3, 1 / 3, 1 / 3])
    assert sum(bp) == 10_000
    assert bp == [3334, 3333, 3333]


def test_allocation_keeps_the_filed_residual():
    """A filing summing to 100.09% of NAV stays at 10,009 bp — never rescaled."""
    assert sum(weights.allocate_bp([0.5, 0.5009])) == 10_009


def test_allocation_is_deterministic_under_ties():
    first = weights.allocate_bp([0.125] * 8)
    second = weights.allocate_bp([0.125] * 8)
    assert first == second
    assert sum(first) == 10_000


def test_allocation_handles_negative_residual():
    bp = weights.allocate_bp([-0.004, 0.5])
    assert sum(bp) == 4_960


# --- vector -----------------------------------------------------------------


def test_vector_totals_the_filing(vector):
    assert vector.total_bp == 10_000


def test_share_classes_merge_to_one_company(vector):
    """Alphabet A and C are two rows and one company; the ledger must say so."""
    alphabet = [row for row in vector.holdings if row.name.startswith("Alphabet")]
    assert len(alphabet) == 1
    merged = alphabet[0]
    assert merged.weight_bp == 2_380
    assert merged.merged_rows == 2
    assert "duplicate_company" in vector.warnings


def test_fund_row_is_labelled_and_kept_separate(vector):
    vw = next(row for row in vector.holdings if row.name.startswith("Vanguard Total"))
    assert vw.asset_cat == "fund"
    assert vw.company_id is None
    assert "fund_of_funds" in vector.warnings


def test_cash_and_derivatives_are_labelled(vector):
    categories = {row.asset_cat for row in vector.holdings}
    assert {"equity", "fund", "cash", "derivative"} <= categories
    assert "cash_or_derivative" in vector.warnings


def test_unmapped_rows_do_not_collapse_into_one(vector):
    unmapped = [row for row in vector.holdings if row.company_id is None]
    assert len(unmapped) >= 2
    assert "unmapped_holding" in vector.warnings


def test_coverage_is_weight_based_not_count_based(vector):
    """5 of 7 rows resolve, but coverage is a share of gross weight, not of rows."""
    assert vector.coverage_pct == pytest.approx(83.7)


def test_short_positions_cannot_push_coverage_above_100(index):
    """A 100% long / 50% short fund is fully attributed, not 200% attributed.

    Net-weight coverage reported 111.2% for AUEIX and 102.6% for ASPCX on the widened
    universe: dividing positive mapped weight by a net total that shorts had reduced.
    Both sides of a short are real exposure, so both sides are counted.
    """
    rows = [
        _holding("Apple Inc", 100.0),
        _holding("Microsoft Corp", 50.0, val_usd=-50.0, payoff_profile="Short"),
    ]
    vector = weights.build_vector(rows, index, 100.0, lag_days=0)
    assert vector.coverage_pct <= 100.0
    assert vector.coverage_pct == pytest.approx(66.7)


def test_empty_filing_is_an_error(index):
    with pytest.raises(weights.WeightError):
        weights.build_vector([], index, 1_000.0, lag_days=0)


def test_rows_without_value_are_dropped_not_zeroed(index):
    rows = [_holding("Apple Inc", 100.0), _holding("Ghost Inc", None, pct_val=None)]
    vector = weights.build_vector(rows, index, 1_000.0, lag_days=0)
    assert [row.name for row in vector.holdings] == ["Apple Inc"]


def test_stale_filing_warning(index):
    rows = [_holding("Apple Inc", 1_000.0)]
    stale = weights.build_vector(rows, index, 1_000.0, lag_days=weights.STALE_LAG_DAYS + 1)
    fresh = weights.build_vector(rows, index, 1_000.0, lag_days=59)
    assert "stale_filing" in stale.warnings
    assert "stale_filing" not in fresh.warnings


# --- metrics ----------------------------------------------------------------


def test_hhi_matches_definition(vector):
    """HHI is Σw² over company weight with NAV as the denominator, from bp alone."""
    company = [
        row.weight_bp / 10_000
        for row in vector.holdings
        if row.company_id and row.asset_cat in weights.METRIC_CATEGORIES and row.weight_bp > 0
    ]
    result = weights.metrics(vector.holdings)
    assert result["hhi"] == pytest.approx(sum(weight**2 for weight in company))
    assert result["hhi_pct2"] == pytest.approx(result["hhi"] * 10_000, abs=1e-4)
    assert result["effective_n"] == pytest.approx(1 / result["hhi"], abs=1e-6)


def test_metrics_ignore_cash_and_derivatives(vector):
    without = [
        row
        for row in vector.holdings
        if row.asset_cat not in {"cash", "derivative"}
    ]
    assert weights.metrics(vector.holdings) == weights.metrics(without)


def test_cash_only_fund_has_null_metrics(index):
    rows = [
        _holding("Vanguard Market Liquidity Fund", 1_000.0, asset_cat="STIV", issuer_cat="RF")
    ]
    vector = weights.build_vector(rows, index, 1_000.0, lag_days=0)
    assert weights.metrics(vector.holdings) == {
        "hhi": None,
        "hhi_pct2": None,
        "effective_n": None,
        "top10_pct": None,
    }


def test_top10_caps_at_available_rows(index):
    rows = [_holding("Apple Inc", 1_000.0), _holding("Alphabet Inc", 1_000.0)]
    result = weights.metrics(weights.build_vector(rows, index, 2_000.0, lag_days=0).holdings)
    assert result["top10_pct"] == pytest.approx(100.0)
