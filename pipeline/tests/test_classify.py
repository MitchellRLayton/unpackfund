"""Classification uses observed codes only; unknown codes become ``other``, not a guess."""

from __future__ import annotations

import pytest

from pipeline.classify import classify


@pytest.mark.parametrize(
    ("asset_cat", "issuer_cat", "is_derivative", "expected"),
    [
        ("EC", "CORP", False, "equity"),
        ("EP", "CORP", False, "equity"),
        ("DBT", "CORP", False, "debt"),
        ("ABS-MBS", "GOVT", False, "debt"),
        ("STIV", "RF", False, "cash"),
        ("DE", None, True, "derivative"),
        ("EC", "RF", False, "fund"),
    ],
)
def test_observed_codes(asset_cat, issuer_cat, is_derivative, expected):
    assert classify(asset_cat, issuer_cat, is_derivative).category == expected


def test_derivative_info_wins_over_asset_cat():
    """A row with a derivativeInfo subtree is a derivative whatever it calls itself."""
    assert classify("EC", "CORP", True).category == "derivative"


def test_unknown_code_is_other_not_guessed():
    result = classify("WARRANT-NEW", "CORP", False)
    assert result.category == "other"
    assert result.is_company_exposure is False


def test_missing_asset_cat_is_other():
    assert classify(None, None, False).category == "other"


def test_only_company_categories_are_exposures():
    assert classify("EC", "CORP", False).is_company_exposure is True
    assert classify("DBT", "CORP", False).is_company_exposure is True
    assert classify("STIV", "RF", False).is_company_exposure is False
    assert classify("DE", None, True).is_company_exposure is False


# --- ADR-0016: identity outranks the filer's label ---------------------------


def test_a_published_series_lei_makes_a_row_a_fund_position():
    """Vanguard's Target Retirement funds file their sleeves as EC/CORP.

    The label says "a corporate equity"; the row's LEI says it is a fund this release
    publishes. Identity wins, or 60 share classes publish 99.5% "coverage" that is
    entirely other funds (VFIFX listed *Vanguard Total Stock Market Index Fund* as its
    largest "company" at 53.69%).
    """
    assert classify("EC", "CORP", False, published_fund=True).category == "fund"
    assert classify("EC", "CORP", False, published_fund=False).category == "equity"


def test_identity_does_not_promote_cash_or_a_derivative():
    """A sweep's LEI can name a money-market series; it is still the fund's cash."""
    assert classify("STIV", "RF", False, published_fund=True).category == "cash"
    assert classify("DE", None, True, published_fund=True).category == "derivative"
    assert classify(None, None, False, published_fund=True).category == "fund"


def test_a_promoted_row_is_a_company_exposure_and_a_fund_position():
    promoted = classify("EC", "CORP", False, published_fund=True)
    assert promoted.is_fund_position is True
    assert promoted.is_company_exposure is True
    assert promoted.is_cash_or_derivative is False
