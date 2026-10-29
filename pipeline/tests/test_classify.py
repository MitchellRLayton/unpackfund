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
