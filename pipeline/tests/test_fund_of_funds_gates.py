"""The gates that guard a flattened fund, tested by seeding the errors they must catch.

A validator test that only feeds it a valid document proves nothing (lookthrough-math-
and-qa §8). Each case below breaks exactly one invariant of the composition and asserts
the *named* check fires — so a gate that silently stops working fails here rather than
in a release where a composed weight is indistinguishable from a filed one.
"""

from __future__ import annotations

import copy

import pytest

from pipeline import artifact
from pipeline.fund_lookthrough import MAX_DEPTH, MIN_UNRESOLVED_WARNING_BP
from pipeline.validate import Report, _check_fund_of_funds, _check_fund_of_funds_release


def document(**overrides) -> dict:
    """A flattened fund whose every number agrees with every other number."""
    base = {
        "ticker": "PARENT",
        "coverage_pct": 60.0,
        "holdings": [
            {"company_id": "c_1", "name": "Mapped Corp", "ticker": "MAPPED",
             "asset_cat": "equity", "weight_bp": 6_000},
            {"company_id": None, "name": "Residual Fund", "ticker": None,
             "asset_cat": "fund", "weight_bp": 4_000},
        ],
        "metrics": {"hhi": 0.36, "hhi_pct2": 3_600.0, "effective_n": 2.7778,
                    "top10_pct": 60.0},
        "components": [
            {"ticker": "CHILD", "name": "Child Fund", "weight_bp": 10_000,
             "coverage_pct": 60.0, "resolved_by": "series_lei"},
        ],
        "lookthrough": {
            "depth": 1,
            "fund_bp": 10_000,
            "resolved_fund_bp": 10_000,
            "unresolved_fund_bp": 4_000,
            "as_of_skew_days": 0,
            "holdings_bp": 10_000,
            "refused": {"unresolved": 1},
        },
        "warnings": ["fund_of_funds", "fund_of_funds_unresolved", "partial_coverage"],
    }
    base.update(overrides)
    return base


def failures(doc: dict) -> list[str]:
    """Run the per-fund gate and return the names of the checks that failed."""
    report = Report()
    printed: list[str] = []
    original_fail = report.fail

    def capture(check: str, detail: str = "") -> None:
        printed.append(check)
        original_fail(check, detail)

    report.fail = capture  # type: ignore[method-assign]
    _check_fund_of_funds(doc, report)
    return printed


def test_a_consistent_flattened_fund_passes():
    assert failures(document()) == []


def test_a_document_that_is_not_a_fund_of_funds_is_untouched():
    plain = {"ticker": "PLAIN", "holdings": [], "coverage_pct": 99.0, "warnings": []}
    assert failures(plain) == []


def test_holdings_bp_must_be_the_sum_of_the_published_vector():
    """The provenance describes the vector; if the sum moved, it describes another one."""
    doc = document()
    doc["holdings"][0]["weight_bp"] = 5_000  # Σ now 9,000, holdings_bp still 10,000
    assert "PARENT.lookthrough.holdings_bp" in failures(doc)


def test_coverage_is_recomputed_from_the_vector_not_trusted():
    doc = document(coverage_pct=99.9)  # 6,000 of 10,000 is 60.0
    assert "PARENT.lookthrough.coverage" in failures(doc)


def test_a_flattened_fund_must_carry_the_fund_of_funds_label():
    doc = document(warnings=["partial_coverage", "fund_of_funds_unresolved"])
    assert "PARENT.warnings" in failures(doc)


def test_a_material_residual_must_be_labelled():
    doc = document(warnings=["fund_of_funds", "partial_coverage"])
    assert "PARENT.warnings" in failures(doc)


def test_a_labelled_residual_must_actually_be_material():
    doc = document(
        lookthrough={**document()["lookthrough"],
                     "unresolved_fund_bp": MIN_UNRESOLVED_WARNING_BP - 1},
        holdings=[{"company_id": "c_1", "name": "Mapped Corp", "ticker": "MAPPED",
                   "asset_cat": "equity", "weight_bp": 6_001},
                  {"company_id": None, "name": "Residual Fund", "ticker": None,
                   "asset_cat": "fund", "weight_bp": 3_999}],
        coverage_pct=60.0,
    )
    doc["lookthrough"]["holdings_bp"] = 10_000
    assert "PARENT.warnings" in failures(doc)


def test_depth_beyond_the_cap_fails():
    doc = document()
    doc["lookthrough"]["depth"] = MAX_DEPTH + 1
    assert "PARENT.lookthrough.depth" in failures(doc)


def test_depth_zero_fails_because_a_flatten_used_at_least_one_hop():
    doc = document()
    doc["lookthrough"]["depth"] = 0
    assert "PARENT.lookthrough.depth" in failures(doc)


def test_resolved_weight_cannot_exceed_the_fund_weight():
    doc = document()
    doc["lookthrough"]["resolved_fund_bp"] = 10_001
    assert "PARENT.lookthrough.resolved_fund_bp" in failures(doc)


def test_components_must_be_sorted():
    doc = document()
    doc["components"] = [
        {"ticker": "SMALL", "name": "Small Fund", "weight_bp": 2_000,
         "coverage_pct": 90.0, "resolved_by": "series_lei"},
        {"ticker": "BIG", "name": "Big Fund", "weight_bp": 8_000,
         "coverage_pct": 90.0, "resolved_by": "series_lei"},
    ]
    assert "PARENT.components.order" in failures(doc)


def test_a_duplicate_sleeve_is_a_failure():
    doc = document()
    doc["components"] = [
        {"ticker": "CHILD", "name": "Child Fund", "weight_bp": 5_000,
         "coverage_pct": 90.0, "resolved_by": "series_lei"},
        {"ticker": "CHILD", "name": "Child Fund Again", "weight_bp": 5_000,
         "coverage_pct": 90.0, "resolved_by": "series_lei"},
    ]
    assert "PARENT.components.duplicate" in failures(doc)


def test_a_component_that_claims_resolution_must_name_a_ticker():
    doc = document()
    doc["components"][0]["ticker"] = None
    assert "PARENT.components.resolved_by" in failures(doc)


def test_a_lookthrough_without_components_is_refused():
    doc = document()
    del doc["components"]
    assert "PARENT.components" in failures(doc)


def test_a_release_fails_a_sleeve_it_does_not_publish():
    funds = [document(), {"ticker": "OTHER", "holdings": [], "coverage_pct": 1.0,
                          "warnings": []}]
    report = Report()
    printed: list[str] = []
    report.fail = lambda check, detail="": printed.append(check)  # type: ignore[method-assign]
    _check_fund_of_funds_release(funds, report)
    assert "PARENT.components" in printed, "CHILD is not in the release"


def test_a_release_with_sleeves_and_no_flatten_warns():
    plain = {"ticker": "CHILD", "holdings": [], "coverage_pct": 99.0, "warnings": []}
    sleeves_only = document()
    del sleeves_only["lookthrough"]
    sleeves_only["holdings"] = [{"company_id": None, "name": "Child Fund",
                                 "ticker": None, "asset_cat": "fund", "weight_bp": 10_000}]
    report = Report()
    warned: list[str] = []
    report.warn = lambda check, detail="": warned.append(check)  # type: ignore[method-assign]
    _check_fund_of_funds_release([plain, sleeves_only], report)
    assert "fund_of_funds" in warned


# --- the document builder ---------------------------------------------------


def test_attach_keeps_the_contract_key_order_and_omits_what_is_absent():
    original = {
        "schema_version": 1, "ticker": "T", "fund_id": "S1", "name": "N",
        "issuer": "I", "etf": False, "as_of": "2026-08-31", "filed_at": "2026-10-30",
        "lag_days": 60, "source": "SEC N-PORT", "source_url": "https://www.sec.gov/x",
        "coverage_pct": 0.0, "holdings": [{"company_id": None, "name": "A",
                                          "ticker": None, "asset_cat": "fund",
                                          "weight_bp": 10_000}],
        "metrics": {"hhi": None, "hhi_pct2": None, "effective_n": None, "top10_pct": None},
        "warnings": ["fund_of_funds"],
    }
    plain = artifact.attach_fund_of_funds(
        original,
        holdings=original["holdings"],
        coverage_pct=0.0,
        metrics=original["metrics"],
        components=[{"ticker": "C", "name": "C", "weight_bp": 10_000,
                     "coverage_pct": 99.0, "resolved_by": "series_lei"}],
    )
    assert "lookthrough" not in plain
    assert plain["components"][0]["ticker"] == "C"
    assert list(plain) == [*list(original)[:14], "components", "warnings"]

    flattened = artifact.attach_fund_of_funds(
        original,
        holdings=[{"company_id": "c_1", "name": "X", "ticker": "X",
                   "asset_cat": "equity", "weight_bp": 9_000}],
        coverage_pct=90.0,
        metrics={"hhi": 0.81, "hhi_pct2": 8_100.0, "effective_n": 1.2346,
                 "top10_pct": 90.0},
        components=plain["components"],
        lookthrough={"depth": 1, "fund_bp": 10_000, "resolved_fund_bp": 10_000,
                     "unresolved_fund_bp": 0, "as_of_skew_days": 0,
                     "holdings_bp": 9_000, "refused": {}},
        warnings=["fund_of_funds"],
    )
    assert list(flattened) == [*list(original)[:14], "components", "lookthrough", "warnings"]
    assert flattened["holdings"][0]["weight_bp"] == 9_000
    assert original["coverage_pct"] == 0.0, "the builder must not mutate its input"
